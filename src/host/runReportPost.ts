// The Host comments a finished Run's report on its pull request (run report C2, R8): the comment is posted once and
// edited after, never twice. Runs after the commit that finished the Run and catches everything, so a post never
// touches the Run's outcome. Posts of one Run are chained, and each reads the state when its turn comes, so a second
// finish sees the id the first post recorded.
import type { Lang } from '../core/i18n'
import type { GhRunner } from '../core/github/gh'
import { postsRunReport } from '../core/github/lifecycle'
import { editIssueComment, findReportComment, postPrComment } from '../core/github/prComment'
import { repoOfBinding } from '../core/github/remote'
import type { RunGitHubPatch } from '../core/github/runState'
import type { OrchState } from '../core/orchestration/state'
import { forPullRequest, reportMarkdown, reportSlack, RUN_REPORT_MARKER } from '../core/runReport/render'

/** A failed post or edit is tried once more after this long (R8) */
export const RUN_REPORT_RETRY_MS = 30_000

export interface RunReportPoster {
  /** Fire and forget: queued behind any earlier post of the same Run. Never throws. */
  finished(runId: string): void
  /** Settles when every queued post is done (tests, dispose). */
  idle(): Promise<void>
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

type Outcome = { ok: true; id: number; url: string } | { gone: true } | { ok: false; message: string }

export function createRunReportPoster(a: {
  state(): OrchState
  gh: GhRunner
  accounts(): Promise<readonly { id: string; label: string }[]>
  record(args: { runId: string; patch: RunGitHubPatch }): Promise<{ status: number; body: unknown }>
  /** The Host's Slack wiring (null when it has none): asked once per finish, never retried */
  slack: { postRunReport(text: string): Promise<string> } | null
  /** Folders no path in the comment may show any part of: the home folder and the profile folder (ScrubContext) */
  prefixes: readonly string[]
  lang(): Lang
  log(m: string): void
  retryAfterMs?: number
}): RunReportPoster {
  const retryAfterMs = a.retryAfterMs ?? RUN_REPORT_RETRY_MS
  const chains = new Map<string, Promise<void>>()
  const pending = new Set<Promise<void>>()

  const record = async (runId: string, patch: RunGitHubPatch): Promise<void> => {
    try {
      const r = await a.record({ runId, patch })
      if (r.status !== 200) a.log(`run report: recording the comment of ${runId} answered ${r.status}`)
    } catch (err) {
      a.log(`run report: recording the comment of ${runId} failed: ${String(err)}`)
    }
  }

  const comment = async (runId: string, accounts: () => Promise<readonly { id: string; label: string }[]>): Promise<void> => {
    const s = a.state()
    const run = s.runs.find((r) => r.id === runId)
    const report = run?.report
    if (!run || !report) return
    const job = s.jobs.find((j) => j.id === run.jobId)
    const binding = run.githubState?.binding
    const kept = run.githubState?.reportComment
    if (!job || !postsRunReport(job.github) || !binding || kept?.gone) return
    const repo = repoOfBinding(binding)
    if (!repo) return

    const labels = (await accounts()).map((x) => x.label)
    const secrets = [...labels, ...labels.flatMap((l) => l.match(EMAIL) ?? [])]
    const roots = [job.cwd, run.worktree].filter((p): p is string => typeof p === 'string' && p !== '')
    const body = reportMarkdown(forPullRequest(report, { roots, prefixes: [...a.prefixes], secrets }), a.lang(), { audience: 'pull-request' })

    // With no id kept, the PR's comments are searched for the marker before every post: a post that landed but was
    // never recorded (a timeout, a Host that left, a failed record) is found, not doubled (C2). A failed search is a
    // failed attempt, never a blind post.
    const attempt = async (): Promise<Outcome> => {
      if (kept?.id !== undefined) {
        const r = await editIssueComment(a.gh, job.cwd, repo, kept.id, body)
        if (r.ok) return { ok: true, id: kept.id, url: kept.url ?? binding.url }
        return r.kind === 'not-found' ? { gone: true } : { ok: false, message: r.message }
      }
      const f = await findReportComment(a.gh, job.cwd, repo, binding.number, RUN_REPORT_MARKER(runId))
      if (!f.ok) return { ok: false, message: f.message }
      if (f.found) return { ok: true, ...f.found }
      const r = await postPrComment(a.gh, job.cwd, repo, binding.number, body)
      return r.ok ? { ok: true, id: r.id, url: r.url } : { ok: false, message: r.message }
    }

    let out = await attempt()
    if ('ok' in out && !out.ok) {
      a.log(`run report: the comment of ${runId} failed (${out.message}), trying once more`)
      if (retryAfterMs > 0) await new Promise((res) => setTimeout(res, retryAfterMs))
      out = await attempt()
    }
    if ('gone' in out) {
      a.log(`run report: the comment of ${runId} was deleted on GitHub, so it is not posted again`)
      await record(runId, { reportComment: { gone: true } })
    } else if (out.ok) {
      await record(runId, { reportComment: { posted: { id: out.id, url: out.url } } })
    } else {
      a.log(`run report: the comment of ${runId} could not be posted: ${out.message}`)
      await record(runId, { reportComment: { failed: out.message } })
    }
  }

  /** The channel post: for every finished Run with a report, whatever the PR side is (no PR, switch off, a gh failure).
   *  Once per finish and never retried; its answer is logged when it is not `posted`. Account labels are shown here
   *  (D2 hides them only from the pull request). */
  const slackPost = async (runId: string, accounts: () => Promise<readonly { id: string; label: string }[]>): Promise<void> => {
    if (!a.slack) return
    const report = a.state().runs.find((r) => r.id === runId)?.report
    if (!report) return
    try {
      const names = new Map((await accounts()).map((x) => [x.id, x.label] as const))
      const answer = await a.slack.postRunReport(reportSlack(report, a.lang(), { accounts: names }))
      if (answer !== 'posted') a.log(`run report: the Slack post of ${runId} answered ${answer}`)
    } catch (err) {
      a.log(`run report: the Slack post of ${runId} failed: ${String(err)}`)
    }
  }

  return {
    finished(runId) {
      const prev = chains.get(runId) ?? Promise.resolve()
      const next: Promise<void> = prev
        .then(async () => {
          // One accounts read per finish, shared by both sides; a failed read is logged once and leaves no labels
          let read: Promise<readonly { id: string; label: string }[]> | null = null
          const accounts = (): Promise<readonly { id: string; label: string }[]> =>
            (read ??= a.accounts().catch((err) => {
              a.log(`run report: the accounts could not be read, so none is scrubbed by label: ${String(err)}`)
              return []
            }))
          await slackPost(runId, accounts)
          await comment(runId, accounts)
        })
        .catch((err) => a.log(`run report: posting the report of ${runId} failed: ${String(err)}`))
        .finally(() => {
          pending.delete(next)
          if (chains.get(runId) === next) chains.delete(runId)
        })
      chains.set(runId, next)
      pending.add(next)
    },
    async idle() {
      while (pending.size > 0) await Promise.all([...pending])
    }
  }
}
