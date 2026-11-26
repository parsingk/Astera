// An LSP `Diagnostic[]` as the problems Astera keeps (Phase 3 Part 3): 0-based positions made 1-based (columns stay in
// UTF-16 code units, the only encoding Astera offers a server), severity 4 (a hint: an editor suggestion `tsc` never
// reports) left out, bounded. Anything that is not a diagnostic is skipped.
import type { LspProblem } from './model'

/** The most problems kept for one file, and the longest message. */
export const LSP_PROBLEMS_MAX = 200
export const LSP_MESSAGE_MAX = 2000

const SEVERITY: Record<number, LspProblem['severity']> = { 1: 'error', 2: 'warning', 3: 'info' }

const position = (v: unknown): { line: number; character: number } | null => {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  return Number.isInteger(o.line) && Number.isInteger(o.character) && (o.line as number) >= 0 && (o.character as number) >= 0
    ? { line: o.line as number, character: o.character as number }
    : null
}

export function toProblems(items: unknown, o: { max?: number; messageMax?: number } = {}): LspProblem[] {
  const max = o.max ?? LSP_PROBLEMS_MAX
  const messageMax = o.messageMax ?? LSP_MESSAGE_MAX
  const out: LspProblem[] = []
  for (const item of Array.isArray(items) ? items : []) {
    if (out.length >= max) break
    if (typeof item !== 'object' || item === null) continue
    const d = item as Record<string, unknown>
    const range = typeof d.range === 'object' && d.range !== null ? (d.range as Record<string, unknown>) : {}
    const start = position(range.start)
    const end = position(range.end)
    if (!start || !end || typeof d.message !== 'string') continue
    // Absent means the client decides (LSP); an error is the reading that never hides a problem
    const severity = d.severity === undefined ? 'error' : SEVERITY[d.severity as number]
    if (severity === undefined) continue
    const message = d.message.length > messageMax ? `${d.message.slice(0, messageMax - 1)}…` : d.message
    const code = typeof d.code === 'number' || typeof d.code === 'string' ? String(d.code) : undefined
    out.push({
      line: start.line + 1,
      column: start.character + 1,
      endLine: end.line + 1,
      endColumn: end.character + 1,
      severity,
      message,
      ...(code !== undefined ? { code } : {})
    })
  }
  return out
}
