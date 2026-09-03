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
 *  the rows joined as given (the provider passes full-width rows, so offsets map back to cells by
 *  `cols`); `startY` is the first row, for bufferRangeOf. A getter, not an array, so only the rows
 *  touched are read. */
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

/** Maps a [start, end) offset range in a joined line back to xterm cells. Rows are `cols` wide (the
 *  provider joins full-width rows); xterm's cells are 1-based and the range end is inclusive. */
export function bufferRangeOf(
  startY: number,
  cols: number,
  start: number,
  end: number
): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const last = Math.max(start, end - 1)
  return {
    start: { x: (start % cols) + 1, y: startY + Math.floor(start / cols) + 1 },
    end: { x: (last % cols) + 1, y: startY + Math.floor(last / cols) + 1 }
  }
}
