// The environment-variables table's conversions. The stored shape stays `Record<string, string>`;
// the table needs an ordered row list that may hold, while the user types, an empty key or a duplicate
// — so rows are UI state and these functions are the two directions between them and the record. Pure,
// so the rules are tested where the table component (renderer) cannot be.
import { parseEnvLines } from './config'

export interface EnvRow {
  key: string
  value: string
}

export type EnvRowIssue = 'emptyKey' | 'shadowed'

/** Record → rows, in the record's insertion order */
export function envRowsOf(env: Record<string, string> | undefined): EnvRow[] {
  return Object.entries(env ?? {}).map(([key, value]) => ({ key, value }))
}

/** Rows → record. A row with an empty key is dropped; when a key appears twice the lower row wins,
 *  as a shell takes the later export. No rows left → undefined, which is how "no env" is stored. */
export function envRecordOf(rows: readonly EnvRow[]): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const r of rows) {
    if (r.key === '') continue
    out[r.key] = r.value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** The rows the table marks with ⚠: a value that will be lost because its key is empty, and a key that
 *  a later row overrides. A fresh row with nothing in it is not an issue — it is where the user is
 *  about to type. Neither blocks Apply; envRecordOf already resolves both. */
export function envRowIssues(rows: readonly EnvRow[]): Map<number, EnvRowIssue> {
  const last = new Map<string, number>()
  rows.forEach((r, i) => {
    if (r.key !== '') last.set(r.key, i)
  })
  const issues = new Map<number, EnvRowIssue>()
  rows.forEach((r, i) => {
    if (r.key === '') {
      if (r.value !== '') issues.set(i, 'emptyKey')
    } else if (last.get(r.key) !== i) {
      issues.set(i, 'shadowed')
    }
  })
  return issues
}

/** A paste into a Key cell. Text with a newline or an `=` is a block of KEY=VALUE lines — a .env file,
 *  a shell export list — and is expanded with parseEnvLines (comments and blank lines ignored). A key
 *  the table already has is overwritten in place, so pasting the same block twice does not grow the
 *  table; new keys are inserted at `at`, replacing the row pasted into when that row is empty. Returns
 *  null when the text is neither, so the caller lets the browser paste it as plain text. */
export function applyEnvPaste(rows: readonly EnvRow[], at: number, text: string): EnvRow[] | null {
  if (!/[\n=]/.test(text)) return null
  const next = rows.map((r) => ({ ...r }))
  const fresh: EnvRow[] = []
  for (const [key, value] of Object.entries(parseEnvLines(text))) {
    const i = next.findIndex((r) => r.key === key)
    if (i >= 0) next[i] = { key, value }
    else fresh.push({ key, value })
  }
  // The blank row pasted into is consumed only when a fresh key is taking its place. A paste that
  // only overwrote keys the table already holds leaves it alone: that row is where the caret is, and
  // dropping it slides a different variable's row under the caret, since the table renders rows by
  // index.
  const target = next[at]
  const replace = fresh.length > 0 && target && target.key === '' && target.value === '' ? 1 : 0
  next.splice(Math.min(at, next.length), replace, ...fresh)
  return next
}
