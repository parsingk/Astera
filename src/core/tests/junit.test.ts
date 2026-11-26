import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseJunit } from './junit'
import { TEST_BOUNDS } from './types'

// Phase 3 Part 2: a JUnit XML report as one result. The fixtures are real reports (Vitest 4.1 --reporter=junit, pytest 9
// --junitxml in both families) with the run's folder written as /work/proj; the Surefire one is shaped by hand.
const fixture = (name: string): string => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8')
const CWD = '/work/proj'

describe('parseJunit', () => {
  it('reads each case of a Vitest JUnit report with its suite, status, time and failure line', () => {
    const r = parseJunit(fixture('vitest-junit.xml'), CWD)
    expect(r?.framework).toBe('vitest')
    expect(r?.cases.map((c) => [c.file, c.suite, c.name, c.status])).toEqual([
      ['src/math.test.ts', ['math'], 'adds', 'passed'],
      ['src/math.test.ts', ['math', 'nested'], 'subtracts wrongly', 'failed'],
      ['src/math.test.ts', ['math'], 'later', 'skipped'],
      ['src/math.test.ts', [], 'top level & <special> "name"', 'failed']
    ])
    const failed = r!.cases[1]
    expect(failed.durationMs).toBe(4)
    expect(failed.failure).toMatchObject({ file: 'src/math.test.ts', line: 9 })
    expect(failed.failure?.message.split('\n')[0]).toBe('expected 2 to be 3 // Object.is equality')
    expect(r!.cases[3].failure).toMatchObject({ file: 'src/math.test.ts', line: 16 })
  })

  it('reads a pytest report’s node, class and file', () => {
    const r = parseJunit(fixture('pytest.xml'), CWD)
    expect(r?.framework).toBe('pytest')
    expect(r?.cases.map((c) => [c.name, c.status])).toEqual([
      ['test_adds', 'passed'],
      ['test_divides', 'failed'],
      ['test_later', 'skipped'],
      ['test_same[1-2]', 'failed'],
      ['test_same[2-2]', 'passed'],
      ['test_uses_broken', 'errored']
    ])
    const divides = r!.cases[1]
    expect(divides.suite).toEqual(['tests.test_calc'])
    // pytest writes the failure's place with backslashes on Windows, and the case's file nowhere else in this family
    expect(divides.file).toBe('tests/test_calc.py')
    expect(divides.failure).toMatchObject({ file: 'tests/test_calc.py', line: 9 })
    expect(divides.failure?.message.split('\n')[0]).toBe('assert (10 / 4) == 2')
    expect(r!.cases[5].failure?.message.split('\n')[0]).toBe('failed on setup with "RuntimeError: fixture failed"')
    // xunit1 writes the file on every case, and a line that counts from 0; the failure's own line is the one kept
    const x1 = parseJunit(fixture('pytest-xunit1.xml'), CWD)
    expect(x1?.cases[0]).toMatchObject({ name: 'test_adds', file: 'tests/test_calc.py' })
    expect(x1?.cases[1].failure).toMatchObject({ file: 'tests/test_calc.py', line: 9 })
  })

  it('reads a Surefire report’s errors as errored and skipped as skipped', () => {
    const r = parseJunit(fixture('surefire.xml'), CWD)
    expect(r?.framework).toBe('junit')
    expect(r?.cases.map((c) => [c.suite, c.name, c.status])).toEqual([
      [['com.example.CalcTest'], 'adds', 'passed'],
      [['com.example.CalcTest'], 'divides', 'errored'],
      [['com.example.CalcTest'], 'later', 'skipped']
    ])
    // A stack frame's bare file name is no place in the folder
    expect(r!.cases[1].failure).toEqual({ message: expect.stringMatching(/^\/ by zero\n/) })
  })

  it('gives null for text that is not a report of the format', () => {
    for (const text of ['', 'not xml at all', '<html><body><p>hi</p></body></html>', '{"testResults":[]}']) expect(parseJunit(text, CWD), text).toBeNull()
  })

  it('ignores a DOCTYPE and its entities, decoding only the five named and numeric references', () => {
    const xml = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "AAAA"><!ENTITY b "&a;&a;&a;">]><testsuite name="s"><testcase name="t &b; &#65;&#x42; &amp;&lt;&gt;&quot;&apos;"/></testsuite>'
    expect(parseJunit(xml, CWD)?.cases[0].name).toBe(`t &b; AB &<>"'`)
  })

  it('survives deep nesting and binary bytes without hanging', () => {
    const deep = `<testsuite name="s">${'<a>'.repeat(20000)}<testcase name="x"/>${'</a>'.repeat(20000)}</testsuite>`
    const started = Date.now()
    expect(parseJunit(deep, CWD)?.cases.map((c) => c.name)).toEqual(['x'])
    expect(parseJunit(`<testsuite name="s"><testcase name="${String.fromCharCode(0, 1, 2)}"/></testsuite>${String.fromCharCode(0xfffd)}`, CWD)?.cases).toHaveLength(1)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('keeps 5000 cases and says it cut', () => {
    const xml = `<testsuite name="s">${Array.from({ length: TEST_BOUNDS.cases + 3 }, (_, i) => `<testcase name="t${i}"/>`).join('')}</testsuite>`
    const r = parseJunit(xml, CWD)
    expect(r?.cases).toHaveLength(5000)
    expect(r?.truncated).toBe(true)
  })

  it('cuts a failure message to 2000 characters', () => {
    const r = parseJunit(`<testsuite name="s"><testcase name="t"><failure message="m">${'x'.repeat(10000)}</failure></testcase></testsuite>`, CWD)
    expect(r!.cases[0].failure!.message.length).toBeLessThanOrEqual(TEST_BOUNDS.message)
  })

  it('writes a location inside the folder relative to it, and drops one outside it, a backslash path and a file URL included', () => {
    const at = (body: string) => parseJunit(`<testsuite name="s"><testcase name="t"><failure>${body}</failure></testcase></testsuite>`, CWD)!.cases[0].failure
    expect(at('boom\n at file:///work/proj/src/b.test.ts:7:3')).toMatchObject({ file: 'src/b.test.ts', line: 7 })
    expect(at('boom\n at src\\c.test.ts:4')).toMatchObject({ file: 'src/c.test.ts', line: 4 })
    expect(at('boom\n at /elsewhere/x.test.ts:3:1')?.file).toBeUndefined()
    expect(at('boom\n at ..\\..\\x.test.ts:3')?.file).toBeUndefined()
  })

  it('gives a case the same id in the next run, and two cases two ids', () => {
    const a = parseJunit(fixture('vitest-junit.xml'), CWD)!.cases
    const b = parseJunit(fixture('vitest-junit.xml'), CWD)!.cases
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id))
    expect(new Set(a.map((c) => c.id)).size).toBe(a.length)
    expect(a[0].id).toMatch(/^[0-9a-f]{12}$/)
  })
})
