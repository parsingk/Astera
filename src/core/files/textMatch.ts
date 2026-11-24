/**
 * Text search's pure parts (spec W2): which lines of a file hold what was typed, how a row reads, and which files are
 * never read for it. main/textSearch.ts does the reading.
 *
 * Positions follow the editor, so Enter lands on the match: a file is the text Buffer#toString makes of it (files.read
 * does the same, keeping a BOM as line 1's first character), lines end at `\n`, and a column is 1-based in UTF-16 units,
 * which is what FileEditor's reveal counts.
 */

/** How much of a line a row shows. A minified bundle is one line of hundreds of kilobytes; the row is a window onto it. */
export const TEXT_PREVIEW_CHARS = 200
/** How much of a long line is kept before its first match, so the match reads in its context. */
const LEAD_CHARS = 40

/** One line that holds the query. */
export type TextMatch = {
  /** Absolute, named the way the explorer names a file (path.join in main), so opening it lands on the explorer's tab. */
  path: string
  /** 1-based. */
  line: number
  /** 1-based, UTF-16 units, of the line's first match. */
  col: number
  /** The line without its indentation and line ending, cut to a window when long (`…` where it was cut). */
  preview: string
  /** Where each match on the line falls in `preview`, as [start, end) offsets. */
  ranges: Array<[number, number]>
}

/** What main answers for one ask of text search (files.searchText). */
export type TextSearchAnswer = {
  matches: TextMatch[]
  /** Files are still being read: ask again shortly for more rows. */
  searching: boolean
  /** The project could not be listed (it did not answer, or its walk ran out of time): there is nothing to wait for. */
  unavailable?: true
  /** More lines match than are listed: the search stopped at its cap. */
  truncated?: true
  /** The project holds more files than its index lists: only its shallow part was searched. */
  partial?: true
}

/** The query as a pattern: the text exactly as typed, any case (Unicode case folding, so `É` finds `é`). */
export function textSearchPattern(query: string): RegExp {
  return new RegExp(query.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&'), 'giu')
}

type OpenRow = { line: number; start: number; end: number; hits: Array<[number, number]> }

function toRow(text: string, row: OpenRow): Omit<TextMatch, 'path'> {
  let lineText = text.slice(row.start, row.end)
  if (lineText.endsWith('\r')) lineText = lineText.slice(0, -1)
  const first = row.hits[0][0]
  // trimStart also takes a BOM, which the editor holds as a character but nobody wants to read
  const shown = Math.min(lineText.length - lineText.trimStart().length, first)
  let from = shown
  let to = lineText.length
  if (to - from > TEXT_PREVIEW_CHARS) {
    from = Math.max(from, first - LEAD_CHARS)
    to = Math.min(lineText.length, from + TEXT_PREVIEW_CHARS)
  }
  const head = from > shown ? '…' : ''
  const tail = to < lineText.length ? '…' : ''
  const shift = head.length - from
  return {
    line: row.line,
    col: first + 1,
    preview: head + lineText.slice(from, to) + tail,
    ranges: row.hits.filter(([s, e]) => s < to && e > from).map(([s, e]) => [Math.max(s, from) + shift, Math.min(e, to) + shift])
  }
}

/**
 * The lines of `text` that hold `pattern` (textSearchPattern), first to last, at most `room` of them: one row per line,
 * every match on it marked.
 */
export function matchLines(text: string, pattern: RegExp, room: number): Array<Omit<TextMatch, 'path'>> {
  const out: Array<Omit<TextMatch, 'path'>> = []
  if (room <= 0) return out
  let line = 1
  let lineStart = 0
  let nextNl = text.indexOf('\n')
  let row: OpenRow | null = null
  pattern.lastIndex = 0
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    const at = m.index
    while (nextNl !== -1 && nextNl < at) {
      line++
      lineStart = nextNl + 1
      nextNl = text.indexOf('\n', lineStart)
    }
    if (row === null || row.line !== line) {
      if (row !== null) {
        out.push(toRow(text, row))
        if (out.length >= room) return out
      }
      row = { line, start: lineStart, end: nextNl === -1 ? text.length : nextNl, hits: [] }
    }
    row.hits.push([at - lineStart, at - lineStart + m[0].length])
  }
  if (row !== null) out.push(toRow(text, row))
  return out
}

/** The editor's rule for a file it shows no text of (files.read): a NUL byte anywhere. Search lists no line of one. */
export function looksBinary(buf: Uint8Array): boolean {
  return buf.includes(0)
}

/** Files whose whole point is a secret, by name. */
const CREDENTIAL_NAMES = new Set([
  '.env', '.envrc', '.netrc', '_netrc', '.npmrc', '.pypirc', '.pgpass', '.htpasswd', '.git-credentials',
  'credentials', 'credentials.json', '.credentials.json', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'
])
/** Key stores and private keys. A certificate (`.crt`, `.cer`) is public and stays searchable. */
const CREDENTIAL_EXTS = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.kdbx', '.ppk'])
/** Folders that hold nothing but keys and logins. */
const CREDENTIAL_DIRS = new Set(['.ssh', '.gnupg', '.aws'])
/** `.env.example` and its kind are committed on purpose, with placeholders instead of values. */
const ENV_TEMPLATE = /\.(example|sample|template|dist|defaults)$/

/**
 * Whether search keeps out of this file (spec W2: credential files excluded by default). By name, since reading it to
 * decide is what this avoids. `relPath` is relative to the project, either slash.
 */
export function isCredentialFile(relPath: string): boolean {
  const parts = relPath.replace(/\\/g, '/').toLowerCase().split('/')
  const name = parts[parts.length - 1]
  if (parts.slice(0, -1).some((p) => CREDENTIAL_DIRS.has(p))) return true
  if (CREDENTIAL_NAMES.has(name)) return true
  if (name.startsWith('.env.')) return !ENV_TEMPLATE.test(name)
  const dot = name.lastIndexOf('.')
  return dot > 0 && CREDENTIAL_EXTS.has(name.slice(dot))
}
