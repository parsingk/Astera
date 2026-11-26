import { describe, it, expect } from 'vitest'
import type { TestCase, TestRunResult } from '../../../core/tests/model'
import { caseLocation, rerunNote, testTree } from './testTree'

// Phase 3 Part 2: the Tests tab's tree of a result, file > suite > case
const c = (over: Partial<TestCase>): TestCase => ({ id: over.name ?? 'x', suite: [], name: 'x', status: 'passed', ...over })
const result = (cases: TestCase[], cwd = 'D:\\repo\\web'): TestRunResult => ({
  schemaVersion: 1,
  projectPath: 'D:\\repo',
  cwd,
  configId: 'user:1',
  configName: 'unit',
  format: 'junit-xml',
  runId: 'r1',
  startedAt: '2026-11-26T01:00:00.000Z',
  endedAt: '2026-11-26T01:00:05.000Z',
  outcome: 'failed',
  cases,
  counts: { passed: 0, failed: 0, skipped: 0, errored: 0 }
})

describe('testTree', () => {
  it('groups cases by file and suite, failed first, with counts', () => {
    const tree = testTree(
      result([
        c({ file: 'src/a.test.ts', suite: ['math'], name: 'adds' }),
        c({ file: 'src/a.test.ts', suite: ['math'], name: 'subtracts', status: 'failed' }),
        c({ file: 'src/a.test.ts', suite: [], name: 'top', status: 'skipped' }),
        c({ file: 'src/b.test.ts', suite: ['io'], name: 'reads', status: 'errored' })
      ])
    )
    // A file with a failure first, then the others
    expect(tree.map((n) => [n.kind, n.label, n.counts.failed + n.counts.errored])).toEqual([
      ['file', 'src/a.test.ts', 1],
      ['file', 'src/b.test.ts', 1]
    ])
    const a = tree[0]
    expect(a.counts).toEqual({ passed: 1, failed: 1, skipped: 1, errored: 0 })
    expect(a.children?.map((n) => [n.kind, n.label])).toEqual([
      ['suite', 'math'],
      ['case', 'top']
    ])
    expect(a.children?.[0].children?.map((n) => n.label)).toEqual(['subtracts', 'adds'])
  })

  it('puts a case with no file under its suite alone', () => {
    const tree = testTree(result([c({ suite: ['com.example.CalcTest'], name: 'divides', status: 'errored' }), c({ suite: ['com.example.CalcTest'], name: 'adds' })]))
    expect(tree.map((n) => [n.kind, n.label])).toEqual([['suite', 'com.example.CalcTest']])
    expect(tree[0].children?.map((n) => n.label)).toEqual(['divides', 'adds'])
  })
})

describe('caseLocation', () => {
  it('places a failure under the run’s folder with its separators, and nothing without a file', () => {
    expect(caseLocation(result([]), c({ failure: { message: 'm', file: 'src/a.test.ts', line: 9 } }))).toEqual({ path: 'D:\\repo\\web\\src\\a.test.ts', line: 9 })
    expect(caseLocation(result([], '/home/u/repo'), c({ file: 'src/a.test.ts' }))).toEqual({ path: '/home/u/repo/src/a.test.ts' })
    expect(caseLocation(result([]), c({}))).toBeNull()
  })
})

// Final review M14: the toast says why a rerun of the failures ran less narrowly, not one sentence for every reason
describe('rerunNote', () => {
  it('names each reason a rerun of the failures ran by files or whole', () => {
    expect(rerunNote('failures', undefined)).toBeNull()
    expect(rerunNote('files', 'unsafe-names')).toBe('tests.scope.files')
    expect(rerunNote('files', 'file-level')).toBe('tests.scope.filesFileLevel')
    expect(rerunNote('files', 'package-manager')).toBe('tests.scope.filesPackageManager')
    expect(rerunNote('files', 'too-long')).toBe('tests.scope.filesTooLong')
    expect(rerunNote('all', 'not-narrowable')).toBe('tests.scope.all')
    expect(rerunNote('all', undefined)).toBe('tests.scope.all')
    expect(rerunNote('all', 'unsafe-names')).toBe('tests.scope.allUnsafe')
    expect(rerunNote('all', 'package-manager')).toBe('tests.scope.allPackageManager')
    expect(rerunNote('all', 'too-long')).toBe('tests.scope.allTooLong')
  })
})
