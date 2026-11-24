/**
 * Text search's pure parts (spec W2): which lines of a file hold what was typed, how a row reads, and which files are
 * never read for it. main/textSearch.ts does the reading.
 *
 * Positions follow the editor, so Enter lands on the match: a file is the text Buffer#toString makes of it (files.read
 * does the same, keeping a BOM as line 1's first character), a line ends at `\r\n`, a lone `\r` or `\n` (the editor's
 * buffer is toLf of the file, core/files/edit.ts), and a column is 1-based in UTF-16 units, which is what FileEditor's
 * reveal counts.
 */

/** How much of a line a row shows. A minified bundle is one line of hundreds of kilobytes; the row is a window onto it. */
export const TEXT_PREVIEW_CHARS = 200
/** The longest query searched. Longer pasted text is said to be too long rather than answered as no match. */
export const TEXT_SEARCH_MAX_QUERY = 256
/** How many lines one file gives. Files are read shallowest first, and without this a root lockfile filled the whole
 *  list (`%react` in this repository listed 298 lines of package-lock.json and none of `src/`); the rest of a file is
 *  the editor's find away. */
export const TEXT_SEARCH_LINES_PER_FILE = 20
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
  /** A file held more matching lines than TEXT_SEARCH_LINES_PER_FILE: only its first ones are listed. */
  fileCut?: true
  /** The project holds more files than its index lists: only its shallow part was searched. */
  partial?: true
}

/** The query as a pattern: the text exactly as typed, any case (Unicode case folding, so `É` finds `é`). */
export function textSearchPattern(query: string): RegExp {
  return new RegExp(query.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&'), 'giu')
}

type OpenRow = { line: number; start: number; end: number; hits: Array<[number, number]> }

function toRow(text: string, row: OpenRow): Omit<TextMatch, 'path'> {
  const lineText = text.slice(row.start, row.end)
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
  // The line breaks the editor's toLf knows: `\r\n` as one, then a lone `\r` or `\n`
  const breaks = /\r\n?|\n/g
  let brk = breaks.exec(text)
  let line = 1
  let lineStart = 0
  let row: OpenRow | null = null
  pattern.lastIndex = 0
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    const at = m.index
    while (brk !== null && brk.index < at) {
      line++
      lineStart = brk.index + brk[0].length
      brk = breaks.exec(text)
    }
    if (row === null || row.line !== line) {
      if (row !== null) {
        out.push(toRow(text, row))
        if (out.length >= room) return out
      }
      row = { line, start: lineStart, end: brk === null ? text.length : brk.index, hits: [] }
    }
    const s = at - lineStart
    // The window a row shows ends no later than this past its first match (toRow): a match beyond it is not shown, so
    // the rest of the line is skipped rather than collected, which on a minified line is tens of thousands of matches
    if (row.hits.length > 0 && s >= row.hits[0][0] + TEXT_PREVIEW_CHARS) {
      pattern.lastIndex = Math.max(pattern.lastIndex, row.end)
      continue
    }
    row.hits.push([s, s + m[0].length])
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
const CREDENTIAL_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.kube'])
/** Login files whose names are too common to refuse anywhere, by the folder each tool keeps them in: Codex's login
 *  (core/sandbox/locations.ts AGENT_LOGIN_FILE names it too), Docker's registry logins, the GitHub CLI's tokens. They are
 *  in reach when the explorer's project is the home folder. */
const CREDENTIAL_IN_DIR: ReadonlyArray<readonly [dir: string, name: string]> = [
  ['.codex', 'auth.json'],
  ['.docker', 'config.json'],
  ['gh', 'hosts.yml']
]
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
  const dir = parts.length > 1 ? parts[parts.length - 2] : ''
  if (CREDENTIAL_IN_DIR.some(([d, n]) => d === dir && n === name)) return true
  if (name.startsWith('.env.')) return !ENV_TEMPLATE.test(name)
  const dot = name.lastIndexOf('.')
  return dot > 0 && CREDENTIAL_EXTS.has(name.slice(dot))
}
