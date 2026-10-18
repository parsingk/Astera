// The Host carries a lifecycle round handed over at `github:ci` to GitHub (GitHub lifecycle G3b1, design §4.1-4.3):
// the Run branch clean and ahead of its base, pushed to origin (never forced), bound to its one open pull request or to
// a draft one Astera opens, and the wait recorded on the round (`lifecycle-ci-wait`), after which the watch reads CI
// on that head. Driven by state like the watch: a round whose wait has no pushed head yet is taken once at a time, and a
// restart takes it again from the state (a push of the same head changes nothing; the pull request is looked up first,
// L16). Where it must stop it asks a person (a plain Gate, whose answer starts the round again; G3b2 sharpens them).
import { fillFromCommits, type CommitSummary } from '../core/github/fill'
import type { GhFailed } from '../core/github/gh'
import { GITHUB_CI_CHECK, type GitHubBinding } from '../core/github/lifecycle'
import { refsLine, type PushFailure } from '../core/github/lifecyclePush'
import type { OpenPr } from '../core/github/prBinding'
import { parseGitHubRemote, repoSlug, type GitHubRepo } from '../core/github/remote'
import type { RunGitHubPatch } from '../core/github/runState'
import { isLifecycleTask } from '../core/orchestration/lifecycleTask'
import type { OrchState } from '../core/orchestration/state'
import type { CheckResult, Task } from '../core/orchestration/types'
import type { WatchedWorktree } from './githubWatch'

type Reply = { status: number; body: unknown }

export interface LifecycleCiDeps {
  worktreeOf(path: string): WatchedWorktree | null
  originOf(cwd: string): Promise<string | null>
  isClean(cwd: string): Promise<{ clean: boolean; changedCount: number }>
  /** The commits past `base`, newest first. */
  readCommits(cwd: string, base: string): Promise<CommitSummary[]>
  /** The base as gh names it (normalizeBaseForGh). */
  baseBranch(repoPath: string, baseRef: string): Promise<string>
  push(cwd: string, branch: string): Promise<{ ok: true } | PushFailure>
  headOf(cwd: string): Promise<string | null>
  findOpenPrs(cwd: string, repo: GitHubRepo, branch: string, base: string): Promise<{ ok: true; prs: OpenPr[] } | GhFailed>
  createDraftPr(
    cwd: string,
    repo: GitHubRepo,
    pr: { base: string; head: string; title: string; body: string }
  ): Promise<{ ok: true; number: number; url: string; existed?: true } | GhFailed>
  /** `runs-github-record`. */
  record(args: { runId: string; patch: RunGitHubPatch }): Promise<Reply>
  /** `lifecycle-ci-wait`. */
  recordWait(args: { taskId: string; pr: number; sha: string }): Promise<Reply>
  /** TaskValidation.settleHandedOff: a precondition that failed is the round's failed `github:ci` check. */
  settle(a: { taskId: string; result: CheckResult }): Promise<void>
  /** `gate-create`. */
  openGate(a: { taskId: string; question: string }): Promise<Reply>
  log(m: string): void
  now?(): number
}

export interface LifecycleCi {
  onState(s: OrchState): void
  /** Resolves when no round is being carried: for tests and the Host's leaving. */
  drain(): Promise<void>
}

const PUSH_WORDS: Record<PushFailure['kind'], string> = {
  rejected: '원격 브랜치에 Astera 가 모르는 커밋이 있습니다',
  auth: 'GitHub 이 이 계정의 push 를 받지 않았습니다',
  network: 'GitHub 에 닿지 못했습니다',
  other: 'push 가 실패했습니다'
}

/** A round handed over whose wait has no pushed head yet. */
const awaitingPush = (t: Task): boolean => isLifecycleTask(t) && t.status === 'validating' && t.ciWait !== undefined && t.ciWait.sha === undefined

