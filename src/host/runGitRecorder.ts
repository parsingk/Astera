// The git range each Run and each attempt worked over (remote runtime design Phase 10), recorded by the Host as it
// happens: `runs-changed-files` and `runs-diff` read it, and nothing in state could rebuild it once a merge reaps the
// worktree and deletes its branch.
//
// - A Run's base: where its own worktree forked from its base branch (`merge-base`), or from the project's HEAD when
//   the registry does not list that worktree; or, while one of its attempts is open, its root's HEAD (a Run in the
//   project folder, or no fork point found).
// - An attempt's base: its folder's HEAD while it is open; its head: that folder's HEAD once it ends, which also moves
//   its Run's head to the Run root's HEAD.
// - Around a merge: a Run whose worktree is merged gets the head it had before; a Run root merged into gets the head
//   after, so a Run's range covers its Tasks' merged worktrees.
//
// **Only what it sees happen** (Phase 10 review I1): an attempt that already ended without a base gets none, and no head
// without a base, so work from before this phase is "not recorded" rather than given today's HEAD as an empty range.
//
// A read that fails is logged and tried again on a later state while it still applies; a read that cannot ever answer
// (its folder is gone, a merged Run's reaped worktree) or must not (a branch already merged parts from its base at its
// own tip: an empty range, which would say "no changes" for work never recorded) is settled for good, read once and not
// logged again (Phase 11 review C1, I1). At most READS_AT_ONCE git reads run at a time; nothing here throws.
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
  /** Whether the folder is there. A promise on the Host, so no synchronous probe runs on its one thread. */
  isDir(path: string): boolean | Promise<boolean>
  log(m: string): void
}

export interface RunGitRecorder {
  onState(s: OrchState): void
  beforeIntegrate(into: string, paths: string[]): Promise<void>
  afterIntegrate(into: string): Promise<void>
}

const READS_AT_ONCE = 4
/** A read that will never answer: settled, not retried. */
const SETTLED = Symbol('settled')
type Read = string | null | typeof SETTLED

export function createRunGitRecorder(d: RunGitRecorderDeps): RunGitRecorder {
  /** Keys read, being read, or done: `run:<id>:base`, `dsp:<id>:base`, `dsp:<id>:head`. A failed one leaves. */
  const taken = new Set<string>()
  let last: OrchState | null = null

  let running = 0
  const waiting: Array<() => void> = []
  const slot = async <T>(work: () => Promise<T>): Promise<T> => {
    if (running >= READS_AT_ONCE) await new Promise<void>((r) => waiting.push(r))
    running++
    try {
      return await work()
    } finally {
      running--
      waiting.shift()?.()
    }
  }

  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
  const record = async (args: Record<string, string>): Promise<boolean> => {
    try {
      await d.record(args)
      return true
    } catch (e) {
      d.log(`git range: ${JSON.stringify(args)} not recorded: ${message(e)}`)
      return false
    }
  }
  /** Reads once and records what it read; a read with no answer leaves the key, so a later state tries again, and a
   *  settled one keeps it. */
  const once = (key: string, read: () => Promise<Read>, write: (sha: string) => Record<string, string>): void => {
    if (taken.has(key)) return
    taken.add(key)
    void slot(read)
      .catch((e): Read => {
        d.log(`git range: ${key}: ${message(e)}`)
        return null
      })
      .then(async (sha) => {
        if (sha === SETTLED) return
        if (sha && (await record(write(sha)))) return
        if (!sha) d.log(`git range: ${key}: git had no answer; tried again on a later change`)
        taken.delete(key)
      })
  }
  const there = async (p: string): Promise<boolean> => p !== '' && (await d.isDir(p))
  /** A folder's HEAD; settled when the folder is gone. */
  const headIfThere = async (p: string): Promise<Read> => ((await there(p)) ? d.headOf(p) : SETTLED)

  return {
    onState: (s) => {
      last = s
      const runOfTask = new Map(s.tasks.map((t) => [t.id, t.runId]))
      const openRuns = new Set(s.dispatches.filter((x) => x.endedAt === undefined).map((x) => runOfTask.get(x.taskId)))
      const workedRuns = new Set(s.dispatches.map((x) => runOfTask.get(x.taskId)))
      for (const run of s.runs) {
        if (run.git?.base !== undefined) continue
        const project = s.jobs.find((j) => j.id === run.jobId)?.cwd ?? ''
        const root = runRootOf(run, s.jobs.find((j) => j.id === run.jobId))
        const open = openRuns.has(run.id)
        const wt = run.worktree !== undefined && !isSamePath(run.worktree, project) ? run.worktree : null
        const ref = wt ? d.baseRefOf(wt) : null
        // Where a registered worktree forked is true whenever it is read; anything else only while the work is under way.
        if (!open && !ref) continue
        once(
          `run:${run.id}:base`,
          async (): Promise<Read> => {
            if (wt) {
              if (!(await there(wt))) return SETTLED
              // The base branch it was forked from; a worktree the registry does not list parts from the project.
              const from = ref ?? (await headIfThere(project))
              const fork = typeof from === 'string' ? await d.mergeBase(wt, from) : null
              // At its own tip after work that is over: merged already, its range gone (a fresh worktree with no work
              // yet sits at its fork point the same way, and is recorded).
              if (fork && !open && workedRuns.has(run.id) && fork === (await d.headOf(wt))) return SETTLED
              if (fork) return fork
            }
            return open ? headIfThere(root) : null
          },
          (base) => ({ runId: run.id, base })
        )
      }
      for (const x of s.dispatches) {
        if (x.git?.base === undefined) {
          if (x.endedAt === undefined) once(`dsp:${x.id}:base`, () => headIfThere(x.cwd), (base) => ({ dispatchId: x.id, base }))
          continue
        }
        if (x.endedAt === undefined || x.git.head !== undefined) continue
        const run = s.runs.find((r) => r.id === runOfTask.get(x.taskId))
        const root = run ? runRootOf(run, s.jobs.find((j) => j.id === run.jobId)) : ''
        once(
          `dsp:${x.id}:head`,
          async () => {
            const head = await headIfThere(x.cwd)
            if (typeof head !== 'string') return head
            // The Run's head moves with its attempts, once its own base is known.
            if (run?.git?.base !== undefined) {
              const runHead = await headIfThere(root)
              if (typeof runHead === 'string') await record({ runId: run.id, head: runHead })
            }
            return head
          },
          (head) => ({ dispatchId: x.id, head })
        )
      }
    },
    beforeIntegrate: async (_into, paths) => {
      const s = last
      if (!s) return
      for (const p of paths) {
        const run = s.runs.find((r) => r.worktree !== undefined && isSamePath(r.worktree, p))
        if (!run) continue
        const head = await slot(() => headIfThere(p)).catch(() => null)
        if (typeof head === 'string') await record({ runId: run.id, head })
        else d.log(`git range: the head of ${p} before its merge could not be read`)
      }
    },
    afterIntegrate: async (into) => {
      const s = last
      if (!s) return
      const run = s.runs.find((r) => r.worktree !== undefined && isSamePath(r.worktree, into))
      if (!run) return
      const head = await slot(() => headIfThere(into)).catch(() => null)
      if (typeof head === 'string') await record({ runId: run.id, head })
      else d.log(`git range: the head of ${into} after a merge could not be read`)
    }
  }
}
