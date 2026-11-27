import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { t as translate, type MessageKey, type MessageParams } from '../../../core/i18n'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'en', t: (key: MessageKey, params?: MessageParams) => translate('en', key, params), tm: (m: unknown) => String(m) })
}))
const { PluginCatalogView, filterCatalog } = await import('./PluginCatalog')
const en = (key: MessageKey, params?: MessageParams): string => translate('en', key, params)

const HELLO = {
  id: 'astera-hello-panel',
  publisher: 'example',
  name: 'Hello Panel',
  category: 'development',
  trustLevel: 'restricted-ui',
  license: 'Apache-2.0',
  sourceUrl: 'https://example.invalid/hello',
  issuesUrl: 'https://example.invalid/hello/issues',
  latest: { version: '0.2.0', permissions: ['commands.register', 'panels.register'], releaseNotes: 'A sidebar view' },
  installed: { version: '0.1.0', enabled: true, fromCatalog: true },
  newPermissions: ['workspace.read']
}
const DUSK = { id: 'astera-dusk-theme', publisher: 'example', name: 'Dusk', category: 'themes', trustLevel: 'declarative', latest: null, installed: null }
const noop = (): void => {}
const render = (catalog: Record<string, unknown> | null, over: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(React.createElement(PluginCatalogView, { catalog, query: '', category: '', busy: null, onQuery: noop, onCategory: noop, onRefresh: noop, onInstall: noop, onConfigure: noop, onClear: noop, ...over }))

// Phase 4 (spec M3): the catalog in Settings, Plugins
describe('PluginCatalogView', () => {
  it('says no catalog is set, and offers the address and keys to set one', () => {
    const html = render({ configured: false })
    expect(html).toContain(en('settings.plugins.catalog.none'))
    expect(html).toContain(en('settings.plugins.catalog.save'))
  })

  it('shows where the index is from, each plugin’s versions, trust, publisher, license, source and report address', () => {
    const html = render({ configured: true, url: 'https://x.invalid/index.json', sequence: 3, fetchedAt: Date.UTC(2026, 10, 27), expired: false, plugins: [HELLO, DUSK] })
    expect(html).toContain('https://x.invalid/index.json')
    expect(html).toContain(en('settings.plugins.catalog.latest', { version: '0.2.0' }))
    expect(html).toContain(en('settings.plugins.catalog.installedVersion', { version: '0.1.0' }))
    expect(html).toContain(en('settings.plugins.trust.restrictedUi'))
    expect(html).toContain(en('settings.plugins.catalog.publisher', { publisher: 'example' }))
    expect(html).toContain('Apache-2.0')
    expect(html).toContain('https://example.invalid/hello/issues')
    expect(html).toContain('A sidebar view')
    expect(html).toContain(en('settings.plugins.catalog.update', { version: '0.2.0' }))
    expect(html).toContain(en('settings.plugins.catalog.newPermissions', { list: en('settings.plugins.perm.workspace.read') }))
    expect(html).toContain(en('settings.plugins.catalog.noVersion'))
  })

  it('shows no download count or rating', () => {
    expect(render({ configured: true, url: 'u', sequence: 1, plugins: [HELLO] })).not.toMatch(/downloads|rating|★/i)
  })

  it('warns when the index expired and when the last refresh failed, and marks a revoked install', () => {
    const html = render({ configured: true, url: 'u', sequence: 1, expired: true, problem: 'the index is not a file', plugins: [{ ...HELLO, installedRevoked: 'leaks a token' }] })
    expect(html).toContain(en('settings.plugins.catalog.expired'))
    expect(html).toContain(en('settings.plugins.catalog.problem', { problem: 'the index is not a file' }))
    expect(html).toContain(en('settings.plugins.catalog.revoked', { reason: 'leaks a token' }))
  })

  it('offers no install from an expired index', () => {
    expect(render({ configured: true, url: 'u', sequence: 1, expired: true, plugins: [HELLO] })).not.toContain(en('settings.plugins.catalog.update', { version: '0.2.0' }))
  })
})

describe('filterCatalog', () => {
  it('finds by id, name or publisher, and by category', () => {
    expect(filterCatalog([HELLO, DUSK], 'dusk', '').map((p) => p.id)).toEqual(['astera-dusk-theme'])
    expect(filterCatalog([HELLO, DUSK], 'EXAMPLE', '').map((p) => p.id)).toEqual(['astera-hello-panel', 'astera-dusk-theme'])
    expect(filterCatalog([HELLO, DUSK], '', 'themes').map((p) => p.id)).toEqual(['astera-dusk-theme'])
  })
})

// Phase 4 final review I5, m14 and the index's own expiry
describe('PluginCatalogView, final review fixes', () => {
  it('says why the catalog could not be read and offers to read it again, instead of reading for ever (I5)', () => {
    const html = render(null, { failure: 'The Host is not running.' })
    expect(html).toContain('The Host is not running.')
    expect(html).toContain(en('settings.plugins.catalog.retry'))
    expect(html).not.toContain(en('settings.plugins.catalog.reading'))
  })

  it('offers no update to an older version than the one installed (m14)', () => {
    const html = render({ configured: true, url: 'u', sequence: 1, plugins: [{ ...HELLO, latest: { version: '1.0.0', permissions: [] }, installed: { version: '2.0.0', enabled: true, fromCatalog: false }, newPermissions: [] }] })
    expect(html).not.toContain(en('settings.plugins.catalog.update', { version: '1.0.0' }))
    expect(html).toContain(en('settings.plugins.catalog.newerInstalled'))
  })

  it('shows when the index stops being good to install from', () => {
    const html = render({ configured: true, url: 'u', sequence: 1, fetchedAt: Date.UTC(2026, 10, 27), expires: Date.UTC(2027, 0, 1), plugins: [] })
    expect(html).toContain(en('settings.plugins.catalog.expires', { when: new Date(Date.UTC(2027, 0, 1)).toLocaleDateString() }))
  })
})
