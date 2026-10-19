// The GitHub lifecycle's field in New Job and in issue → Job (GitHub lifecycle design §8, G7a): off by default, the
// folder checked before the Job is made, the defaults the Job will take said beside it. Static markup and pure
// functions: the renderer tests run in node, with no DOM.
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CATALOGS, LANGS } from '../../../core/i18n'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'en', t: (key: string, p?: Record<string, unknown>) => (p ? `${key} ${JSON.stringify(p)}` : key) })
}))

const { LifecycleField, currentPreflight, lifecycleBlocksCreate, preflightOf } = await import('./LifecycleField')
type Props = React.ComponentProps<typeof LifecycleField>

/** The markup with its quotes as the mocked `t` wrote them. */
const render = (over: Partial<Props> = {}): string =>
  renderToStaticMarkup(React.createElement(LifecycleField, { checked: false, onChange: () => {}, preflight: null, defaults: null, ...over })).replace(/&quot;/g, '"')
const DEFAULTS = { autoRerunInfrastructureFailures: true, maxInfrastructureReruns: 2, ciWaitMinutes: 90 }

describe('LifecycleField', () => {
  it('off: the box and what it does, nothing about the folder', () => {
    const html = render()
    expect(html).toContain('jobs.new.github')
    expect(html).toContain('jobs.new.githubHint')
    expect(html).not.toContain('jobs.new.githubChecking')
    expect(html).not.toContain('jobs.new.githubDefaults')
  })

  it('on: the folder check as it stands, and the defaults the Job will take', () => {
    expect(render({ checked: true, preflight: { kind: 'checking' } })).toContain('jobs.new.githubChecking')
    expect(render({ checked: true, preflight: { kind: 'ok', repo: 'o/r' } })).toContain('jobs.new.githubOk {"repo":"o/r"}')
    const refused = render({ checked: true, preflight: { kind: 'refused', reason: 'origin is not a GitHub repository' } })
    expect(refused).toContain('jobs.new.githubRefused {"reason":"origin is not a GitHub repository"}')
    expect(refused).toContain('warn-text')
    expect(render({ checked: true, preflight: { kind: 'failed', message: 'down' } })).toContain('jobs.new.githubFailed {"message":"down"}')
    expect(render({ checked: true, defaults: DEFAULTS })).toContain('jobs.new.githubDefaults {"reruns":2,"minutes":90}')
    expect(render({ checked: true, defaults: { ...DEFAULTS, autoRerunInfrastructureFailures: false } })).toContain('jobs.new.githubDefaultsNoRerun {"minutes":90}')
    // A paired Runtime makes the Job with its own Settings, which this computer cannot read
    expect(render({ checked: true, defaults: 'runtime' })).toContain('jobs.new.githubDefaultsRuntime')
  })
})

describe('preflightOf', () => {
  it('reads the Host’s answer: the repository, the reason, or why it could not be asked', () => {
    expect(preflightOf({ status: 200, body: { ok: true, repo: 'o/r' } })).toEqual({ kind: 'ok', repo: 'o/r' })
    expect(preflightOf({ status: 200, body: { ok: false, reason: 'no origin' } })).toEqual({ kind: 'refused', reason: 'no origin' })
    expect(preflightOf({ status: 409, body: { code: 'HOST_NOT_RUNNING', error: 'The Astera Host is not running' } })).toEqual({ kind: 'failed', message: 'The Astera Host is not running' })
    expect(preflightOf({ status: 500, body: null })).toEqual({ kind: 'failed', message: 'the Host answered 500' })
  })
})

describe('the folder check against the folder now', () => {
  // Review Focus 5: an answer for the folder before, or for a toggle since turned off, is never shown or trusted
  it('shows an answer only for the folder it was asked about', () => {
    const held = { key: 'D:/a', view: { kind: 'ok' as const, repo: 'o/a' } }
    expect(currentPreflight('D:/a', held)).toEqual({ kind: 'ok', repo: 'o/a' })
    expect(currentPreflight('D:/b', held)).toEqual({ kind: 'checking' })
    expect(currentPreflight(null, held)).toBe(null)
    expect(currentPreflight('D:/a', null)).toEqual({ kind: 'checking' })
  })

  it('holds Create while the lifecycle is on and the folder is not known to carry it', () => {
    expect(lifecycleBlocksCreate(false, null)).toBe(false)
    expect(lifecycleBlocksCreate(true, { kind: 'ok', repo: 'o/r' })).toBe(false)
    for (const p of [null, { kind: 'checking' as const }, { kind: 'refused' as const, reason: 'r' }, { kind: 'failed' as const, message: 'm' }])
      expect(lifecycleBlocksCreate(true, p)).toBe(true)
  })
})

describe('its words', () => {
  it('are in every language', () => {
    const keys = ['github', 'githubHint', 'githubChecking', 'githubOk', 'githubRefused', 'githubFailed', 'githubDefaults', 'githubDefaultsNoRerun', 'githubDefaultsRuntime']
    for (const key of keys) for (const lang of LANGS) expect((CATALOGS[lang].messages as Record<string, string>)[`jobs.new.${key}`], `${lang} ${key}`).toBeTruthy()
  })
})
