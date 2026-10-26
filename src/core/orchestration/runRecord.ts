// Which Runs stopped running between two orchestration states, and the record each one gets.
//
// **A transition, not a state.** `outcomeOf` is derived — it recomputes from the tasks every time it
// is asked (see its comment in view.ts) — so "this Run is finished" is true on every round after the
// last task lands. Recording on the state would write the same record forever; recording on the edge
// writes it once.
import { outcomeOf, outcomeOfTasks, withoutSupersededLifecycle } from './running'
import { jobOf, type OrchState } from './state'
import type { CheckResult, Job, JobRun, Task } from './types'
import { runRootOf } from './integrate'
import { isSamePath } from '../files/tree'
import type { RunRecordInput } from '../understanding/pipeline'
import type { EvidenceStatus, RecordGitHub } from '../understanding/types'
import { jobNameOf } from './jobName'
import { isLifecycleTask } from './lifecycleTask'
import { checkConfigIdsOf } from './convergence'
import { GITHUB_CI_CHECK } from '../github/lifecycle'
import { mergeReadyHolds } from '../github/view'

export function justFinished(
  before: OrchState,
  after: OrchState
): { runId: string; outcome: 'completed' | 'failed' }[] {
  const out: { runId: string; outcome: 'completed' | 'failed' }[] = []
  // Each state's Tasks grouped by owner once (second pass C2-3): `outcomeOf` per Run walked every Task, twice a Run, on
  // every commit. The same owners `tasksOwnedBy` reads: the Run's id, or the Job's.
  const afterTasks = tasksByOwner(after)
  const beforeTasks = tasksByOwner(before)
  for (const run of after.runs) {
    const now = outcomeOfTasks(afterTasks.get(run.id) ?? [])
    if (now === 'running') continue
    if (outcomeOfTasks(beforeTasks.get(run.id) ?? []) !== 'running') continue
    out.push({ runId: run.id, outcome: now })
  }
  return out
}

/**
 * `next` with each Run's `endedAt` kept true (observe deferred minor b): stamped `now` on the Run whose outcome became
 * final on this commit (`justFinished`'s edge), kept from `prev` while it stays final, whatever the writer sent (an app
 * mirror that has not heard of it yet writes the Run without it), and dropped once it runs again. A Run this commit did
 * not see finish (new to it, or finished before ends were kept) keeps what it came with. The same state back when no
 * end moved. The Host runs every commit through this, a command's and an accepted `state-put` alike (host/orch.ts).
 */
export function stampRunEnds(prev: OrchState, next: OrchState, now: string): OrchState {
  const nextTasks = tasksByOwner(next)
  const prevTasks = tasksByOwner(prev)
  const prevRuns = new Map(prev.runs.map((r) => [r.id, r]))
  let changed = false
  const runs = next.runs.map((run) => {
    const before = prevRuns.get(run.id)
    let endedAt: string | undefined = run.endedAt
    if (outcomeOfTasks(nextTasks.get(run.id) ?? []) === 'running') endedAt = undefined
    else if (before !== undefined) {
      if (outcomeOfTasks(prevTasks.get(run.id) ?? []) === 'running') endedAt = now
      else if (before.endedAt !== undefined) endedAt = before.endedAt
    }
    if (endedAt === run.endedAt) return run
    changed = true
    const { endedAt: _was, ...rest } = run
    return endedAt === undefined ? rest : { ...rest, endedAt }
  })
  return changed ? { ...next, runs } : next
}

/** `tasksOwnedBy` for every owner at once: a Task under its Run's id and, when different, its Job's. */
function tasksByOwner(state: OrchState): Map<string, Task[]> {
  const by = new Map<string, Task[]>()
  const add = (k: string | undefined, t: Task): void => {
    if (k === undefined) return
    const l = by.get(k)
    if (l) l.push(t)
    else by.set(k, [t])
  }
  for (const t of state.tasks) {
    add(t.runId, t)
    if (t.jobId !== t.runId) add(t.jobId, t)
  }
  return by
}

/**
 * The How It Works record of a finished Run, keyed by its Job's cwd (unfolded: each writer folds a
 * worktree onto its repository over its own registry). **One builder for both writers**, the app's
 * commit hook and the Host's commits (E1 §3), so a record reads the same whoever made it. Null when the
 * Run or its Job is gone. The validation follows `outcomeOf`, which for a Run `justFinished` named is the
 * outcome it named.
 */
