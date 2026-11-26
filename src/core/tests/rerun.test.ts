import { describe, it, expect } from 'vitest'
import type { RunConfig } from '../run/types'
import type { TestCase, TestRunResult } from './model'
import { rerunArgs } from './rerun'

// Phase 3 Part 2: what a rerun of only the failures adds to a configuration's command. Measured 2026-11-26: npm needs
// `--` before a script's arguments, pnpm 9 forwards a `--` literally (so none is added), yarn 1 forwards with or
// without it; bun was not measured (not installed), so a bun script reruns whole.
const fail = (over: Partial<TestCase>): TestCase => ({ id: 'x', suite: [], name: 't', status: 'failed', ...over })
const result = (format: TestRunResult['format'], cases: TestCase[]): TestRunResult => ({
  schemaVersion: 1,
  projectPath: '/p',
  cwd: '/p',
  configId: 'user:1',
  configName: 'unit',
  format,
  runId: 'r1',
  startedAt: '2026-11-26T01:00:00.000Z',
  endedAt: '2026-11-26T01:00:05.000Z',
  outcome: 'failed',
  cases,
  counts: { passed: 0, failed: cases.length, skipped: 0, errored: 0 }
})
const pytest = { id: 'user:1', name: 'unit', type: 'pytest', interpreter: 'python' } as RunConfig
const node = { id: 'user:1', name: 'unit', type: 'node', file: 'node_modules/vitest/vitest.mjs', args: 'run' } as RunConfig
const npm = { id: 'user:1', name: 'unit', type: 'npm', script: 'test' } as RunConfig
const linux = { platform: 'linux', packageManager: 'npm' as const }
const win = { platform: 'win32', packageManager: 'npm' as const }

