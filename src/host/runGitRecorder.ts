// The git range each Run and each attempt worked over (remote runtime design Phase 10), recorded by the Host as it
// happens: `runs-changed-files` and `runs-diff` read it, and nothing in state could rebuild it once a merge reaps the
// worktree and deletes its branch.
//
// - A Run's base: where its own worktree forked from its base branch (`merge-base`), or the project folder's HEAD once
//   its first attempt starts when it works there directly.
// - An attempt's base: its folder's HEAD when it is first seen; its head: that folder's HEAD when it ends, which also
//   moves its Run's head to the Run root's HEAD.
// - Around a merge: a Run whose worktree is merged gets the head it had before; a Run root merged into gets the head
//   after, so a Run's range covers its Tasks' merged worktrees.
//
// Each read is done once per thing; a failed read is logged and not tried again, and nothing here throws.
import { runRootOf } from '../core/orchestration/integrate'
import { isSamePath } from '../core/files/tree'
import type { OrchState } from '../core/orchestration/state'

export interface RunGitRecorderDeps {
  /** `runs-git-record` as the Host itself. */
  record(args: { runId?: string; dispatchId?: string; base?: string; head?: string }): Promise<unknown>
  headOf(cwd: string): Promise<string | null>
  mergeBase(cwd: string, ref: string): Promise<string | null>
  /** The base branch a registered worktree was forked from, or null. */
  baseRefOf(path: string): string | null
  isDir(path: string): boolean
  log(m: string): void
}

export interface RunGitRecorder {
  onState(s: OrchState): void
  beforeIntegrate(into: string, paths: string[]): Promise<void>
  afterIntegrate(into: string): Promise<void>
}

export function createRunGitRecorder(d: RunGitRecorderDeps): RunGitRecorder {
  /** Keys read or being read: `run:<id>:base`, `dsp:<id>:base`, `dsp:<id>:head`. */
  const taken = new Set<string>()
  let last: OrchState | null = null

  const once = (key: string, read: () => Promise<string | null>, write: (sha: string) => Record<string, string>): void => {
    if (taken.has(key)) return
    taken.add(key)
    void read()
      .then(async (sha) => {
        if (sha) await d.record(write(sha))
      })
      .catch((e) => d.log(`git range: ${key} not recorded: ${e instanceof Error ? e.message : String(e)}`))
  }
  const headIfThere = (p: string): Promise<string | null> => (p && d.isDir(p) ? d.headOf(p) : Promise.resolve(null))
  const record = async (args: Record<string, string>): Promise<void> => {
    try {
      await d.record(args)
    } catch (e) {
      d.log(`git range: ${JSON.stringify(args)} not recorded: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return {
    onState: (s) => {
      last = s
      const runOfTask = new Map(s.tasks.map((t) => [t.id, t.runId]))
      const hasAttempt = new Set(s.dispatches.map((x) => runOfTask.get(x.taskId)))
      for (const run of s.runs) {
        if (run.git?.base !== undefined) continue
        const job = s.jobs.find((j) => j.id === run.jobId)
        const root = runRootOf(run, job)
        if (run.worktree !== undefined) {
          const ref = d.baseRefOf(run.worktree)
          once(`run:${run.id}:base`, () => (ref ? d.mergeBase(run.worktree!, ref) : headIfThere(run.worktree!)), (base) => ({ runId: run.id, base }))
        } else if (hasAttempt.has(run.id)) once(`run:${run.id}:base`, () => headIfThere(root), (base) => ({ runId: run.id, base }))
      }
      for (const x of s.dispatches) {
        if (x.git?.base === undefined) once(`dsp:${x.id}:base`, () => headIfThere(x.cwd), (base) => ({ dispatchId: x.id, base }))
        if (x.endedAt !== undefined && x.git?.head === undefined) {
          const run = s.runs.find((r) => r.id === runOfTask.get(x.taskId))
          const root = run ? runRootOf(run, s.jobs.find((j) => j.id === run.jobId)) : ''
          once(
            `dsp:${x.id}:head`,
            async () => {
              const head = await headIfThere(x.cwd)
              if (head) await record({ dispatchId: x.id, head })
              const runHead = run ? await headIfThere(root) : null
              if (run && runHead) await record({ runId: run.id, head: runHead })
              return null
            },
            () => ({})
          )
        }
      }
    },
    beforeIntegrate: async (_into, paths) => {
      const s = last
      if (!s) return
      for (const p of paths) {
        const run = s.runs.find((r) => r.worktree !== undefined && isSamePath(r.worktree, p))
        if (!run) continue
        const head = await headIfThere(p).catch(() => null)
        if (head) await record({ runId: run.id, head })
      }
    },
    afterIntegrate: async (into) => {
      const s = last
      if (!s) return
      const run = s.runs.find((r) => r.worktree !== undefined && isSamePath(r.worktree, into))
      if (!run) return
      const head = await headIfThere(into).catch(() => null)
      if (head) await record({ runId: run.id, head })
    }
  }
}
