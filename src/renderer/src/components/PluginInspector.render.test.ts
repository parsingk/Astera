import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { t as translate, type MessageKey, type MessageParams } from '../../../core/i18n'
import { AUDIT_EVENTS } from '../../../core/plugins/auditEvents'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'en', t: (key: MessageKey, params?: MessageParams) => translate('en', key, params), tm: (m: unknown) => String(m) })
}))
const { PluginInspectorView } = await import('./PluginInspector')
const en = (key: MessageKey, params?: MessageParams): string => translate('en', key, params)

const GET = {
  id: 'hello-panel',
  version: '0.2.0',
  status: 'running',
  trust: 'trusted',
  pid: 4242,
  installedAt: Date.UTC(2026, 10, 27, 9, 0, 0),
  permissions: ['jobs.read', 'commands.register'],
  requested: ['jobs.read', 'jobs.create', 'commands.register'],
  contributes: {
    commands: [{ id: 'open', title: 'Open Hello', panel: 'main' }],
    panels: [{ id: 'main', title: 'Hello' }],
    sidebar: [{ id: 'side', title: 'Hello side', panel: 'main' }],
    statusBar: [{ id: 'hi', text: 'Hi', command: 'open' }]
  },
  calls: { 'jobs-list': { ok: 3, refused: 0 }, 'jobs-create': { ok: 0, refused: 2 } },
  // A setting's value never reaches the Inspector: the Host's get carries none, and nothing here reads one
  settings: { token: 'sk-should-never-show' }
}
const DOCTOR = { ok: false, checks: [{ name: 'manifest', ok: true, detail: 'hello 0.2.0, Plugin API 2' }, { name: 'entry', ok: false, detail: 'dist/host.js is not a file in the installed copy' }] }
const AUDIT = [{ at: Date.UTC(2026, 10, 27, 9, 1, 0), plugin: 'hello-panel', event: 'call-refused' as const, detail: 'jobs-create needs the jobs.create permission', repeated: 4 }]

const render = (over: Partial<{ get: unknown; doctor: unknown; audit: unknown; error: string }> = {}): string =>
  renderToStaticMarkup(React.createElement(PluginInspectorView, { data: { get: GET, doctor: DOCTOR, audit: AUDIT, ...over } }))

// Phase 2 remaining, spec E4: the Plugin Inspector
describe('PluginInspectorView', () => {
  it('shows the state, version, trust level and process', () => {
    const html = render()
    expect(html).toContain('0.2.0')
    expect(html).toContain(en('settings.plugins.status.running'))
    expect(html).toContain(en('settings.plugins.trust.trusted'))
    expect(html).toContain('4242')
  })

  it('shows what was granted and what was asked for but not granted', () => {
    const html = render()
    expect(html).toContain(en('settings.plugins.perm.jobs.read'))
    expect(html).toContain(en('settings.plugins.inspector.notGranted'))
    expect(html).toContain(en('settings.plugins.perm.jobs.create'))
  })

  it('counts each kind of contribution', () => {
    const html = render()
    expect(html).toContain(en('settings.plugins.inspector.contrib.commands', { count: 1 }))
    expect(html).toContain(en('settings.plugins.inspector.contrib.sidebar', { count: 1 }))
    expect(html).toContain(en('settings.plugins.inspector.contrib.statusBar', { count: 1 }))
  })

  it('lists the Host calls by command with their refusals', () => {
    const html = render()
    expect(html).toContain(en('settings.plugins.inspector.callRow', { method: 'jobs-create', ok: 0, refused: 2 }))
    expect(html).toContain(en('settings.plugins.inspector.callRow', { method: 'jobs-list', ok: 3, refused: 0 }))
    expect(render({ get: { ...GET, calls: {} } })).toContain(en('settings.plugins.inspector.callsNone'))
  })

  it('shows each check, and the recent records with how many more came', () => {
    const html = render()
    expect(html).toContain('dist/host.js is not a file in the installed copy')
    expect(html).toContain(en('settings.plugins.inspector.event.call-refused'))
    expect(html).toContain(en('settings.plugins.inspector.repeated', { count: 4 }))
    expect(render({ audit: [] })).toContain(en('settings.plugins.inspector.auditNone'))
  })

  it('never shows a setting value, whatever an answer carried', () => {
    expect(render()).not.toContain('sk-should-never-show')
  })

  it('says why it could not read the plugin', () => {
    expect(render({ get: null, error: 'the Host is not running' })).toContain('the Host is not running')
  })

  it('has words for every audit event in every language', () => {
    for (const lang of ['ko', 'en', 'ja', 'es'] as const)
      for (const e of AUDIT_EVENTS) expect(translate(lang, `settings.plugins.inspector.event.${e}` as MessageKey), `${lang} ${e}`).not.toBe(`settings.plugins.inspector.event.${e}`)
  })
})
