// get_session's text (MCP P1 fix round 1): a terminal's rows redacted as the lines they were printed
// as, and the whole read cut to a size an agent's context can take.
import { sanitize } from '../../core/orchestration/checkpoint'

const REDACTED = '[REDACTED]'

/** The length of the run `a` and `b` share at their start. */
const commonPrefix = (a: string, b: string): number => {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

/** The length of the run `a` and `b` share at their end, no longer than `max`. */
const commonSuffix = (a: string, b: string, max: number): number => {
  let i = 0
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++
  return i
}

/**
 * Terminal rows with every secret redacted, the row count and order kept. A row is what the terminal
 * shows at its width (xterm's visual row), so a key printed as one line wider than the tab sits on
 * two rows, and neither half alone looks like a secret.
 *
 * - With `wrapped` (one mark per row, true when the row continues the one above it), each logical
 *   line is joined, redacted, and laid back over its rows at their original widths; the last row
 *   takes what is left. A line with nothing to redact keeps its rows exactly.
 * - Without it (a Host older than the marks, or marks that do not fit the rows), every row is
 *   redacted alone, and every adjacent pair joined: when the pair redacts differently from its two
 *   halves, a match crosses the boundary, and the changed span is redacted on both rows, from where
 *   it starts on the first to where it ends on the second. A secret over three or more rows is
 *   caught only with the marks.
 */
export function redactRows(rows: readonly string[], wrapped: readonly boolean[] | undefined): string[] {
  if (wrapped !== undefined && wrapped.length === rows.length) {
    const out: string[] = []
    for (let i = 0; i < rows.length; ) {
      let end = i + 1
      while (end < rows.length && wrapped[end]) end++
      const parts = rows.slice(i, end)
      const line = parts.join('')
      const clean = sanitize(line)
      if (clean === line) out.push(...parts)
      else {
        let at = 0
        parts.forEach((p, k) => {
          const take = k === parts.length - 1 ? clean.length - at : p.length
          out.push(clean.slice(at, at + take))
          at += take
        })
      }
      i = end
    }
    return out
  }
  // Per row: [start of a redacted head, end of it) and [start of a redacted tail, row end).
  const headEnd = rows.map(() => 0)
  const tailStart = rows.map((r) => r.length)
  for (let i = 0; i + 1 < rows.length; i++) {
    const a = rows[i]
    const b = rows[i + 1]
    const joined = sanitize(a + b)
    if (joined === sanitize(a) + sanitize(b)) continue
    const p = commonPrefix(a + b, joined)
    const e = a.length + b.length - commonSuffix(a + b, joined, Math.min(a.length + b.length - p, joined.length - p))
    if (p < a.length) tailStart[i] = Math.min(tailStart[i], p)
    if (e > a.length) headEnd[i + 1] = Math.max(headEnd[i + 1], e - a.length)
  }
  return rows.map((r, i) => {
    const head = headEnd[i] > 0
    const tail = tailStart[i] < r.length
    if (!head && !tail) return sanitize(r)
    if (head && tail && headEnd[i] >= tailStart[i]) return REDACTED
    const middle = sanitize(r.slice(headEnd[i], tailStart[i]))
    return `${head ? REDACTED : ''}${middle}${tail ? REDACTED : ''}`
  })
}

/** At most this many characters of session text in one get_session answer: screen plus scrollback,
 *  or the turns' text and tool lines. */
export const SESSION_TEXT_CAP = 40_000

type Turn = { text?: unknown; tools?: unknown }
const toolLength = (t: unknown): number => (typeof t === 'string' ? t.length : JSON.stringify(t ?? '').length)
const turnLength = (t: Turn): number =>
  (typeof t.text === 'string' ? t.text.length : 0) + (Array.isArray(t.tools) ? t.tools.reduce((n: number, x) => n + toolLength(x), 0) : 0)

/** A get_session answer cut to `cap` characters, keeping the newest: a terminal drops its oldest
 *  rows (the scrollback's first, then the screen's top), their wrap marks with them; a chat drops its
 *  oldest turns, and a newest turn alone over the cap keeps the end of its text. */
export function capSession(
  data: Record<string, unknown>,
  cap: number = SESSION_TEXT_CAP
): { data: Record<string, unknown>; truncated: boolean } {
  if (Array.isArray(data.turns)) {
    const turns = data.turns as Turn[]
    if (turns.reduce((n, t) => n + turnLength(t), 0) <= cap) return { data, truncated: false }
    const kept: Turn[] = []
    let left = cap
    for (let i = turns.length - 1; i >= 0; i--) {
      const n = turnLength(turns[i])
      if (n <= left) {
        kept.unshift(turns[i])
        left -= n
        continue
      }
      if (kept.length === 0) {
        // The newest turn alone is over the cap: its newest tool lines, then the end of its text.
        const t = turns[i]
        const tools: unknown[] = []
        let room = cap
        for (const x of [...(Array.isArray(t.tools) ? t.tools : [])].reverse()) {
          if (toolLength(x) > room) break
          tools.unshift(x)
          room -= toolLength(x)
        }
        const text = typeof t.text === 'string' ? (room > 0 ? t.text.slice(-room) : '') : t.text
        kept.push({ ...t, text, tools })
      }
      break
    }
    return { data: { ...data, turns: kept }, truncated: true }
  }
  const scrollback = Array.isArray(data.scrollback) ? (data.scrollback as string[]) : []
  const screen = Array.isArray(data.screen) ? (data.screen as string[]) : []
  const rows = [...scrollback, ...screen]
  let total = rows.reduce((n, r) => n + r.length, 0)
  if (total <= cap) return { data, truncated: false }
  let drop = 0
  while (drop < rows.length && total > cap) total -= rows[drop++].length
  const fromScrollback = Math.min(drop, scrollback.length)
  const fromScreen = drop - fromScrollback
  const cut: Record<string, unknown> = { ...data, scrollback: scrollback.slice(fromScrollback), screen: screen.slice(fromScreen) }
  if (Array.isArray(data.scrollbackWrapped)) cut.scrollbackWrapped = data.scrollbackWrapped.slice(fromScrollback)
  if (Array.isArray(data.screenWrapped)) cut.screenWrapped = data.screenWrapped.slice(fromScreen)
  return { data: cut, truncated: true }
}
