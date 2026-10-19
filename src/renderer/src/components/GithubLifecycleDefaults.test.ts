// Settings › GitHub's defaults for Jobs carried through GitHub (GitHub lifecycle design §5.1, G7a): the three values a
// new lifecycle Job takes, within the bounds the Host holds, a value outside them never saved. Static markup and pure
// functions: the renderer tests run in node, with no DOM.
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CATALOGS, LANGS } from '../../../core/i18n'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'en', t: (key: string, p?: Record<string, unknown>) => (p ? `${key} ${JSON.stringify(p)}` : key) })
}))

const { GithubLifecycleDefaultsView, defaultsAfterInput } = await import('./GithubLifecycleDefaults')
const DEFAULTS = { autoRerunInfrastructureFailures: true, maxInfrastructureReruns: 2, ciWaitMinutes: 90 }
const render = (value = DEFAULTS): string =>
  renderToStaticMarkup(React.createElement(GithubLifecycleDefaultsView, { value, onChange: () => {} })).replace(/&quot;/g, '"')

describe('GithubLifecycleDefaultsView', () => {
  it('shows the three values, what they are for, and their bounds', () => {
    const html = render()
    for (const k of ['title', 'hint', 'autoRerun', 'maxReruns', 'ciWait']) expect(html, k).toContain(`github.settings.lifecycle.${k}`)
    expect(html).toContain('github.settings.lifecycle.bounds {"min":1,"max":10,"waitMin":10,"waitMax":1440}')
    expect(html).toMatch(/value="2"/)
    expect(html).toMatch(/value="90"/)
  })

  it('greys the reruns limit while automatic reruns are off', () => {
    expect(render()).not.toMatch(/value="2"[^>]*disabled=""|disabled=""[^>]*value="2"/)
    expect(render({ ...DEFAULTS, autoRerunInfrastructureFailures: false })).toMatch(/value="2"[^>]*disabled=""|disabled=""[^>]*value="2"/)
  })
})

describe('defaultsAfterInput', () => {
  it('takes a value within the bounds and refuses anything else, which is then not saved', () => {
    expect(defaultsAfterInput(DEFAULTS, 'maxInfrastructureReruns', '10')).toEqual({ ...DEFAULTS, maxInfrastructureReruns: 10 })
    for (const raw of ['0', '11', 'x', '2.5', '']) expect(defaultsAfterInput(DEFAULTS, 'maxInfrastructureReruns', raw), raw).toBe(null)
    expect(defaultsAfterInput(DEFAULTS, 'ciWaitMinutes', '10')).toEqual({ ...DEFAULTS, ciWaitMinutes: 10 })
    for (const raw of ['9', '1441']) expect(defaultsAfterInput(DEFAULTS, 'ciWaitMinutes', raw), raw).toBe(null)
    expect(defaultsAfterInput(DEFAULTS, 'autoRerunInfrastructureFailures', false)).toEqual({ ...DEFAULTS, autoRerunInfrastructureFailures: false })
  })
})

describe('its words', () => {
  it('are in every language', () => {
    for (const k of ['title', 'hint', 'autoRerun', 'maxReruns', 'ciWait', 'bounds', 'invalid'])
      for (const lang of LANGS) expect((CATALOGS[lang].messages as Record<string, string>)[`github.settings.lifecycle.${k}`], `${lang} ${k}`).toBeTruthy()
  })
})
