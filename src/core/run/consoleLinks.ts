// What in a line of run output is a link, and how xterm's rows relate to that line. All pure — the
// renderer's link provider (RunPanel) calls these with buffer rows and turns the answers into xterm
// ILinks; whether a path really exists is main's call (main/run/resolveLink.ts), not this file's.

export type ConsoleLink =
  | { kind: 'path'; start: number; end: number; target: string; line?: number; col?: number }
  | { kind: 'url'; start: number; end: number; url: string }

const URL_RE = /https?:\/\/[^\s'"<>]+/g
// Tokens are whitespace-separated; quotes and angle brackets also end one (they wrap paths in
// messages). Parentheses stay inside the token so TypeScript's `a.ts(12,5)` survives; a stack frame's
// wrapping parentheses are peeled below.
const TOKEN_RE = /[^\s'"<>]+/g
const LEAD_OPEN = /^[([]+/
const TRAIL_CLOSE = /[)\]]+$/
const TRAIL_PUNCT = /[.,;:]+$/
// URL: whatever the regex took, minus closing punctuation a sentence or a parenthesis left on it
const URL_TRAIL = /[)\].,;:]+$/
const FILE_SCHEME = /^file:\/\/\//
// `path:line[:col]`. The path is an optional drive/root followed by anything but a colon — the colon
// is where the position starts. `D:\p\a.ts:12` therefore reads the drive as part of the path.
const POSITION_RE = /^((?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/]|~[\\/])?[^:]*?)(?::(\d+)(?::(\d+))?)?$/
// TypeScript's `path(line,col)`
const TS_POSITION_RE = /^((?:[A-Za-z]:[\\/])?[^:()]+)\((\d+),(\d+)\)$/
const SEP = /[\\/]/
const EXT = /\.[A-Za-z0-9]{1,10}$/

/** A path candidate is a link when it contains a separator, or has an extension and a line — a bare
 *  word is not a file, and `12:30` is a clock. */
function acceptPath(target: string, line: number | undefined): boolean {
  if (target === '') return false
  if (SEP.test(target)) return true
  return EXT.test(target) && line !== undefined
}

export function findConsoleLinks(line: string): ConsoleLink[] {
  const out: ConsoleLink[] = []
  const taken: [number, number][] = []
  // URLs first: a URL has slashes and would otherwise be read as a path by the token pass below
  for (const m of line.matchAll(URL_RE)) {
    const url = m[0].replace(URL_TRAIL, '')
    if (url.length <= 'https://'.length) continue
    const start = m.index ?? 0
    out.push({ kind: 'url', start, end: start + url.length, url })
    taken.push([start, start + url.length])
  }
  for (const m of line.matchAll(TOKEN_RE)) {
    let start = m.index ?? 0
    let text = m[0]
    const end0 = start + text.length
    if (taken.some(([s, e]) => start < e && end0 > s)) continue
    const lead = text.match(LEAD_OPEN)
    if (lead) {
      start += lead[0].length
      text = text.slice(lead[0].length)
    }
    // `a.ts(12,5):` — the colon after the parenthesis is punctuation, the parenthesis is the position
    text = text.replace(TRAIL_PUNCT, '')
    const ts = text.match(TS_POSITION_RE)
    if (ts) {
      const target = ts[1]
      if (acceptPath(target, Number(ts[2]))) {
        out.push({ kind: 'path', start, end: start + text.length, target, line: Number(ts[2]), col: Number(ts[3]) })
      }
      continue
    }
    // `(D:\p\a.ts:12:5)` — a stack frame's closing parenthesis, then any punctuation before it
    text = text.replace(TRAIL_CLOSE, '').replace(TRAIL_PUNCT, '')
    const scheme = text.match(FILE_SCHEME)
    const body = scheme ? text.slice(scheme[0].length) : text
    const pos = body.match(POSITION_RE)
    if (!pos) continue
    const target = pos[1]
    const lineNo = pos[2] === undefined ? undefined : Number(pos[2])
    if (!acceptPath(target, lineNo)) continue
    const link: ConsoleLink = { kind: 'path', start, end: start + text.length, target }
    if (lineNo !== undefined) link.line = lineNo
    if (pos[3] !== undefined) link.col = Number(pos[3])
    out.push(link)
  }
  return out.sort((a, b) => a.start - b.start)
}

/** The logical line a buffer row belongs to. xterm marks a row that continues the previous one
 *  `isWrapped`; this walks up to the row where the line began and down to where it ends. `text` is
 *  the rows joined as given; `startY` is the first row, for building the cell table (see
 *  bufferRangeAt). A getter, not an array, so only the rows touched are read. */
export function joinWrappedLine(
  getLine: (y: number) => { text: string; isWrapped: boolean } | undefined,
  y: number
): { text: string; startY: number } {
  let startY = y
  for (;;) {
    const row = getLine(startY)
    if (!row || !row.isWrapped || startY === 0) break
    startY -= 1
  }
  let text = ''
  for (let cur = startY; ; cur += 1) {
    const row = getLine(cur)
    if (!row) break
    text += row.text
    const next = getLine(cur + 1)
    if (!next || !next.isWrapped) break
  }
  return { text, startY }
}

/** Where each character of a joined line sits on screen — 1-based cells, as xterm's IBufferRange
 *  wants them. The provider builds this by walking the real cells (see RunPanel), because a
 *  character is not a column: xterm's translateToString emits one entry per glyph while the column
 *  cursor advances by the glyph's width, so an 80-column row of CJK yields a 40-character string and
 *  no arithmetic over `cols` can place it. */
export interface CharCell {
  x: number
  y: number
}

/** The buffer range covering `[start, end)` of the joined text, as an xterm IBufferRange (1-based,
 *  `end` inclusive). `cells` is one entry per character of that same text. A range whose start is
 *  past the table's end — the text and the table disagreeing, which should not happen — collapses to
 *  the last cell rather than throwing: a misplaced underline is better than a dead provider. */
export function bufferRangeAt(
  cells: readonly CharCell[],
  start: number,
  end: number
): { start: CharCell; end: CharCell } {
  if (cells.length === 0) return { start: { x: 1, y: 1 }, end: { x: 1, y: 1 } }
  const at = (i: number): CharCell => cells[Math.min(Math.max(i, 0), cells.length - 1)]
  return { start: at(start), end: at(Math.max(start, end - 1)) }
}
