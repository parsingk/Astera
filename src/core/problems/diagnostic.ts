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
  /** 1-based. */
  line?: number
  /** When it was found (ISO), which is what makes it stale once the file changes after it. */
  producedAt?: string
  /** The Job round and Task it came from, for a finding of a Job's completion. */
  origin?: { runId: string; taskId: string; task: string }
  /** The file changed after the finding (`changed`) or is not there (`missing`): it may no longer hold. */
  stale?: 'changed' | 'missing'
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
 *  within each). A new array; ties keep the producers' order. */
export function sortDiagnostics(list: readonly Diagnostic[], by: 'severity' | 'file' | 'source'): Diagnostic[] {
  const compare =
    by === 'severity'
      ? (a: Diagnostic, b: Diagnostic) => bySeverity(a, b) || byPlace(a, b)
      : by === 'file'
        ? (a: Diagnostic, b: Diagnostic) => byPlace(a, b) || bySeverity(a, b)
        : (a: Diagnostic, b: Diagnostic) => a.source.label.localeCompare(b.source.label) || bySeverity(a, b) || byPlace(a, b)
  return [...list].sort(compare)
}

/** The problems of the severities asked for whose message, file or source holds the text (any case). */
export function filterDiagnostics(list: readonly Diagnostic[], f: { severities: ReadonlySet<DiagnosticSeverity>; text: string }): Diagnostic[] {
  const text = f.text.trim().toLowerCase()
  return list.filter(
    (d) =>
      f.severities.has(d.severity) &&
      (text === '' || [d.message, d.path ?? '', d.source.label].some((s) => s.toLowerCase().includes(text)))
  )
}

/** How many of each severity, for the tab and the toggles. */
export function problemCounts(list: readonly Diagnostic[]): Record<DiagnosticSeverity, number> {
  const out: Record<DiagnosticSeverity, number> = { error: 0, warning: 0, info: 0 }
  for (const d of list) out[d.severity]++
  return out
}
