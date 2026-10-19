// The Run detail's GitHub block (GitHub lifecycle design §8, G7b): the pull request, its checks and where Astera
// stands, with what GitHub itself says beside merge-ready. Static markup: the renderer tests run in node, with no DOM.
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CATALOGS, LANGS } from '../../../core/i18n'
import type { GitHubLifecycleView } from '../../../core/github/view'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'en', t: (key: string, p?: Record<string, unknown>) => (p ? `${key} ${JSON.stringify(p)}` : key) })
}))

const { GitHubBlock, GITHUB_BLOCK_KEYS, checkMarkOf } = await import('./GitHubBlock')
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const PR = { number: 12, url: 'https://github.com/o/r/pull/12', isDraft: false, state: 'open' as const }
const render = (github: GitHubLifecycleView, noLocalCheck = false): string =>
  renderToStaticMarkup(React.createElement(GitHubBlock, { github, noLocalCheck, onOpen: () => {} })).replace(/&quot;/g, '"')

describe('GitHubBlock', () => {
  it('before a pull request, says so and nothing else', () => {
    const html = render({ state: 'unbound' })
    expect(html).toContain('jobs.github.state.unbound')
    expect(html).not.toContain('#12')
  })

  it('shows the pull request with its draft badge, the head, and each check with its state and required mark', () => {
    const html = render({
      state: 'ci-pending',
      pr: { ...PR, isDraft: true },
      headSha: A,
      ci: { sha: A, basis: 'required', verdict: 'pending', checks: [{ name: 'build', status: 'completed', conclusion: 'success', required: true }, { name: 'lint', status: 'in-progress', required: false }] }
    })
    expect(html).toContain('#12')
    expect(html).toContain('github.badge.draft')
    expect(html).toContain('jobs.github.head {"sha":"aaaaaaa"}')
    expect(html).toContain('jobs.github.state.ci-pending')
    expect(html).toContain('build')
    expect(html).toContain('lint')
    expect(html).toContain('jobs.github.required')
  })

  it('a repair says what it repairs and the attempt against the budget', () => {
    const html = render({ state: 'repairing', pr: PR, failing: { check: 'build', class: 'test' }, repair: { attempt: 2, max: 3, subject: { kind: 'ci', check: 'build' } } })
    expect(html).toContain('jobs.github.repairingCheck {"check":"build","attempt":2,"max":3}')
    expect(html).toContain('jobs.github.failingClass {"check":"build","class":"test"}')
    // Final review I1: a local check, the review, or nothing known — never the CI check by default
    expect(render({ state: 'repairing', pr: PR, failing: { check: 'build' }, repair: { attempt: 2, max: 3, subject: { kind: 'local', check: 'Lint' } } })).toContain('jobs.github.repairingLocal {"check":"Lint","attempt":2,"max":3}')
    expect(render({ state: 'repairing', pr: PR, repair: { attempt: 1, max: 3, subject: { kind: 'review' } } })).toContain('jobs.github.repairingReview {"attempt":1,"max":3}')
    expect(render({ state: 'repairing', pr: PR, repair: { attempt: 1, max: 3 } })).toContain('jobs.github.repairingAttempt {"attempt":1,"max":3}')
    expect(render({ state: 'repairing', pr: PR, repair: { attempt: 1, max: 3, subject: { kind: 'ci' } } })).toContain('jobs.github.repairingCi {"attempt":1,"max":3}')
  })

  // Review Focus 3: Astera's verdict and GitHub's own state, side by side
  it('merge-ready says what GitHub says when it disagrees: draft, or its merge state', () => {
    expect(render({ state: 'merge-ready', pr: { ...PR, isDraft: true }, mergeReady: { headSha: A, evaluatedAt: 'T' } })).toContain('jobs.github.githubDraft')
    const blocked = render({ state: 'merge-ready', pr: { ...PR, mergeStateStatus: 'BLOCKED' }, mergeReady: { headSha: A, evaluatedAt: 'T' } })
    expect(blocked).toContain('jobs.github.mergeReady {"sha":"aaaaaaa"}')
    expect(blocked).toContain('jobs.github.mergeState.blocked')
    // Final review M3: GitHub's states in words; the ones that are no disagreement (clean, hooks, still computing) say nothing
    for (const [s, k] of [['BEHIND', 'behind'], ['DIRTY', 'dirty'], ['UNSTABLE', 'unstable']])
      expect(render({ state: 'merge-ready', pr: { ...PR, mergeStateStatus: s }, mergeReady: { headSha: A, evaluatedAt: 'T' } }), s).toContain(`jobs.github.mergeState.${k}`)
    for (const s of ['CLEAN', 'HAS_HOOKS', 'UNKNOWN'])
      expect(render({ state: 'merge-ready', pr: { ...PR, mergeStateStatus: s }, mergeReady: { headSha: A, evaluatedAt: 'T' } }), s).not.toContain('jobs.github.mergeState')
  })

  it('a withdrawn merge-ready says why, an outside head, a base bound again, going on without CI and a changed issue', () => {
    const html = render({
      state: 'ci-pending',
      pr: PR,
      invalidated: { reason: 'head-changed', at: 'T' },
      externalHead: { sha: B, at: 'T' },
      base: { branch: 'main', reboundAt: 'T' },
      noCi: true,
      sourceChanged: true
    })
    expect(html).toContain('jobs.github.invalidated {"reason":"jobs.github.reason.head-changed"}')
    expect(html).toContain('jobs.github.externalHead {"sha":"bbbbbbb"}')
    expect(html).toContain('jobs.github.rebound {"branch":"main"}')
    expect(html).toContain('jobs.github.noCi')
    expect(html).toContain('jobs.github.sourceChanged')
  })

  // Final review M6: checks of a commit that is not the head (just after a push, before the read catches up) say so
  it('says when the checks shown are of another commit than the head', () => {
    const ci = { sha: A, basis: 'required' as const, verdict: 'failed' as const, checks: [{ name: 'build', status: 'completed' as const, conclusion: 'failure' as const, required: true }] }
    expect(render({ state: 'ci-pending', pr: PR, headSha: B, ci })).toContain('jobs.github.ciOtherCommit {"sha":"aaaaaaa"}')
    expect(render({ state: 'ci-failed', pr: PR, headSha: A, ci })).not.toContain('jobs.github.ciOtherCommit')
  })

  // Final review M2: a check's mark from the verdict's own rules
  it('marks a check passed, failed or still going as the verdict reads it', () => {
    for (const c of ['success', 'neutral', 'skipped']) expect(checkMarkOf({ status: 'completed', conclusion: c }), c).toBe('✓')
    for (const c of ['failure', 'cancelled', 'timed-out', 'action-required', 'startup-failure', 'unknown']) expect(checkMarkOf({ status: 'completed', conclusion: c }), c).toBe('✗')
    expect(checkMarkOf({ status: 'completed', conclusion: 'stale' })).toBe('●')
    expect(checkMarkOf({ status: 'in-progress' })).toBe('●')
    expect(checkMarkOf({ status: 'queued' })).toBe('●')
  })

  // Design §7.2 S16
  it('warns when no Task names a local check, and only then', () => {
    expect(render({ state: 'pr-bound', pr: PR }, true)).toContain('jobs.github.noLocalCheck')
    expect(render({ state: 'pr-bound', pr: PR }, false)).not.toContain('jobs.github.noLocalCheck')
  })

  it('its words are in every language, every state included', () => {
    for (const key of GITHUB_BLOCK_KEYS) for (const lang of LANGS) expect((CATALOGS[lang].messages as Record<string, string>)[key], `${lang} ${key}`).toBeTruthy()
  })
})
