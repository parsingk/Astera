// Whether a PR head's CI passed, failed or still runs (GitHub lifecycle L3, §4.4, self-review S1).
import { describe, it, expect } from 'vitest'
import type { GhRunner } from './gh'
import type { GitHubCiCheck } from './lifecycle'
import { evaluateCi, parseRuleCheckNames, readRuleCheckNames } from './ciVerdict'

const check = (name: string, over: Partial<GitHubCiCheck> = {}): GitHubCiCheck => ({
  externalId: `run:${name}`, name, status: 'completed', conclusion: 'success', required: false, ...over
})
const done = [{ app: 'github-actions', completed: true }]
const running = [{ app: 'github-actions', completed: false }]
const REQUIRED = { mode: 'required' as const }

describe('evaluateCi — required', () => {
  it('decides by the checks GitHub marks required, ignoring an optional failure', () => {
    const ev = evaluateCi({ checks: [check('build', { required: true }), check('docs', { conclusion: 'failure' })], suites: done }, REQUIRED, [])
    expect(ev).toEqual({ basis: 'required', verdict: 'passed' })
  })

  it('fails on a required failure and names it', () => {
    const ev = evaluateCi({ checks: [check('build', { required: true, conclusion: 'failure' })], suites: done }, REQUIRED, [])
    expect(ev.verdict).toBe('failed')
    expect(ev.failing?.name).toBe('build')
  })

  it('waits for a required name from the rules that has not reported yet', () => {
    const ev = evaluateCi({ checks: [check('build')], suites: done }, REQUIRED, ['build', 'e2e'])
    expect(ev).toEqual({ basis: 'required', verdict: 'pending' })
  })

  it('counts skipped and neutral required checks as passing, as branch protection does', () => {
    const ev = evaluateCi({ checks: [check('a', { required: true, conclusion: 'skipped' }), check('b', { required: true, conclusion: 'neutral' })], suites: done }, REQUIRED, [])
    expect(ev.verdict).toBe('passed')
  })
})

describe('evaluateCi — all reported (no required checks)', () => {
  it('is none when the commit has no check at all', () => {
    expect(evaluateCi({ checks: [], suites: [] }, REQUIRED, [])).toEqual({ basis: 'all-reported', verdict: 'none' })
  })

  it('passes when every check passed and every suite is done', () => {
    expect(evaluateCi({ checks: [check('a'), check('b', { conclusion: 'skipped' })], suites: done }, REQUIRED, []).verdict).toBe('passed')
  })

  // Self-review S1: a running workflow can still add checks
  it('waits while a suite still runs, even if every check so far is green', () => {
    expect(evaluateCi({ checks: [check('a')], suites: running }, REQUIRED, []).verdict).toBe('pending')
  })

  it('waits for a queued or stale check', () => {
    expect(evaluateCi({ checks: [check('a', { status: 'queued', conclusion: undefined })], suites: done }, REQUIRED, []).verdict).toBe('pending')
    expect(evaluateCi({ checks: [check('a', { conclusion: 'stale' })], suites: done }, REQUIRED, []).verdict).toBe('pending')
  })

  it('names the failure that completed first', () => {
    const ev = evaluateCi(
      { checks: [check('late', { conclusion: 'failure', completedAt: '2026-10-18T00:05:00Z' }), check('early', { conclusion: 'timed-out', completedAt: '2026-10-18T00:01:00Z' })], suites: done },
      REQUIRED,
      []
    )
    expect(ev.failing?.name).toBe('early')
  })

  it('fails when a workflow could not run, however green the other checks are', () => {
    const broken = check('.github/workflows/ci.yml', { externalId: 'suite:7', conclusion: 'failure' })
    const ev = evaluateCi({ checks: [check('lint'), broken], suites: done }, REQUIRED, [])
    expect(ev).toEqual({ basis: 'all-reported', verdict: 'failed', failing: broken })
  })

  it('passes when every check was skipped', () => {
    expect(evaluateCi({ checks: [check('a', { conclusion: 'skipped' })], suites: done }, REQUIRED, []).verdict).toBe('passed')
  })
})

