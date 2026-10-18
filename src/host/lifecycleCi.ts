// The Host carries a lifecycle round handed over at `github:ci` to GitHub (GitHub lifecycle G3b1, design §4.1-4.3):
// the Run branch clean and ahead of its base, pushed to origin (never forced), bound to its one open pull request or to
// a draft one Astera opens, and the wait recorded on the round (`lifecycle-ci-wait`), after which the watch reads CI
// on that head. Driven by state like the watch: a round whose wait has no pushed head yet is taken once at a time, and a
// restart takes it again from the state (a push of the same head changes nothing; the pull request is looked up first,
// L16). Where it must stop it asks a person: a GitHub question that keeps the round's wait where its answer acts on
// the round (a refused push, several pull requests; G3b2), else a plain Gate whose answer starts the round again. Every
// question is in the person's language.
import { fillFromCommits, type CommitSummary } from '../core/github/fill'
import type { GhFailed } from '../core/github/gh'
import { GITHUB_CI_CHECK, type GitHubBinding } from '../core/github/lifecycle'
import { refsLine, type PushFailure } from '../core/github/lifecyclePush'
import type { OpenPr } from '../core/github/prBinding'
import { parseGitHubRemote, repoSlug, type GitHubRepo } from '../core/github/remote'
import type { RunGitHubPatch } from '../core/github/runState'
import { isLifecycleTask } from '../core/orchestration/lifecycleTask'
import type { OrchState } from '../core/orchestration/state'
import type { CheckResult, GitHubGateKind, Task } from '../core/orchestration/types'
import { t as translate, type Lang, type MessageKey, type MessageParams } from '../core/i18n'
import type { WatchedWorktree } from './githubWatch'

type Reply = { status: number; body: unknown }

export interface LifecycleCiDeps {
  worktreeOf(path: string): WatchedWorktree | null
  originOf(cwd: string): Promise<string | null>
  isClean(cwd: string): Promise<{ clean: boolean; changedCount: number }>
  /** The commits past `base`, newest first; null when git could not read them. */
  readCommits(cwd: string, base: string): Promise<CommitSummary[] | null>
  /** The base as gh names it (normalizeBaseForGh). */
  baseBranch(repoPath: string, baseRef: string): Promise<string>
  push(cwd: string, branch: string): Promise<{ ok: true } | PushFailure>
  /** The commit HEAD names, or `ref` when given; null when git cannot say. */
  headOf(cwd: string, ref?: string): Promise<string | null>
  findOpenPrs(cwd: string, repo: GitHubRepo, branch: string, base: string): Promise<{ ok: true; prs: OpenPr[] } | GhFailed>
  createDraftPr(
    cwd: string,
    repo: GitHubRepo,
    pr: { base: string; head: string; title: string; body: string }
  ): Promise<{ ok: true; number: number; url: string; existed?: true } | GhFailed>
  /** `runs-github-record`. */
  record(args: { runId: string; patch: RunGitHubPatch }): Promise<Reply>
  /** `lifecycle-ci-wait`: for the round `since` names. */
  recordWait(args: { taskId: string; since: string; pr: number; sha: string }): Promise<Reply>
  /** TaskValidation.settleHandedOff: a precondition that failed is the round's failed `github:ci` check. */
  settle(a: { taskId: string; result: CheckResult; since?: string }): Promise<void>
  /** `gate-create`: a plain Gate, whose answer starts the round again. */
  openGate(a: { taskId: string; question: string }): Promise<Reply>
  /** `lifecycle-gate` (G3b2): a GitHub question about the round `since` names, which keeps the round's wait. */
  openGitHubGate?(a: { taskId: string; since: string; kind: GitHubGateKind; question: string; options: string[] }): Promise<Reply>
  /** The person's language, for the questions (G3b2). */
  lang?(): Lang
  log(m: string): void
  now?(): number
}

export interface LifecycleCi {
  onState(s: OrchState): void
  /** Resolves when no round is being carried (tests). */
  drain(): Promise<void>
}

/** A round a carry left where it was (a Gate that could not open, a record that failed) is taken again after this,
 *  not on every state (G3b1 final review M7). */
export const RETRY_MS = 60_000

/** Why a push failed, in words; a refused one (`rejected`) is a GitHub question of its own (G3b2). */
const PUSH_WORDS: Record<Exclude<PushFailure['kind'], 'rejected'>, MessageKey> = {
  auth: 'jobs.gate.github.push.auth',
  network: 'jobs.gate.github.push.network',
  other: 'jobs.gate.github.push.other'
}

