import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTestReport, type TestReportFs } from './read'

// Phase 3 Part 2: a run's report found under its folder, a fresh one told from one an earlier run left
const fixture = (name: string): string => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8')
const PASSING = '<testsuite name="s"><testcase classname="a" name="ok" time="0.01"/></testsuite>'
let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'astera-test-report-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('readTestReport', () => {
  it('reads a fresh report as failed or passed', async () => {
    writeFileSync(path.join(dir, 'report.xml'), fixture('vitest-junit.xml'))
    const failed = await readTestReport({ cwd: dir, spec: { format: 'junit-xml', path: 'report.xml' }, sinceMs: Date.now() - 60_000 })
    expect(failed.outcome).toBe('failed')
    expect(failed.report?.cases).toHaveLength(4)
    writeFileSync(path.join(dir, 'ok.xml'), PASSING)
    expect((await readTestReport({ cwd: dir, spec: { format: 'junit-xml', path: 'ok.xml' }, sinceMs: Date.now() - 60_000 })).outcome).toBe('passed')
    mkdirSync(path.join(dir, 'out'))
    writeFileSync(path.join(dir, 'out', 'r.json'), fixture('vitest.json').replaceAll('/work/proj', dir.replace(/\\/g, '/')))
    const json = await readTestReport({ cwd: dir, spec: { format: 'vitest-json', path: 'out/r.json' }, sinceMs: Date.now() - 60_000 })
    expect(json.outcome).toBe('failed')
    expect(json.report?.cases[0].file).toBe('src/math.test.ts')
  })

  it('reads a report older than the run as stale, never passed', async () => {
    const file = path.join(dir, 'ok.xml')
    writeFileSync(file, PASSING)
    const old = new Date(Date.now() - 3_600_000)
    utimesSync(file, old, old)
    const r = await readTestReport({ cwd: dir, spec: { format: 'junit-xml', path: 'ok.xml' }, sinceMs: Date.now() - 1000 })
    expect(r).toMatchObject({ outcome: 'unknown', stale: true })
    expect(r.report?.cases).toHaveLength(1)
  })

  it('reads a folder’s XML files as one report', async () => {
    mkdirSync(path.join(dir, 'reports'))
    writeFileSync(path.join(dir, 'reports', 'TEST-a.xml'), fixture('vitest-junit.xml'))
    writeFileSync(path.join(dir, 'reports', 'TEST-b.xml'), fixture('surefire.xml'))
    writeFileSync(path.join(dir, 'reports', 'notes.txt'), 'not a report')
    const r = await readTestReport({ cwd: dir, spec: { format: 'junit-xml', path: 'reports' }, sinceMs: Date.now() - 60_000 })
    expect(r.outcome).toBe('failed')
    expect(r.report?.cases).toHaveLength(7)
  })

  it('answers unknown for a missing, unreadable, malformed, or too large report, and for a path that leaves the folder', async () => {
    const at = (p: string, fs?: TestReportFs) => readTestReport({ cwd: dir, spec: { format: 'junit-xml', path: p }, sinceMs: Date.now() - 60_000 }, fs)
    expect(await at('none.xml')).toMatchObject({ outcome: 'unknown', reason: 'missing' })
    writeFileSync(path.join(dir, 'bad.xml'), 'this is not xml')
    expect(await at('bad.xml')).toMatchObject({ outcome: 'unknown', reason: 'malformed' })
    expect(await at('../x.xml')).toMatchObject({ outcome: 'unknown', reason: 'outside' })
    const fake = (over: Partial<TestReportFs>): TestReportFs => ({
      stat: async () => ({ isFile: () => true, isDirectory: () => false, size: 10, mtimeMs: Date.now() }),
      readFile: async () => PASSING,
      readdir: async () => [],
      ...over
    })
    expect(await at('r.xml', fake({ readFile: async () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })) }))).toMatchObject({ outcome: 'unknown', reason: 'unreadable' })
    expect(await at('r.xml', fake({ stat: async () => ({ isFile: () => true, isDirectory: () => false, size: 9 * 1024 * 1024, mtimeMs: Date.now() }) }))).toMatchObject({ outcome: 'unknown', reason: 'too-large' })
  })
})
