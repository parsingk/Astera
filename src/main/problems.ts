import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { OrchState } from '../core/orchestration/state'
import { completionProblemsOf, type RawProblem } from '../core/problems/completionProblems'
import type { Diagnostic, DiagnosticProducer } from '../core/problems/diagnostic'

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
        const candidates = path.isAbsolute(file) ? [file] : folders.map((f) => path.join(f, ...file.split(/[\\/]/)))
        for (const abs of candidates) {
          const st = await statOnce(abs)
          if (!st) continue
          const changed = rest.producedAt !== undefined && st.mtimeMs > Date.parse(rest.producedAt)
          return { ...rest, path: abs, ...(changed ? { stale: 'changed' as const } : {}) }
        }
        return { ...rest, ...(candidates.length > 0 ? { path: candidates[candidates.length - 1] } : {}), stale: 'missing' }
      }
      return Promise.all(raw.map(resolve))
    }
  }
}

/**
 * The project's problems (IPC `problems.list`): every producer's findings, merged. The project comes from the renderer,
 * so it passes the files path guard first; a producer that fails leaves the others' findings standing.
 */
export function createProblems(deps: {
  producers: DiagnosticProducer[]
  allowedRoot: (p: string) => Promise<string>
}): (project: unknown) => Promise<Diagnostic[]> {
  return async (project) => {
    if (typeof project !== 'string' || project === '') throw new Error('problems.list takes a project folder')
    await deps.allowedRoot(project)
    const results = await Promise.allSettled(deps.producers.map((p) => p.diagnostics(project)))
    return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
  }
}
