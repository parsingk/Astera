import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { OrchState } from '../core/orchestration/state'
import { isPathWithin } from '../core/files/tree'
import { completionProblemsOf, problemsKeyOf, type RawProblem } from '../core/problems/completionProblems'
import type { Diagnostic, DiagnosticProducer } from '../core/problems/diagnostic'
import type { TestRunResult } from '../core/tests/model'
import type { LspFileDiagnostics, LspServerStatus } from '../core/lsp/model'
import { LSP_SERVERS } from '../core/lsp/languages'
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

/** Whether a file changed after a finding about it was made: what marks a row `changed`. */
const changedAfter = (st: { mtimeMs: number }, producedAt: string | undefined): boolean => producedAt !== undefined && st.mtimeMs > Date.parse(producedAt)

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
        // Each place to look with the folder it is in, which the row carries as its root (final review I3)
        const holder = path.isAbsolute(file) ? folders.find((f) => isPathWithin(f, file)) : undefined
        const candidates = path.isAbsolute(file)
          ? holder !== undefined
            ? [{ f: holder, abs: file }]
            : []
          : folders.map((f) => ({ f, abs: path.join(f, ...file.split(/[\\/]/)) })).filter((c) => isPathWithin(c.f, c.abs))
        if (candidates.length === 0) return { ...rest, unresolved: file }
        for (const c of candidates) {
          const st = await statOnce(c.abs)
          if (!st) continue
          return { ...rest, path: c.abs, root: c.f, ...(changedAfter(st, rest.producedAt) ? { stale: 'changed' as const } : {}) }
        }
        const last = candidates[candidates.length - 1]
        return { ...rest, path: last.abs, root: last.f, stale: 'missing' }
      }
      return mapLimited(raw, STAT_AT_ONCE, resolve)
    }
  }
}

/**
 * A person's failed tests (Phase 3 Part 2): one row per failed or errored case of the last result of each of the
 * project's configurations (main/testResults.ts), only from a result that is this run's own: none from a stale report,
 * a stopped run, or a report that could not be read. A case's file is relative to the run's folder, inside it (the
 * parsers drop any other); its row is marked `changed` or `missing` as a completion finding's is. No Task, so no
 * `origin`: its fix is a new Job draft.
 */
export function testProducer(deps: {
  results: (project: string) => Promise<TestRunResult[]>
  stat: (abs: string) => Promise<{ mtimeMs: number } | null>
}): DiagnosticProducer {
  return {
    id: 'test',
    async diagnostics(project) {
      const rows: { d: Diagnostic; abs?: string }[] = []
      for (const r of await deps.results(project)) {
        if (r.stale || r.outcome === 'stopped' || r.outcome === 'unknown') continue
        for (const c of r.cases) {
          if (c.status !== 'failed' && c.status !== 'errored') continue
          const words = (c.failure?.message ?? '').split('\n')[0].trim()
          const file = c.failure?.file ?? c.file
          const abs = file !== undefined ? path.join(r.cwd, ...file.split('/')) : undefined
          rows.push({
            d: {
              schemaVersion: 1,
              id: `test:${r.configId}:${c.id}`,
              source: { kind: 'test', id: r.configId, label: r.configName },
              severity: 'error',
              message: `${[...c.suite, c.name].join(' > ')}${words !== '' ? `: ${words}` : ''}`,
              ...(abs !== undefined ? { path: abs } : {}),
              ...(abs !== undefined && c.failure?.line !== undefined ? { line: c.failure.line } : {}),
              producedAt: r.endedAt
            },
            ...(abs !== undefined ? { abs } : {})
          })
        }
      }
      return mapLimited(rows, STAT_AT_ONCE, async ({ d, abs }) => {
        if (abs === undefined) return d
        const st = await deps.stat(abs)
        if (!st) return { ...d, stale: 'missing' as const }
        return changedAfter(st, d.producedAt) ? { ...d, stale: 'changed' as const } : d
      })
    }
  }
}

/**
 * The language servers' problems (Phase 3 Part 3) for the project's files open in the editor, as the Host last pushed
 * them (main/host/hostLsp.ts): one row per problem, with its column and range, under its server's name. A row is marked
 * `changed` once its file changed after the server spoke, `missing` once it is gone. No Task: its fix is a new Job draft.
 */
export function lspProducer(deps: {
  files: (project: string) => LspFileDiagnostics[]
  /** Every server's state, for a note per root of the project that no server checks (final review I4). */
  servers: () => LspServerStatus[]
  stat: (abs: string) => Promise<{ mtimeMs: number } | null>
}): DiagnosticProducer {
  return {
    id: 'lsp',
    async diagnostics(project) {
      // A root of the project its server is not checking: one note, so the list does not look clean (final review I4)
      const unchecked = deps
        .servers()
        .filter((s) => s.why !== undefined && isPathWithin(project, s.root))
        .map(
          (s): Diagnostic => ({
            schemaVersion: 1,
            id: `lsp:unchecked:${s.server}:${s.root}`,
            source: { kind: 'lsp', id: s.server, label: LSP_SERVERS[s.server].title },
            severity: 'info',
            message: s.reason ?? (s.why as string),
            root: s.root,
            unchecked: s.why
          })
        )
      const files = deps.files(project)
      // A file over the bound the servers read: said, not silently unchecked (final review M13)
      const skipped = files
        .filter((f) => f.skipped === 'too-large')
        .map(
          (f): Diagnostic => ({
            schemaVersion: 1,
            id: `lsp:skipped:${f.server}:${f.path}`,
            source: { kind: 'lsp', id: f.server, label: LSP_SERVERS[f.server].title },
            severity: 'info',
            message: 'not checked: the file is larger than the language servers read',
            path: f.path,
            root: f.root,
            unchecked: 'too-large',
            producedAt: f.producedAt
          })
        )
      const rows = files.flatMap((f) =>
        f.problems.map(
          (p, i): Diagnostic => ({
            schemaVersion: 1,
            id: `lsp:${f.server}:${f.path}:${p.line}:${p.column}:${p.code ?? ''}:${i}`,
            source: { kind: 'lsp', id: f.server, label: LSP_SERVERS[f.server].title },
            severity: p.severity,
            message: p.message,
            path: f.path,
            root: f.root,
            line: p.line,
            column: p.column,
            endLine: p.endLine,
            endColumn: p.endColumn,
            ...(p.code !== undefined ? { code: p.code } : {}),
            producedAt: f.producedAt
          })
        )
      )
      // Each file is looked at once, however many rows it has (final review M15)
      const paths = [...new Set([...skipped, ...rows].map((d) => d.path as string))]
      const stats = new Map(paths.map((p, i) => [p, i]))
      const looked = await mapLimited(paths, STAT_AT_ONCE, (p) => deps.stat(p))
      const marked = [...skipped, ...rows].map((d) => {
        const st = looked[stats.get(d.path as string) as number]
        if (!st) return { ...d, stale: 'missing' as const }
        return changedAfter(st, d.producedAt) ? { ...d, stale: 'changed' as const } : d
      })
      return [...unchecked, ...marked]
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
