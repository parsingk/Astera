// What CI's verdict on the pushed head makes of a lifecycle round's `github:ci` check (GitHub lifecycle G3b1, design
// §4.6, §4.7): a pass, a code failure with its evidence, or nothing for a cause outside the code.
import { describe, it, expect } from 'vitest'
import { ciCheckResult } from './ciResult'
import type { GitHubCiFailure } from './lifecycle'

const T0 = '2026-10-18T00:00:00.000Z'
const T1 = '2026-10-18T00:05:00.000Z'
const PR = 'https://github.com/o/r/pull/3'
const failure = (over: Partial<GitHubCiFailure> = {}): GitHubCiFailure => ({
  check: 'test', externalId: 'run:9', class: 'test', summary: 'test (test): not ok 1 - adds',
  diagnostics: [{ path: 'src/add.test.js', line: 5, message: 'AssertionError' }, { message: 'one more' }],
  logExcerpt: '##[group]Run npm test\nnot ok 1 - adds', url: 'https://github.com/o/r/actions/runs/1/job/9', ...over
})

describe('ciCheckResult', () => {
  it('a pass is a passed github:ci check, linked to the pull request', () => {
    expect(ciCheckResult({ verdict: 'passed', prUrl: PR, since: T0, now: T1 })).toEqual({
      configId: 'github:ci', name: 'GitHub CI', status: 'passed', startedAt: T0, endedAt: T1, externalUrl: PR
    })
  })

  it.each(['test', 'build', 'lint', 'typecheck', 'configuration', 'unknown'] as const)('a %s failure is a failed check with its evidence', (cls) => {
    expect(ciCheckResult({ verdict: 'failed', failure: failure({ class: cls }), prUrl: PR, since: T0, now: T1 })).toEqual({
      configId: 'github:ci', name: 'GitHub CI', status: 'failed', startedAt: T0, endedAt: T1,
      summary: 'test (test): not ok 1 - adds',
      diagnostics: [{ file: 'src/add.test.js', line: 5, message: 'AssertionError', severity: 'error' }, { message: 'one more', severity: 'error' }],
      outputTail: '##[group]Run npm test\nnot ok 1 - adds',
      externalUrl: 'https://github.com/o/r/actions/runs/1/job/9'
    })
  })

  // G3b1 final review M5
  it('keeps a warning a warning, and how many diagnostics there were', () => {
    const f = failure({ diagnostics: [{ path: 'a.ts', line: 1, message: 'unused', warning: true }], diagnosticsTotal: 31 })
    expect(ciCheckResult({ verdict: 'failed', failure: f, prUrl: PR, since: T0, now: T1 })).toMatchObject({
      diagnostics: [{ file: 'a.ts', line: 1, message: 'unused', severity: 'warning' }],
      diagnosticsTotal: 31
    })
  })

  it.each(['infrastructure', 'environment', 'timeout', 'cancelled', 'permission'] as const)('a %s failure is no verdict for the repair loop', (cls) => {
    expect(ciCheckResult({ verdict: 'failed', failure: failure({ class: cls }), prUrl: PR, since: T0, now: T1 })).toBeNull()
  })

  it('a failure with no evidence still fails, linked to the pull request; a pending or empty read is no result', () => {
    expect(ciCheckResult({ verdict: 'failed', prUrl: PR, since: T0, now: T1 })).toMatchObject({ status: 'failed', summary: 'GitHub CI failed', externalUrl: PR })
    expect(ciCheckResult({ verdict: 'pending', prUrl: PR, since: T0, now: T1 })).toBeNull()
    expect(ciCheckResult({ verdict: 'none', prUrl: PR, since: T0, now: T1 })).toBeNull()
  })
})
