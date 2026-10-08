// Whether a folder still exists, as the Host answers it to `jobs-view` (remote runtime design Phase 6, review I5):
// asked asynchronously with a deadline and remembered, never with a synchronous stat on the Host's only thread, which
// carries every terminal's output (a folder on an unreachable share would hold all of it). A folder not asked yet, or
// one whose check did not answer, is unknown, which a caller reads as present: unknown is not evidence that it is gone,
// the rule the app's own presence cache keeps (main/ipc.ts, worktreePresence).
import { stat as fsStat } from 'node:fs/promises'

export type Presence = 'present' | 'missing' | 'unknown'

export function createPresence(o: { stat?: (p: string) => Promise<boolean>; timeoutMs?: number } = {}) {
  const stat = o.stat ?? ((p: string) => fsStat(p).then(() => true, (e: NodeJS.ErrnoException) => (e.code === 'ENOENT' || e.code === 'ENOTDIR' ? false : Promise.reject(e))))
  const timeoutMs = o.timeoutMs ?? 1_000
  const known = new Map<string, Presence>()
  const checking = new Set<string>()
  const checkOne = async (p: string): Promise<void> => {
    if (checking.has(p)) return
    checking.add(p)
    try {
      const answer = await Promise.race([
        stat(p).then((ok): Presence => (ok ? 'present' : 'missing'), (): Presence => 'unknown'),
        new Promise<Presence>((r) => setTimeout(() => r('unknown'), timeoutMs).unref?.())
      ])
      if (answer !== 'unknown' || !known.has(p)) known.set(p, answer)
    } finally {
      checking.delete(p)
    }
  }
  return {
    /** What is known now; a folder never asked is asked in the background and is unknown until then. */
    peek: (p: string): Presence => {
      const v = known.get(p)
      if (v === undefined) void checkOne(p)
      return v ?? 'unknown'
    },
    /** Asks these folders, each bounded by the deadline; resolves when all answered or ran out. */
    check: async (paths: string[]): Promise<void> => {
      await Promise.all(paths.map((p) => checkOne(p)))
    }
  }
}