describe('rerunArgs', () => {
  it('narrows a pytest configuration to its failing node ids', () => {
    const r = rerunArgs(
      pytest,
      result('junit-xml', [
        fail({ file: 'tests/test_calc.py', suite: ['tests.test_calc'], name: 'test_divides' }),
        fail({ file: 'tests/test_calc.py', suite: ['tests.test_calc.TestSame'], name: 'test_same[1-2]', status: 'errored' }),
        { id: 'p', file: 'tests/test_calc.py', suite: ['tests.test_calc'], name: 'test_adds', status: 'passed' }
      ]),
      linux
    )
    expect(r).toEqual({ append: ' tests/test_calc.py::test_divides tests/test_calc.py::TestSame::test_same[1-2]', scope: 'failures' })
  })

  it('narrows a Vitest run to its failing files and their full names', () => {
    const cases = [fail({ file: 'src/a.test.ts', suite: ['math', 'nested'], name: 'subtracts' }), fail({ file: 'src/a.test.ts', suite: [], name: 'x (y)' })]
    expect(rerunArgs(node, result('vitest-json', cases), linux)).toEqual({ append: " src/a.test.ts -t 'math nested subtracts|x \\(y\\)'", scope: 'failures' })
    expect(rerunArgs(node, result('vitest-json', cases), win)).toEqual({ append: ' src/a.test.ts -t "math nested subtracts|x \\(y\\)"', scope: 'failures' })
  })

  it('adds -- for an npm script, and for yarn, pnpm or bun only as measured', () => {
    const cases = [fail({ file: 'src/a.test.ts', name: 'adds' })]
    expect(rerunArgs(npm, result('vitest-json', cases), linux)).toEqual({ append: ' -- src/a.test.ts -t adds', scope: 'failures' })
    expect(rerunArgs(npm, result('vitest-json', cases), { platform: 'linux', packageManager: 'pnpm' })).toEqual({ append: ' src/a.test.ts -t adds', scope: 'failures' })
    expect(rerunArgs(npm, result('vitest-json', cases), { platform: 'linux', packageManager: 'yarn' })).toEqual({ append: ' src/a.test.ts -t adds', scope: 'failures' })
    expect(rerunArgs(npm, result('vitest-json', cases), { platform: 'linux', packageManager: 'bun' })).toEqual({ append: '', scope: 'all', why: 'package-manager' })
  })

  it('narrows to files only when a name carries a quote, a percent sign, an exclamation mark, or a line break', () => {
    for (const name of ['say "hi"', '100%', 'wow!', 'two\nlines']) {
      const r = rerunArgs(node, result('vitest-json', [fail({ file: 'src/a.test.ts', name }), fail({ file: 'src/b.test.ts', name: 'ok' })]), win)
      expect(r, name).toEqual({ append: ' src/a.test.ts src/b.test.ts', scope: 'files', why: 'unsafe-names' })
    }
    expect(rerunArgs(pytest, result('junit-xml', [fail({ file: 'tests/t.py', suite: ['tests.t'], name: 'test_x["a"]' })]), linux)).toEqual({ append: ' tests/t.py', scope: 'files', why: 'unsafe-names' })
  })

  it('quotes paths with spaces and Hangul for cmd and for sh', () => {
    const cases = [fail({ file: 'src/한글 테스트.test.ts', name: 'adds' })]
    expect(rerunArgs(node, result('vitest-json', cases), win).append).toBe(' "src/한글 테스트.test.ts" -t adds')
    expect(rerunArgs(node, result('vitest-json', cases), linux).append).toBe(" 'src/한글 테스트.test.ts' -t adds")
  })

  // Final review C2: a file that failed to load or whose hook threw has no test name to filter by
  it('reruns a file that failed outside its tests by its files, never by a name', () => {
    const cases = [fail({ file: 'src/a.test.ts', name: 'adds' }), fail({ file: 'src/broken.test.ts', name: 'src/broken.test.ts', status: 'errored', fileLevel: true })]
    expect(rerunArgs(node, result('vitest-json', cases), linux)).toEqual({ append: ' src/a.test.ts src/broken.test.ts', scope: 'files', why: 'file-level' })
    expect(rerunArgs(npm, result('vitest-json', cases), linux)).toEqual({ append: ' -- src/a.test.ts src/broken.test.ts', scope: 'files', why: 'file-level' })
  })

  // Final review M2, measured 2026-11-26 on cmd: pnpm 9.15.9 doubles each backslash it forwards (pnpm 12.11.2, npm and
  // yarn 1.22.22 do not), so an escaped name filter would match nothing
  it('narrows a pnpm script on Windows to its files when the name filter holds a backslash', () => {
    const pnpmWin = { platform: 'win32', packageManager: 'pnpm' as const }
    expect(rerunArgs(npm, result('vitest-json', [fail({ file: 'src/a.test.ts', name: 'x (y)' })]), pnpmWin)).toEqual({ append: ' src/a.test.ts', scope: 'files', why: 'package-manager' })
    expect(rerunArgs(npm, result('vitest-json', [fail({ file: 'src/a.test.ts', name: 'adds' })]), pnpmWin)).toEqual({ append: ' src/a.test.ts -t adds', scope: 'failures' })
    expect(rerunArgs(npm, result('vitest-json', [fail({ file: 'src/a.test.ts', name: 'x (y)' })]), { platform: 'linux', packageManager: 'pnpm' }).scope).toBe('failures')
  })

  it('narrows to files when a name carries a dollar sign or a backtick, which a shell may expand inside double quotes', () => {
    for (const name of ['costs $5', 'runs `cmd`']) {
      expect(rerunArgs(node, result('vitest-json', [fail({ file: 'src/a.test.ts', name })]), linux), name).toEqual({ append: ' src/a.test.ts', scope: 'files', why: 'unsafe-names' })
    }
  })

  // Final review M3: the hint's `-- --reporter=json` for an npm script already ends npm's own arguments
  it('adds no second -- after an npm configuration’s own', () => {
    const own = { ...npm, args: '-- --reporter=json --outputFile=r.json' } as RunConfig
    expect(rerunArgs(own, result('vitest-json', [fail({ file: 'src/a.test.ts', name: 'adds' })]), linux)).toEqual({ append: ' src/a.test.ts -t adds', scope: 'failures' })
  })

  // Final review M4: appended text would reach the last command of a list or a pipe, not Vitest
  it('reruns a shell configuration whose command holds an operator whole', () => {
    const cases = [fail({ file: 'src/a.test.ts', name: 'adds' })]
    for (const command of ['npm run build && vitest run --reporter=json', 'vitest run --reporter=json; echo done', 'vitest run --reporter=json | tee out.txt']) {
      const sh = { id: 'user:1', name: 'unit', type: 'shell', command } as RunConfig
      expect(rerunArgs(sh, result('vitest-json', cases), linux), command).toEqual({ append: '', scope: 'all', why: 'not-narrowable' })
    }
    const plain = { id: 'user:1', name: 'unit', type: 'shell', command: 'npx vitest run --reporter=json' } as RunConfig
    expect(rerunArgs(plain, result('vitest-json', cases), linux).scope).toBe('failures')
  })

  // Final review I5: cmd refuses a command line over 8191 characters
  it('falls back to files, then to the whole configuration, when the added text would be too long for cmd', () => {
    const many = Array.from({ length: 200 }, (_, i) => fail({ file: 'src/a.test.ts', name: `a fairly ordinary test name number ${i}` }))
    expect(rerunArgs(node, result('vitest-json', many), win)).toEqual({ append: ' src/a.test.ts', scope: 'files', why: 'too-long' })
    expect(rerunArgs(node, result('vitest-json', many), linux).scope).toBe('failures')
    const files = Array.from({ length: 300 }, (_, i) => fail({ file: `src/feature-${i}/some/deeper/folder/a.test.ts`, name: 't' }))
    expect(rerunArgs(node, result('vitest-json', files), win)).toEqual({ append: '', scope: 'all', why: 'too-long' })
    const nodes = Array.from({ length: 300 }, (_, i) => fail({ file: 'tests/test_calc.py', suite: ['tests.test_calc'], name: `test_a_fairly_ordinary_name_${i}` }))
    expect(rerunArgs(pytest, result('junit-xml', nodes), win)).toEqual({ append: ' tests/test_calc.py', scope: 'files', why: 'too-long' })
  })

  it('reruns a configuration it cannot narrow whole, saying so', () => {
    const gradle = { id: 'user:1', name: 'unit', type: 'gradle', tasks: 'test' } as RunConfig
    expect(rerunArgs(gradle, result('junit-xml', [fail({ file: 'A.java', name: 't' })]), linux)).toEqual({ append: '', scope: 'all', why: 'not-narrowable' })
    // A pytest target already names what runs; an added node id would run beside it
    expect(rerunArgs({ ...pytest, target: 'tests' } as RunConfig, result('junit-xml', [fail({ file: 'tests/t.py', suite: ['tests.t'], name: 'test_x' })]), linux)).toEqual({ append: '', scope: 'all', why: 'not-narrowable' })
    // A JUnit report from Vitest says nothing of a name filter it can take
    expect(rerunArgs(node, result('junit-xml', [fail({ file: 'src/a.test.ts', name: 'adds' })]), linux)).toEqual({ append: '', scope: 'all', why: 'not-narrowable' })
    // A case with no file cannot be named
    expect(rerunArgs(pytest, result('junit-xml', [fail({ suite: ['tests.t'], name: 'test_x' })]), linux)).toEqual({ append: '', scope: 'all', why: 'not-narrowable' })
    // Nothing failed: the whole configuration
    expect(rerunArgs(node, result('vitest-json', []), linux)).toEqual({ append: '', scope: 'all', why: 'not-narrowable' })
  })
})