/** The wait a carry took up: its round, and a person's choice of pull request (G3b2), which is news to take up at once. */
const waitKey = (t: Task): string => `${t.ciWait!.since}#${t.ciWait!.bindPr ?? ''}`

/** A round handed over whose wait has no pushed head yet. */
const awaitingPush = (t: Task): boolean => isLifecycleTask(t) && t.status === 'validating' && t.ciWait !== undefined && t.ciWait.sha === undefined

export function createLifecycleCi(d: LifecycleCiDeps): LifecycleCi {
  const now = (): number => (d.now ? d.now() : Date.now())
  const say = (key: MessageKey, params?: MessageParams): string => translate(d.lang?.() ?? 'en', key, params)
  const inFlight = new Map<string, Promise<void>>()
  /** Each round last carried (`taskId` → the wait it carried, `waitKey`) and when it may be taken again. */
  const cooling = new Map<string, { wait: string; until: number }>()

  const carry = async (s: OrchState, task: Task): Promise<void> => {
    const ask = async (question: string): Promise<void> => {
      const r = await d.openGate({ taskId: task.id, question })
      if (r.status >= 400) d.log(`lifecycle ci: task ${task.id}: the Gate could not be opened: ${JSON.stringify(r.body)} — ${question}`)
    }
    const since = task.ciWait!.since
    const askGitHub = async (kind: GitHubGateKind, question: string, options: string[]): Promise<void> => {
      const r = d.openGitHubGate ? await d.openGitHubGate({ taskId: task.id, since, kind, question, options }) : { status: 501, body: 'no GitHub questions here' }
      if (r.status >= 400) d.log(`lifecycle ci: task ${task.id}: the ${kind} question could not be opened: ${JSON.stringify(r.body)} — ${question}`)
    }
    const fail = (summary: string): Promise<void> =>
      d.settle({
        taskId: task.id,
        since,
        result: { configId: GITHUB_CI_CHECK, name: 'GitHub CI', status: 'failed', summary, startedAt: since, endedAt: new Date(now()).toISOString() }
      })
    const run = s.runs.find((r) => r.id === task.runId)
    const job = run && s.jobs.find((j) => j.id === run.jobId)
    const cwd = run?.worktree
    const info = cwd === undefined ? null : d.worktreeOf(cwd)
    if (!run || !job || cwd === undefined || !info) return ask(say('jobs.gate.github.carry.noBranch'))
    const origin = await d.originOf(cwd)
    const repo = origin === null ? null : parseGitHubRemote(origin)
    if (!repo) return ask(say('jobs.gate.github.carry.noOrigin'))

    // §4.1: committing is the worker's obligation, so an uncommitted change is a failed check routed to repair
    const clean = await d.isClean(cwd)
    if (!clean.clean)
      return fail(`The Run's branch has ${clean.changedCount} uncommitted change${clean.changedCount === 1 ? '' : 's'}; Astera pushes commits only. Commit them.`)
    const commits = await d.readCommits(cwd, info.baseRef)
    // A read that failed is not a branch with no commits (G3b1 final review M3)
    if (commits === null) return ask(say('jobs.gate.github.carry.commitsUnread', { base: info.baseRef }))
    if (commits.length === 0) return fail(`The Run's branch adds no commits past ${info.baseRef}.`)
    const base = await d.baseBranch(info.repoPath, info.baseRef)

    // §4.2: never forced; a refusal because the branch moved asks whether to bring the commits in. CI is waited on for the
    // commit the push sends, the branch's tip, so HEAD must be that tip and stay it through the push (G3b1 final review
    // I1): otherwise the PR head and the head waited on part, and the round waits for ever
    const sha = await d.headOf(cwd)
    if (sha === null) return ask(say('jobs.gate.github.carry.headUnread'))
    const tip = await d.headOf(cwd, `refs/heads/${info.branch}`)
    if (tip !== sha) return ask(say('jobs.gate.github.carry.headOffTip', { branch: info.branch }))
    const pushed = await d.push(cwd, info.branch)
    if (!pushed.ok) {
      // design §4.2: GitHub has commits on the branch Astera does not know; "continue" brings them in (G3b2)
      if (pushed.kind === 'rejected') {
        const noted = await d.record({ runId: run.id, patch: { externalHead: {} } })
        if (noted.status >= 300) d.log(`lifecycle ci: run ${run.id}: the refused push could not be recorded: ${JSON.stringify(noted.body)}`)
        return askGitHub('github-external-head', say('jobs.gate.github.q.externalHeadPush', { branch: info.branch, detail: pushed.detail }), ['continue', 'mark-failed'])
      }
      return ask(say('jobs.gate.github.carry.pushFailed', { why: say(PUSH_WORDS[pushed.kind]), detail: pushed.detail }))
    }
    if ((await d.headOf(cwd)) !== sha) return ask(say('jobs.gate.github.carry.pushMoved'))

    // §4.3: the binding once made; else the one open pull request; else a draft Astera opens
    let binding = run.githubState?.binding
    let made: GitHubBinding | undefined
    if (!binding) {
      const bind = (pr: OpenPr, createdByAstera: boolean): GitHubBinding => ({
        repository: repoSlug(repo),
        ...(repo.host !== 'github.com' ? { host: repo.host } : {}),
        number: pr.number,
        url: pr.url,
        baseBranch: base,
        headBranch: info.branch,
        createdByAstera,
        boundAt: new Date(now()).toISOString()
      })
      const found = await d.findOpenPrs(cwd, repo, info.branch, base)
      if (!found.ok) return ask(say('jobs.gate.github.carry.lookupFailed', { message: found.message }))
      // design §4.3: several open pull requests → a person chooses, and the answer binds it (G3b2)
      if (found.prs.length > 1) {
        const chosen = found.prs.find((p) => p.number === task.ciWait!.bindPr)
        if (!chosen)
          return askGitHub(
            'github-pr-ambiguous',
            say('jobs.gate.github.q.ambiguous', { branch: info.branch, numbers: found.prs.map((p) => `#${p.number}`).join(', ') }),
            [...found.prs.map((p) => `pr-${p.number}`), 'mark-failed']
          )
        made = bind(chosen, false)
      } else if (found.prs.length === 1) made = bind(found.prs[0], false)
      else {
        const filled = fillFromCommits(info.branch, commits)
        const refs = refsLine(job.source, repo)
        const body = refs === null ? filled.body : filled.body === '' ? refs : `${filled.body}\n\n${refs}`
        // The lookup just above found none, so a PR found now is the one this create made (G3b1 final review M4)
        const created = await d.createDraftPr(cwd, repo, { base, head: info.branch, title: filled.title, body })
        if (created.ok) made = bind(created, true)
        else {
          // A create that failed may still have made it (a timeout): look before asking (L16)
          const again = await d.findOpenPrs(cwd, repo, info.branch, base)
          if (!again.ok || again.prs.length !== 1)
            return ask(say('jobs.gate.github.carry.createFailed', { message: created.message }))
          made = bind(again.prs[0], true)
        }
      }
      binding = made
    }

    // The wait only after the push is recorded: merge-ready reads the pushed head (G3b1 final review M6)
    const recorded = await d.record({ runId: run.id, patch: { ...(made ? { binding: made } : {}), pushed: { sha } } })
    if (recorded.status >= 300) return ask(say('jobs.gate.github.carry.recordFailed', { reason: JSON.stringify(recorded.body) }))
    const waited = await d.recordWait({ taskId: task.id, since, pr: binding.number, sha })
    if (waited.status >= 300) return ask(say('jobs.gate.github.carry.waitFailed', { reason: JSON.stringify(waited.body) }))
  }

  return {
    onState: (s) => {
      for (const task of s.tasks) {
        if (!awaitingPush(task) || inFlight.has(task.id)) continue
        const cool = cooling.get(task.id)
        if (cool && cool.wait === waitKey(task) && now() < cool.until) continue
        // A step that throws asks a person: left alone, every state would take the round again at once
        const p = carry(s, task)
          .catch(async (e) => {
            d.log(`lifecycle ci: task ${task.id}: ${String(e)}`)
            const r = await d.openGate({ taskId: task.id, question: say('jobs.gate.github.carry.threw', { error: String(e) }) })
            if (r.status >= 400) d.log(`lifecycle ci: task ${task.id}: the Gate could not be opened: ${JSON.stringify(r.body)}`)
          })
          .catch((e) => d.log(`lifecycle ci: task ${task.id}: ${String(e)}`))
          .finally(() => {
            inFlight.delete(task.id)
            cooling.set(task.id, { wait: waitKey(task), until: now() + RETRY_MS })
          })
        inFlight.set(task.id, p)
      }
    },
    drain: async () => {
      while (inFlight.size > 0) await Promise.all([...inFlight.values()])
    }
  }
}
