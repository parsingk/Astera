import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { OrchState } from '../core/orchestration/state'
import { isPathWithin } from '../core/files/tree'
import { completionProblemsOf, problemsKeyOf, type RawProblem } from '../core/problems/completionProblems'
import type { Diagnostic, DiagnosticProducer } from '../core/problems/diagnostic'
import { UNC_LIKE } from './run/resolveLink'

/** How many stats one ask runs at once. A share that stops answering holds a libuv thread per stat for its timeout
 *  (main/fileIndex.ts says the same of a readdir), and a Job's findings can name many files. */
const STAT_AT_ONCE = 8

/** Runs `fn` on each item, at most `limit` at a time, answers in order. */
async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return out
}

/** A file's modification time, or null when it is not there. */
export async function statMtime(abs: string): Promise<{ mtimeMs: number } | null> {
  try {
    const s = await fs.stat(abs)
    return s.isFile() ? { mtimeMs: s.mtimeMs } : null
  } catch {
    return null
  }
}

/**
 * The Problems list's first producer (spec W5): what the project's Jobs' completion found (core/problems/completionProblems.ts),
 * each file found where the work was done. A finding's file is relative to the folder its check or review ran in, so it
 * is looked for in the Task's worker folders, newest first, then in the Job's folder, where a removed worktree's work
 * has gone once merged. A finding whose file changed after it is marked `changed`, one whose file is nowhere `missing`:
 * both stay listed, since a person may still want to look.
 *
 * A finding's file is written by a reviewer agent or a CI annotation, so it is looked at only inside its folders: a
 * relative name that climbs out, an absolute name in none of them, and any UNC or device name (stat'ing one on Windows
 * opens an SMB connection that hands that host the person's credentials, which main/run/resolveLink.ts refuses for the
 * same reason) is listed with the name as written (`unresolved`), never stat'ed, never opened. Stats run a few at a time.
 *
 * Freshness on a fallback copy is that copy's: after a merge the project's file is the Task's work, so its time is the
 * right one; a Task whose worktree went away without its work landing leaves the project's older copy, which reads
 * fresh with a line that may point into content that never landed. Without a record of which commits landed, that is
 * the trade made.
 */
export function completionProducer(deps: {
  /** The orchestration state main holds, or null when orchestration has not started. */
  state: () => OrchState | null
  /** The ids of the project's Jobs and their runs (main's ownership check). */
  runIdsOf: (project: string) => ReadonlySet<string>
  stat: (abs: string) => Promise<{ mtimeMs: number } | null>
}): DiagnosticProducer {
  return {
    id: 'completion',
    async diagnostics(project) {
      const s = deps.state()
      if (!s) return []
      const raw = completionProblemsOf(s, deps.runIdsOf(project))
      // One stat per file however many findings name it
      const seen = new Map<string, Promise<{ mtimeMs: number } | null>>()
      const statOnce = (abs: string): Promise<{ mtimeMs: number } | null> => {
        let p = seen.get(abs)
        if (!p) seen.set(abs, (p = deps.stat(abs)))
        return p
      }
      const resolve = async (p: RawProblem): Promise<Diagnostic> => {
        const { file, folders, ...rest } = p
        if (file === undefined) return rest
        if (UNC_LIKE.test(file)) return { ...rest, unresolved: file }
        const candidates = path.isAbsolute(file)
          ? folders.some((f) => isPathWithin(f, file))
            ? [file]
            : []
          : folders.map((f) => ({ f, abs: path.join(f, ...file.split(/[\\/]/)) })).filter((c) => isPathWithin(c.f, c.abs)).map((c) => c.abs)
        if (candidates.length === 0) return { ...rest, unresolved: file }
        for (const abs of candidates) {
          const st = await statOnce(abs)
          if (!st) continue
          const changed = rest.producedAt !== undefined && st.mtimeMs > Date.parse(rest.producedAt)
          return { ...rest, path: abs, ...(changed ? { stale: 'changed' as const } : {}) }
        }
        return { ...rest, path: candidates[candidates.length - 1], stale: 'missing' }
      }
      return mapLimited(raw, STAT_AT_ONCE, resolve)
    }
  }
}

/**
 * The project's problems (IPC `problems.list`): every producer's findings, merged. The project comes from the renderer,
 * so it passes the files path guard first. A producer that fails, at once or later, leaves the others' findings standing
 * and is logged by its id. Asks for a project that arrive while one is answering it share that answer: a window focus, a
 * Jobs change and a file batch can all ask at once.
 */
export function createProblems(deps: {
  producers: DiagnosticProducer[]
  allowedRoot: (p: string) => Promise<string>
  log?: (line: string) => void
}): (project: unknown) => Promise<Diagnostic[]> {
  const inflight = new Map<string, Promise<Diagnostic[]>>()
  const gather = async (project: string): Promise<Diagnostic[]> => {
    const results = await Promise.allSettled(deps.producers.map((p) => Promise.resolve().then(() => p.diagnostics(project))))
    return results.flatMap((r, i) => {
      if (r.status === 'fulfilled') return r.value
      deps.log?.(`problems: producer ${deps.producers[i].id} failed: ${String(r.reason)}`)
      return []
    })
  }
  return async (project) => {
    if (typeof project !== 'string' || project === '') throw new Error('problems.list takes a project folder')
    await deps.allowedRoot(project)
    const running = inflight.get(project)
    if (running) return running
    const answer = gather(project).finally(() => inflight.delete(project))
    inflight.set(project, answer)
    return answer
  }
}

/**
 * Tells the renderer to ask for the problems again (spec W5, final review I1): when an orchestration write moved what
 * they are made of (problemsKeyOf), and when the explorer's watcher saw files change (a finding goes stale). Whatever
 * view is open, since the Jobs snapshot is pushed only while the Jobs view shows. One ping after a short quiet, however
 * many writes and batches came.
 */
export function createProblemsPing(deps: { send: () => void; delayMs?: number }): { onState(state: OrchState): void; touch(): void } {
  const delayMs = deps.delayMs ?? 300
  let lastKey: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const touch = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      deps.send()
    }, delayMs)
  }
  return {
    onState(state) {
      const key = problemsKeyOf(state)
      if (key === lastKey) return
      lastKey = key
      touch()
    },
    touch
  }
}
