// A test run's result, whichever reporter wrote it (Phase 3 Part 2, design §5 Part 2 item 2): what the Tests tab, the
// Problems producer and a check's diagnostics read. The parsers (junit.ts, vitestJson.ts) make it; nothing here reads
// a file.
import { createHash } from 'node:crypto'
import { isUnder, relativeTo } from '../context/contextRef'

import type { TestCase } from './model'

export type { ParsedReport, TestCase, TestStatus } from './model'

/** How much of a report is read: one file, a folder of them, the cases kept, a failure message's length. */
export const TEST_BOUNDS = {
  fileBytes: 8 * 1024 * 1024,
  folderFiles: 200,
  folderBytes: 32 * 1024 * 1024,
  cases: 5000,
  message: 2000
} as const

/** The first 12 hex of the sha256 of a case's file, suites and name: the same case in the next run. */
export function caseId(file: string | undefined, suite: readonly string[], name: string): string {
  return createHash('sha256').update([file ?? '', ...suite, name].join('\0')).digest('hex').slice(0, 12)
}

/** Two cases with one id (one name twice in a suite) told apart by their order: the second `#2`, the third `#3`, the
 *  same in the next run (final review M12). */
export function uniqueIds(cases: TestCase[]): TestCase[] {
  const seen = new Map<string, number>()
  return cases.map((c) => {
    const n = (seen.get(c.id) ?? 0) + 1
    seen.set(c.id, n)
    return n === 1 ? c : { ...c, id: `${c.id}#${n}` }
  })
}

/** A failure message cut to TEST_BOUNDS.message characters. */
export function cutMessage(message: string): string {
  return message.length > TEST_BOUNDS.message ? `${message.slice(0, TEST_BOUNDS.message - 1)}…` : message
}

/**
 * A path a report wrote, as a path inside the run's folder relative to it with `/`, or undefined when it is not inside
 * it: absolute (a drive or `/`), a `file://` URL, or relative with either slash. A path through `node_modules` is the
 * framework's own frame, not the test's.
 */
export function insideRun(cwd: string, raw: string): string | undefined {
  let p = raw.replace(/^file:\/\//, '').replace(/\\/g, '/')
  if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1)
  const absolute = p.startsWith('/') || /^[A-Za-z]:\//.test(p)
  if (absolute && !isUnder(cwd, p)) return undefined
  const parts = (absolute ? relativeTo(cwd, p) : p).split('/').filter((s) => s !== '' && s !== '.')
  if (parts.length === 0 || parts.includes('..') || parts.includes('node_modules')) return undefined
  return parts.join('/')
}

/** How far back from a `:<line>` its path is looked for, and how many `:<line>` are looked at: a failure's text is up to
 *  TEST_BOUNDS.fileBytes, and this runs in Electron main and in the Host, so it stays linear (final review I2). */
const PLACE_BACK = 1024
const PLACE_TRIES = 2000

/** What ends a path in a failure's text. */
const DELIM = /[\s()'"<>`]/

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Where the run folder's own absolute path ends in the text, in either slash form (in any case for a drive path), each
 *  time it starts a path: a place under a folder with a space in its name is read from there (final review I3). */
function folderEnds(cwd: string, text: string): number[] {
  const parts = cwd.replace(/\\/g, '/').split('/').filter((s) => s !== '')
  if (parts.length === 0) return []
  const drive = /^[A-Za-z]:$/.test(parts[0])
  const re = new RegExp(`${drive ? '' : '/'}${parts.map(escapeRe).join('[\\\\/]')}(?=[\\\\/])`, drive ? 'gi' : 'g')
  const ends: number[] = []
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (/(?:^|[\s()'"<>`]|file:\/\/\/?)$/.test(text.slice(Math.max(0, m.index - 8), m.index))) ends.push(m.index + m[0].length)
  }
  return ends
}

/** A place a failure's text names (`src/a.test.ts:9:21`, `tests\test_x.py:9:`, `at /abs/x.ts:3:1`, a `file://` URL,
 *  percent-encoded or not): the first with a directory in it that lies inside the run's folder. A bare file name (a
 *  Java frame's `(CalcTest.java:20)`) is not one: nothing says where in the folder it is. Nor is the tail of an absolute
 *  path with a space in it (`at C:/Users/Jane Doe/x.ts:3` read from `Doe/`). */
export function failurePlace(cwd: string, text: string): { file: string; line: number } | undefined {
  const ends = folderEnds(cwd, text)
  let k = 0
  let tries = 0
  const re = /:(\d+)/g
  for (let m = re.exec(text); m !== null && tries < PLACE_TRIES; m = re.exec(text)) {
    tries++
    const colon = m.index
    const line = Number(m[1])
    if (!Number.isInteger(line) || line <= 0) continue
    const windowStart = Math.max(0, colon - PLACE_BACK)
    let lineStart = colon
    while (lineStart > windowStart && text[lineStart - 1] !== '\n') lineStart--
    // Under the run folder's own path, spaces and all
    while (k < ends.length && ends[k] < colon) k++
    const folderEnd = k > 0 ? ends[k - 1] : -1
    if (folderEnd >= lineStart) {
      const rest = text.slice(folderEnd + 1, colon)
      const file = rest.includes(':') ? undefined : insideRun(cwd, rest)
      if (file !== undefined) return { file, line }
    }
    // Otherwise the path that ends here: back to a delimiter, past a drive's colon or a file URL's scheme
    let s = colon
    while (s > lineStart) {
      const ch = text[s - 1]
      if (DELIM.test(ch)) break
      if (ch === ':') {
        const driveColon = s >= 2 && /[A-Za-z]/.test(text[s - 2]) && (s - 3 < lineStart || /[\s()'"<>`/]/.test(text[s - 3]))
        const scheme = text.slice(s - 5, s - 1) === 'file' && text.startsWith('//', s)
        if (!driveColon && !scheme) break
      }
      s--
    }
    // A path longer than the window was cut, and its start is not known
    if (s === windowStart && windowStart > 0 && text[s - 1] !== '\n' && !DELIM.test(text[s - 1])) continue
    let token = text.slice(s, colon)
    if (!/[\\/]/.test(token) || /[\\/]$/.test(token)) continue
    if (token.startsWith('file://')) {
      try {
        token = decodeURIComponent(token)
      } catch {
        continue
      }
    }
    if (!/^(?:file:\/\/)?(?:\/|[A-Za-z]:[\\/])/.test(token)) {
      // A relative path after an absolute one with a space in it, on the same stretch of the line, is that path's tail
      let b = s
      while (b > lineStart && !/[()'"<>`]/.test(text[b - 1])) b--
      if (/(?:^|\s)(?:file:\/\/)?(?:\/|[A-Za-z]:[\\/])/.test(text.slice(b, s))) continue
    }
    const file = insideRun(cwd, token)
    if (file !== undefined) return { file, line }
  }
  return undefined
}
