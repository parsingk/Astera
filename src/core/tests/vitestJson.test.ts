import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseVitestJson } from './vitestJson'
import { parseJunit } from './junit'

// Phase 3 Part 2: a Vitest --reporter=json report (a real one, Vitest 4.1, the run's folder written as /work/proj)
const fixture = (name: string): string => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8')
const CWD = '/work/proj'

describe('parseVitestJson', () => {
  it('reads a Vitest JSON report, pending and todo as skipped, with each failure’s location', () => {
    const r = parseVitestJson(fixture('vitest.json'), CWD)
    expect(r?.framework).toBe('vitest')
    expect(r?.cases.map((c) => [c.file, c.suite, c.name, c.status])).toEqual([
      ['src/math.test.ts', ['math'], 'adds', 'passed'],
      ['src/math.test.ts', ['math', 'nested'], 'subtracts wrongly', 'failed'],
      ['src/math.test.ts', ['math'], 'later', 'skipped'],
      ['src/math.test.ts', [], 'top level & <special> "name"', 'failed']
    ])
    expect(r!.cases[1].failure).toMatchObject({ file: 'src/math.test.ts', line: 9 })
    expect(r!.cases[1].failure?.message.split('\n')[0]).toBe('AssertionError: expected 2 to be 3 // Object.is equality')
    expect(r!.cases[3].failure).toMatchObject({ file: 'src/math.test.ts', line: 16 })
  })

  // Final review C2: Vitest 4.1's JsonReporter writes a file that failed to load, or whose beforeAll threw, as a failed
  // entry with its error in `message` and no failed assertion; that file is a failure, never a pass
  it('reads a file that failed outside its tests as one errored case of that file', () => {
    const report = {
      success: false,
      testResults: [
        { name: '/work/proj/src/ok.test.ts', status: 'passed', message: '', assertionResults: [{ ancestorTitles: [], title: 'works', status: 'passed', failureMessages: [] }] },
        { name: '/work/proj/src/broken.test.ts', status: 'failed', message: 'Failed to load url ./gone', assertionResults: [] },
        { name: '/work/proj/src/hook.test.ts', status: 'failed', message: '', assertionResults: [{ ancestorTitles: ['db'], title: 'reads', status: 'skipped', failureMessages: [] }] },
        { name: '/work/proj/src/real.test.ts', status: 'failed', message: '', assertionResults: [{ ancestorTitles: [], title: 'fails', status: 'failed', failureMessages: ['boom'] }] }
      ]
    }
    const r = parseVitestJson(JSON.stringify(report), CWD)!
    expect(r.cases.map((c) => [c.file, c.suite, c.name, c.status, c.fileLevel ?? false])).toEqual([
      ['src/ok.test.ts', [], 'works', 'passed', false],
      ['src/broken.test.ts', [], 'src/broken.test.ts', 'errored', true],
      ['src/hook.test.ts', ['db'], 'reads', 'skipped', false],
      ['src/hook.test.ts', [], 'src/hook.test.ts', 'errored', true],
      ['src/real.test.ts', [], 'fails', 'failed', false]
    ])
    expect(r.cases[1].failure?.message).toBe('Failed to load url ./gone')
    expect(r.cases[3].failure?.message).toBe('')
  })

  // Final review M12
  it('gives two tests of the same name in one file two ids', () => {
    const same = { ancestorTitles: ['math'], title: 'adds', status: 'passed', failureMessages: [] }
    const r = parseVitestJson(JSON.stringify({ testResults: [{ name: '/work/proj/src/a.test.ts', status: 'passed', message: '', assertionResults: [same, same] }] }), CWD)!
    expect(new Set(r.cases.map((c) => c.id)).size).toBe(2)
  })

  it('gives the same case the same id as the JUnit report of the same run', () => {
    const json = parseVitestJson(fixture('vitest.json'), CWD)!.cases.map((c) => c.id)
    const xml = parseJunit(fixture('vitest-junit.xml'), CWD)!.cases.map((c) => c.id)
    expect(json).toEqual(xml)
  })

  it('reads a todo as skipped, and gives null for JSON that is not a Vitest report', () => {
    const one = JSON.stringify({ testResults: [{ name: '/work/proj/a.test.ts', assertionResults: [{ ancestorTitles: [], title: 'later', status: 'todo', failureMessages: [] }] }] })
    expect(parseVitestJson(one, CWD)?.cases[0]).toMatchObject({ name: 'later', status: 'skipped', file: 'a.test.ts' })
    for (const text of ['', 'nope', '{"a":1}', '[]', '<testsuite/>']) expect(parseVitestJson(text, CWD), text).toBeNull()
  })
})