export function createLifecycleCi(d: LifecycleCiDeps): LifecycleCi {
  const now = (): number => (d.now ? d.now() : Date.now())
  const inFlight = new Map<string, Promise<void>>()

  const carry = async (s: OrchState, task: Task): Promise<void> => {
    const ask = async (question: string): Promise<void> => {
      const r = await d.openGate({ taskId: task.id, question })
      if (r.status >= 400) d.log(`lifecycle ci: task ${task.id}: the Gate could not be opened: ${JSON.stringify(r.body)} — ${question}`)
    }
    const fail = (summary: string): Promise<void> =>
      d.settle({
        taskId: task.id,
        result: { configId: GITHUB_CI_CHECK, name: 'GitHub CI', status: 'failed', summary, startedAt: task.ciWait!.since, endedAt: new Date(now()).toISOString() }
      })
    const run = s.runs.find((r) => r.id === task.runId)
    const job = run && s.jobs.find((j) => j.id === run.jobId)
    const cwd = run?.worktree
    const info = cwd === undefined ? null : d.worktreeOf(cwd)
    if (!run || !job || cwd === undefined || !info) return ask('이 Run 의 브랜치를 찾을 수 없어 GitHub 으로 가져갈 수 없습니다. 고친 뒤 답하면 다시 시도합니다.')
    const origin = await d.originOf(cwd)
    const repo = origin === null ? null : parseGitHubRemote(origin)
    if (!repo) return ask('이 Run 의 폴더에 GitHub origin 이 없어 push 할 곳이 없습니다. 고친 뒤 답하면 다시 시도합니다.')

    // §4.1: committing is the worker's obligation, so an uncommitted change is a failed check routed to repair
    const clean = await d.isClean(cwd)
    if (!clean.clean)
      return fail(`The Run's branch has ${clean.changedCount} uncommitted change${clean.changedCount === 1 ? '' : 's'}; Astera pushes commits only. Commit them.`)
    const commits = await d.readCommits(cwd, info.baseRef)
    if (commits.length === 0) return fail(`The Run's branch adds no commits past ${info.baseRef}.`)
    const base = await d.baseBranch(info.repoPath, info.baseRef)

    // §4.2: never forced; a refusal because the branch moved is G3b2's external-head Gate
    const pushed = await d.push(cwd, info.branch)
    if (!pushed.ok) return ask(`GitHub 으로 push 하지 못했습니다. ${PUSH_WORDS[pushed.kind]}: ${pushed.detail}. 고친 뒤 답하면 다시 시도합니다.`)
    const sha = await d.headOf(cwd)
    if (sha === null) return ask('push 한 커밋을 읽지 못했습니다(git rev-parse HEAD). 고친 뒤 답하면 다시 시도합니다.')

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
      if (!found.ok) return ask(`이 Run 의 pull request 를 찾지 못했습니다: ${found.message}. 답하면 다시 시도합니다.`)
      if (found.prs.length > 1)
        return ask(`이 Run 의 브랜치에 열린 pull request 가 여럿입니다(${found.prs.map((p) => `#${p.number}`).join(', ')}). 하나만 남기고 닫은 뒤 답하면 다시 시도합니다.`)
      if (found.prs.length === 1) made = bind(found.prs[0], false)
      else {
        const filled = fillFromCommits(info.branch, commits)
        const refs = refsLine(job.source, repo)
        const body = refs === null ? filled.body : filled.body === '' ? refs : `${filled.body}\n\n${refs}`
        const created = await d.createDraftPr(cwd, repo, { base, head: info.branch, title: filled.title, body })
        if (created.ok) made = bind(created, created.existed !== true)
        else {
          // A create that failed may still have made it (a timeout): look before asking (L16)
          const again = await d.findOpenPrs(cwd, repo, info.branch, base)
          if (!again.ok || again.prs.length !== 1)
            return ask(`draft pull request 를 열지 못했습니다: ${created.message}. 답하면 다시 시도합니다.`)
          made = bind(again.prs[0], false)
        }
      }
      binding = made
    }

    const recorded = await d.record({ runId: run.id, patch: { ...(made ? { binding: made } : {}), pushed: { sha } } })
    if (recorded.status >= 300) d.log(`lifecycle ci: run ${run.id}: the push could not be recorded: ${JSON.stringify(recorded.body)}`)
    const waited = await d.recordWait({ taskId: task.id, pr: binding.number, sha })
    if (waited.status >= 300) d.log(`lifecycle ci: task ${task.id}: the wait could not be recorded: ${JSON.stringify(waited.body)}`)
  }

  return {
    onState: (s) => {
      for (const task of s.tasks) {
        if (!awaitingPush(task) || inFlight.has(task.id)) continue
        // A step that throws asks a person: left alone, every state would take the round again at once
        const p = carry(s, task)
          .catch(async (e) => {
            d.log(`lifecycle ci: task ${task.id}: ${String(e)}`)
            const r = await d.openGate({ taskId: task.id, question: `GitHub 으로 가져가는 중 오류가 났습니다: ${String(e)}. 고친 뒤 답하면 다시 시도합니다.` })
            if (r.status >= 400) d.log(`lifecycle ci: task ${task.id}: the Gate could not be opened: ${JSON.stringify(r.body)}`)
          })
          .catch((e) => d.log(`lifecycle ci: task ${task.id}: ${String(e)}`))
          .finally(() => inFlight.delete(task.id))
        inFlight.set(task.id, p)
      }
    },
    drain: async () => {
      while (inFlight.size > 0) await Promise.all([...inFlight.values()])
    }
  }
}
