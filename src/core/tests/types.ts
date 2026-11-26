// A test run's result, whichever reporter wrote it (Phase 3 Part 2, design §5 Part 2 item 2): what the Tests tab, the
// Problems producer and a check's diagnostics read. The parsers (junit.ts, vitestJson.ts) make it; nothing here reads
// a file.
import { createHash } from 'node:crypto'
import { isUnder, relativeTo } from '../context/contextRef'

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

/** A place a failure's text names (`src/a.test.ts:9:21`, `tests\test_x.py:9:`, `at /abs/x.ts:3:1`): the first with a
 *  directory in it that lies inside the run's folder. A bare file name (a Java frame's `(CalcTest.java:20)`) is not
 *  one: nothing says where in the folder it is. */
export function failurePlace(cwd: string, text: string): { file: string; line: number } | undefined {
  const re = /((?:file:\/\/)?(?:\/?[A-Za-z]:)?[^\s:()'"<>`]*[\\/][^\s:()'"<>`]+):(\d+)/g
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const file = insideRun(cwd, m[1])
    const line = Number(m[2])
    if (file !== undefined && Number.isInteger(line) && line > 0) return { file, line }
  }
  return undefined
}
