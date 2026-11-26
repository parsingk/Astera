// A run's test report found under its folder (Phase 3 Part 2): a file, or a folder of `*.xml`, relative to the run's
// working directory and inside it. A report the run did not write (older than the run) is stale, and nothing here ever
// calls a run passed without a fresh report that parsed and failed no case (design §2: a disappearance is no verdict).
import { promises as nodeFs } from 'node:fs'
import path from 'node:path'
import { isUnder } from '../context/contextRef'
import { testReportPathRefusal, type TestReportSpec } from '../run/types'
import { parseJunit } from './junit'
import { TEST_BOUNDS, type ParsedReport, type TestCase } from './types'
import { parseVitestJson } from './vitestJson'

/** The file system calls the reader makes, so a test can stand in for the ones a real folder cannot show. */
export interface TestReportFs {
  stat(p: string): Promise<{ isFile(): boolean; isDirectory(): boolean; size: number; mtimeMs: number }>
  readFile(p: string): Promise<string>
  readdir(p: string): Promise<string[]>
}

const realFs: TestReportFs = {
  stat: (p) => nodeFs.stat(p),
  readFile: (p) => nodeFs.readFile(p, 'utf8'),
  readdir: (p) => nodeFs.readdir(p)
}

export type ReportReason = 'missing' | 'unreadable' | 'malformed' | 'too-large' | 'outside' | 'empty'

/** What a run's report says. `passed` only for a fresh report that parsed, has cases, and failed none; a stale one is
 *  `unknown` with its cases, for the Tests tab to show as the earlier run's. */
export interface ReadReport {
  outcome: 'passed' | 'failed' | 'unknown'
  report?: ParsedReport
  stale?: true
  reason?: ReportReason
}

const unknown = (reason: ReportReason): ReadReport => ({ outcome: 'unknown', reason })

/** Read with the run's start, `sinceMs`: a file whose last write is before it is a report an earlier run left. */
export async function readTestReport(a: { cwd: string; spec: TestReportSpec; sinceMs: number }, fs: TestReportFs = realFs): Promise<ReadReport> {
  if (testReportPathRefusal(a.spec.path) !== null) return unknown('outside')
  const target = path.resolve(a.cwd, a.spec.path)
  if (!isUnder(a.cwd, target)) return unknown('outside')
  let files: { path: string; mtimeMs: number }[]
  try {
    const st = await fs.stat(target)
    if (st.isFile()) {
      if (st.size > TEST_BOUNDS.fileBytes) return unknown('too-large')
      files = [{ path: target, mtimeMs: st.mtimeMs }]
    } else if (st.isDirectory() && a.spec.format === 'junit-xml') {
      const names = (await fs.readdir(target)).filter((n) => n.toLowerCase().endsWith('.xml')).sort()
      if (names.length > TEST_BOUNDS.folderFiles) return unknown('too-large')
      files = []
      let total = 0
      for (const n of names) {
        const p = path.join(target, n)
        const s = await fs.stat(p)
        if (!s.isFile()) continue
        total += s.size
        if (s.size > TEST_BOUNDS.fileBytes || total > TEST_BOUNDS.folderBytes) return unknown('too-large')
        files.push({ path: p, mtimeMs: s.mtimeMs })
      }
      if (files.length === 0) return unknown('missing')
    } else return unknown('missing')
  } catch (e) {
    return unknown((e as { code?: unknown }).code === 'ENOENT' ? 'missing' : 'unreadable')
  }
  // A folder the run rewrote in part keeps reports of tests that did not run: only the ones it wrote count then
  const fresh = files.filter((f) => f.mtimeMs + 1 >= a.sinceMs)
  const stale = fresh.length === 0
  const cases: TestCase[] = []
  let truncated = false
  let framework: ParsedReport['framework']
  let parsed = 0
  for (const f of stale ? files : fresh) {
    let text: string
    try {
      text = await fs.readFile(f.path)
    } catch {
      return unknown('unreadable')
    }
    const r = a.spec.format === 'junit-xml' ? parseJunit(text, a.cwd) : parseVitestJson(text, a.cwd)
    if (r === null) continue
    parsed++
    framework ??= r.framework
    if (r.truncated) truncated = true
    for (const c of r.cases) {
      if (cases.length >= TEST_BOUNDS.cases) {
        truncated = true
        break
      }
      cases.push(c)
    }
  }
  if (parsed === 0) return unknown('malformed')
  const report: ParsedReport = { ...(framework !== undefined ? { framework } : {}), cases, ...(truncated ? { truncated: true as const } : {}) }
  if (stale) return { outcome: 'unknown', report, stale: true }
  if (cases.length === 0) return { outcome: 'unknown', report, reason: 'empty' }
  return { outcome: cases.some((c) => c.status === 'failed' || c.status === 'errored') ? 'failed' : 'passed', report }
}