export function runRecordInputOf(state: OrchState, runId: string): (RunRecordInput & { projectPath: string }) | null {
  const run = state.runs.find((r) => r.id === runId)
  if (!run) return null
  const job = jobOf(state, run)
  if (!job) return null
  // A lifecycle Task `runs reconverge` superseded is not part of the Run's work any more (G5c final review M10)
  const tasks = [...withoutSupersededLifecycle(state.tasks.filter((t) => t.runId === runId))]
  // Where the Run's changes are until someone merges them (RunRecordInput.workDir): workFolderOf.
  const root = workFolderOf(state, run, job, tasks)
  return {
    projectPath: job.cwd,
    runId,
    // Named as its card names it (plugin 4d review M2); the request stays the objective, the write-up's material
    jobName: jobNameOf(job).slice(0, 60),
    objective: job.objective,
    at: new Date().toISOString(),
    taskIds: tasks.map((t) => t.id),
    tasks: tasks.map((t) => ({ title: t.title, outcome: t.status })),
    changedFiles: [...new Set(tasks.flatMap((t) => t.filesModified ?? []))],
    validation: { status: outcomeOf(state, runId) === 'completed' ? 'passed' : 'failed' },
    ...(root !== '' && !isSamePath(root, job.cwd) ? { workDir: root } : {}),
    ...(job.github ? { github: githubEvidenceOf(run, job, tasks) } : {})
  }
}

const FAILED_CHECK: ReadonlySet<CheckResult['status']> = new Set(['failed', 'timed-out', 'error'])

/** A GitHub lifecycle Run's evidence (G8, spec §40), read from the Run's state as it finished; nothing waits on GitHub.
 *  The local checks are the latest lifecycle Task's last round, or, before it was added, its ordinary Tasks' own; CI is
 *  GitHub's on the head Astera pushed; the review passed only when it completed that Task — a person's completion past
 *  the policy is not one. Merge-ready is the Run's GitHub block's own reading (mergeReadyHolds: a withdrawal keeps the
 *  evidence), and only for a lifecycle Task that completed: evidence an earlier carry left says nothing of this one. */
function githubEvidenceOf(run: JobRun, job: Job, tasks: Task[]): RecordGitHub {
  const gs = run.githubState
  const life = tasks.find(isLifecycleTask)
  const configured = (life ? checkConfigIdsOf(life) : tasks.flatMap((t) => checkConfigIdsOf(t))).filter((id) => id !== GITHUB_CI_CHECK)
  const local = (): EvidenceStatus => {
    const results = (life ? (life.checks ?? []) : tasks.flatMap((t) => t.checks ?? [])).filter((c) => c.configId !== GITHUB_CI_CHECK)
    if (results.some((c) => FAILED_CHECK.has(c.status))) return 'failed'
    const passed = (id: string): boolean => results.some((c) => c.configId === id && c.status === 'passed' && c.skipped !== true)
    return configured.every(passed) ? 'passed' : 'skipped'
  }
  const head = gs?.lastPushedSha
  const ci = (): RecordGitHub['ci'] => {
    if (head === undefined) return { status: 'skipped' }
    const onHead = gs?.ci?.sha === head ? gs.ci.verdict : undefined
    if (onHead === 'passed' || onHead === 'failed') return { status: onHead, sha: head }
    if (gs?.ciOverride?.sha === head) return { status: 'skipped', sha: head, noCi: true }
    return { status: 'skipped' }
  }
  const review: EvidenceStatus =
    life?.status === 'completed' && life.completionOverride === undefined
      ? 'passed'
      : life?.status !== 'completed' && (life?.reviewIssues ?? []).some((i) => i.blocking)
        ? 'failed'
        : 'skipped'
  return {
    ...(job.source ? { source: { label: job.source.label, ...(job.source.url !== undefined ? { url: job.source.url } : {}) } } : {}),
    ...(gs?.binding ? { pr: { number: gs.binding.number, url: gs.binding.url } } : {}),
    ...(configured.length > 0 ? { local: local() } : {}),
    ci: ci(),
    review,
    mergeReady: life?.status === 'completed' && mergeReadyHolds(gs)
  }
}

/** The folder a finished Run's work is in. Usually its run root (runRootOf: the Run worktree, or the
 *  project folder). **A parallel Run can leave that root empty**: its tasks ran in Task worktrees and,
 *  with no join point, no integration task ever folded them back (integrate.ts's runWorktrees, and
 *  command.ts's run-merge, which merges those folders for the same reason). So: if every finished
 *  dispatch of the Run shares one cwd that is not the run root, that folder; otherwise the run root.
 *  An open dispatch does not count — it has not finished its work. */
function workFolderOf(state: OrchState, run: JobRun, job: Job, tasks: Task[]): string {
  const root = runRootOf(run, job)
  const taskIds = new Set(tasks.map((t) => t.id))
  const cwds = state.dispatches.filter((d) => taskIds.has(d.taskId) && d.endedAt !== undefined).map((d) => d.cwd)
  if (cwds.length === 0) return root
  const only = cwds[0]
  if (!cwds.every((c) => isSamePath(c, only)) || isSamePath(only, root)) return root
  return only
}
