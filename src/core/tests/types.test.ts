import { describe, it, expect } from 'vitest'
import { failurePlace } from './types'

// Phase 3 Part 2: the place a failure's text names, inside the run's folder
describe('failurePlace', () => {
  // Final review I3: a profile folder with a space (`C:\Users\First Last`) is common, and the tail after the space is
  // not a relative path in the folder
  it('reads a place under a run folder with a space in it, never the tail after the space', () => {
    const cwd = 'C:/Users/John Smith/proj'
    expect(failurePlace(cwd, 'Error: x\n    at C:/Users/John Smith/proj/src/a.test.ts:9:21')).toEqual({ file: 'src/a.test.ts', line: 9 })
    expect(failurePlace(cwd, 'at Object.<anonymous> (C:\\Users\\john smith\\proj\\src\\my tests\\a.test.ts:4:1)')).toEqual({ file: 'src/my tests/a.test.ts', line: 4 })
    expect(failurePlace('/home/john smith/proj', 'at /home/john smith/proj/src/a.test.ts:3:1')).toEqual({ file: 'src/a.test.ts', line: 3 })
    expect(failurePlace(cwd, 'at C:/Users/Jane Doe/other/x.test.ts:3:1')).toBeUndefined()
    expect(failurePlace('/work/proj', 'at /home/jane doe/src/x.test.ts:3:1')).toBeUndefined()
  })

  // Final review M13
  it('decodes a percent-encoded file URL', () => {
    expect(failurePlace('D:/작업/proj', 'at file:///D:/%EC%9E%91%EC%97%85/proj/src/a.test.ts:7:3')).toEqual({ file: 'src/a.test.ts', line: 7 })
    expect(failurePlace('/work/my proj', 'at file:///work/my%20proj/src/a.test.ts:7:3')).toEqual({ file: 'src/a.test.ts', line: 7 })
  })

  it('reads the relative place pytest writes, and the first place inside the folder', () => {
    expect(failurePlace('/work/proj', 'E  assert 1 == 2\n\ntests\\test_calc.py:9: AssertionError')).toEqual({ file: 'tests/test_calc.py', line: 9 })
    expect(failurePlace('/work/proj', 'at /elsewhere/x.test.ts:3\n at src/b.test.ts:5')).toEqual({ file: 'src/b.test.ts', line: 5 })
    expect(failurePlace('/work/proj', 'at 12:30:45 nothing here')).toBeUndefined()
  })

  // Final review I2: it runs in Electron main and in the Host, on up to 8 MiB of failure text
  it('stays fast on a long run of path characters, a long data URI, and many colons with numbers', () => {
    const started = Date.now()
    expect(failurePlace('/work/proj', `at /work/proj/${'dir/'.repeat(1000)}x`)).toBeUndefined()
    failurePlace('/work/proj', `expected data:image/png;base64,${'A/'.repeat(20_000)} to match`)
    failurePlace('/work/proj', `${'a/b'.repeat(30_000)}:1`)
    failurePlace('/work/proj', ':1'.repeat(50_000))
    expect(Date.now() - started).toBeLessThan(1000)
  })
})