describe('evaluateCi — selected', () => {
  const SELECTED = { mode: 'selected' as const, selectedChecks: ['build'] }
  it('decides by the selected names only', () => {
    expect(evaluateCi({ checks: [check('build'), check('docs', { conclusion: 'failure' })], suites: done }, SELECTED, ['e2e'])).toEqual({ basis: 'selected', verdict: 'passed' })
  })
  it('waits for a selected name that has not reported', () => {
    expect(evaluateCi({ checks: [check('docs')], suites: done }, SELECTED, []).verdict).toBe('pending')
  })
})

describe('evaluateCi — what it cannot know never passes (final review C1, I2, M1)', () => {
  const green = { checks: [check('build')], suites: done }
  it('required mode with branch rules that could not be read: pending, not passed; a failure still fails', () => {
    expect(evaluateCi(green, REQUIRED, null)).toEqual({ basis: 'all-reported', verdict: 'pending' })
    expect(evaluateCi({ checks: [check('build', { conclusion: 'failure' })], suites: done }, REQUIRED, null).verdict).toBe('failed')
  })
  it('required mode with required-ness unknown for some check: pending', () => {
    expect(evaluateCi({ ...green, requiredUnknown: true }, REQUIRED, []).verdict).toBe('pending')
  })
  it('selected mode does not care whether required-ness or the rules are known', () => {
    const SELECTED = { mode: 'selected' as const, selectedChecks: ['build'] }
    expect(evaluateCi({ ...green, requiredUnknown: true }, SELECTED, null).verdict).toBe('passed')
  })
  it('a read that ran past its page cannot pass in any mode', () => {
    expect(evaluateCi({ ...green, truncated: true }, REQUIRED, []).verdict).toBe('pending')
    expect(evaluateCi({ ...green, truncated: true }, { mode: 'selected', selectedChecks: ['build'] }, []).verdict).toBe('pending')
  })
})

describe('branch rules', () => {
  it('reads the required status checks of the rules that apply', () => {
    const rules = [
      { type: 'pull_request', parameters: {} },
      { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'build' }, { context: 'test', integration_id: 15368 }] } },
      { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'build' }] } }
    ]
    expect(parseRuleCheckNames(JSON.stringify(rules))).toEqual(['build', 'test'])
    expect(parseRuleCheckNames('[]')).toEqual([])
    expect(parseRuleCheckNames('{}')).toBeNull()
  })

  // Measured on a private repository of a free account (2026-10-18): rulesets are not offered there at all
  it('reads a plan without rulesets (403 "Upgrade to GitHub Pro") as no rules, and any other 403 as a failure', async () => {
    const plan: GhRunner = async () => ({ ok: false, stdout: '', stderr: 'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)', exitCode: 1 })
    expect(await readRuleCheckNames(plan, '/wt', { host: 'github.com', owner: 'o', name: 'r' }, 'main')).toEqual({ ok: true, names: [] })
    const denied: GhRunner = async () => ({ ok: false, stdout: '', stderr: 'gh: Resource not accessible by integration (HTTP 403)', exitCode: 1 })
    expect((await readRuleCheckNames(denied, '/wt', { host: 'github.com', owner: 'o', name: 'r' }, 'main')).ok).toBe(false)
  })

  it('asks for the branch, slashes kept and other characters encoded', async () => {
    const calls: string[][] = []
    const run: GhRunner = async (args) => (calls.push(args), { ok: true, stdout: '[]', stderr: '' })
    await readRuleCheckNames(run, '/wt', { host: 'github.com', owner: 'o', name: 'r' }, 'release/1.4#x')
    expect(calls[0]).toEqual(['api', 'repos/o/r/rules/branches/release/1.4%23x'])
  })
})
