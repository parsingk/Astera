/**
 * The Problems panel's model (spec W5): one shape every producer of diagnostics publishes, so LSP, build, lint and test
 * results join completion checks and reviews in one list later without the panel changing. Pure: the renderer imports
 * this file.
 */

export type DiagnosticSeverity = 'error' | 'warning' | 'info'

/** One problem, version 1. */
export interface Diagnostic {
  schemaVersion: 1
  /** Stable for the same finding of the same producer, so a list asked for again keeps its rows. */
  id: string
  /** Who found it: the kind of producer, its own id (a check's configuration id), and its name as a person reads it. */
  source: { kind: 'check' | 'review' | 'lsp' | 'build' | 'lint' | 'test'; id: string; label: string }
  severity: DiagnosticSeverity
  message: string
  /** The file, absolute, when the finding names one. */
  path?: string
  /** The folder `path` was found in (a Job's worker folder, or the project), for a finding of a Job: a session must work
   *  in this folder to be handed the row (final review I3), as a session of another worktree must not. */
  root?: string
  /** 1-based. */
  line?: number
  /** 1-based, in UTF-16 code units as the editor and LSP count them (Phase 3). */
  column?: number
  /** Where the problem ends, when its producer says: 1-based, the column in UTF-16 code units. */
  endLine?: number
  endColumn?: number
  /** The producer's own code for the kind of problem (a linter rule, a compiler error number). */
  code?: string
  /** The finding as a person's repair request names it, the same in the next round (core/problems/findingRef.ts): set
   *  on a finding of a Job's Task. */
  ref?: string
  /** When it was found (ISO), which is what makes it stale once the file changes after it. */
  producedAt?: string
  /** The Job round and Task it came from, for a finding of a Job's completion, and the Job's name as every place shows
   *  it, when its Job is still on record. */
  origin?: { runId: string; taskId: string; task: string; job?: string }
  /** The file changed after the finding (`changed`) or is not there (`missing`): it may no longer hold. */
  stale?: 'changed' | 'missing'
  /** This row stands for that many findings the producer kept no detail of (a check keeps 20 and counts the rest). */
  unlisted?: number
  /** The file as the finding named it, when it was not looked at: a name that leaves its folder or points at another
   *  machine. Shown, never opened. */
  unresolved?: string
}

/** What the Problems list asks of each source of findings. Main runs one per source and merges them. */
export interface DiagnosticProducer {
  id: string
  diagnostics(project: string): Promise<Diagnostic[]>
}

const RANK: Record<DiagnosticSeverity, number> = { error: 0, warning: 1, info: 2 }

/** By path then line; a problem with no file after every one with a file. */
const byPlace = (a: Diagnostic, b: Diagnostic): number => {
  if (a.path === undefined || b.path === undefined) return Number(a.path === undefined) - Number(b.path === undefined)
  return a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0)
}
const bySeverity = (a: Diagnostic, b: Diagnostic): number => RANK[a.severity] - RANK[b.severity]

/** The list in the order a person asked for: errors first (then by place), by place, or by who found it (errors first
 *  within each), who found it read through `labelOf`, the name the row shows. A new array; ties keep the producers'
 *  order. */
export function sortDiagnostics(
  list: readonly Diagnostic[],
  by: 'severity' | 'file' | 'source',
  labelOf: (d: Diagnostic) => string = (d) => d.source.label
): Diagnostic[] {
  const compare =
    by === 'severity'
      ? (a: Diagnostic, b: Diagnostic) => bySeverity(a, b) || byPlace(a, b)
      : by === 'file'
        ? (a: Diagnostic, b: Diagnostic) => byPlace(a, b) || bySeverity(a, b)
        : (a: Diagnostic, b: Diagnostic) => labelOf(a).localeCompare(labelOf(b)) || bySeverity(a, b) || byPlace(a, b)
  return [...list].sort(compare)
}

/** The problems of the severities asked for whose shown strings hold the text (any case). `shown` is what the row shows
 *  (the panel passes its project-relative place and its own word for a review); by default the message, the path and
 *  the source's name. */
export function filterDiagnostics(
  list: readonly Diagnostic[],
  f: { severities: ReadonlySet<DiagnosticSeverity>; text: string; shown?: (d: Diagnostic) => string[] }
): Diagnostic[] {
  const text = f.text.trim().toLowerCase()
  const shown = f.shown ?? ((d: Diagnostic) => [d.message, d.path ?? '', d.source.label])
  return list.filter((d) => f.severities.has(d.severity) && (text === '' || shown(d).some((s) => s.toLowerCase().includes(text))))
}

/** How many of each severity, for the tab and the toggles. */
export function problemCounts(list: readonly Diagnostic[]): Record<DiagnosticSeverity, number> {
  const out: Record<DiagnosticSeverity, number> = { error: 0, warning: 0, info: 0 }
  for (const d of list) out[d.severity]++
  return out
}
