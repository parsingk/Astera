import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PluginPanelView } from './PluginPanelTab'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'en', t: (key: string) => key, tm: (m: unknown) => String(m) })
}))

const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(here, 'PluginPanelTab.tsx'), 'utf8')
const view = (state: Parameters<typeof PluginPanelView>[0]['state']): string =>
  renderToStaticMarkup(createElement(PluginPanelView, { state, title: 'Hello', onReopen: () => {}, onGone: () => {}, onFocus: () => {} }))

// Phase 2 step 3 (ADR-008): a plugin's panel is a <webview> guest whose src and partition are exactly what main
// answered, or a note saying why it is not shown, with a way to ask again.
describe('PluginPanelView', () => {
  it('shows the guest with exactly the page and partition main answered', () => {
    const html = view({ phase: 'shown', url: 'astera-plugin://hello-panel/ui/index.html?panel=hello&t=abc', partition: 'plugin-hello-panel' })
    expect(html).toContain('<webview')
    expect(html).toContain('src="astera-plugin://hello-panel/ui/index.html?panel=hello&amp;t=abc"')
    expect(html).toContain('partition="plugin-hello-panel"')
    // A name for the guest, so a screen reader says which panel it is (final review)
    expect(html).toContain('aria-label="Hello"')
    expect(html).not.toContain('plugin.panel.reopen')
  })

  it('says it is opening while main is asked', () => {
    const html = view({ phase: 'preparing' })
    expect(html).toContain('plugin.panel.preparing')
    expect(html).not.toContain('<webview')
  })

  it('says why a panel was refused, by its code, and offers to ask again', () => {
    for (const code of ['host', 'missing', 'disabled', 'notReady', 'noUi', 'noPanel', 'address', 'invalid'] as const) {
      const html = view({ phase: 'refused', code })
      expect(html).toContain(`plugin.panel.refused.${code}`)
      expect(html).toContain('plugin.panel.reopen')
      expect(html).not.toContain('<webview')
    }
  })

  it('says the page stopped when its guest is gone, and offers to open it again', () => {
    const html = view({ phase: 'gone' })
    expect(html).toContain('plugin.panel.gone')
    expect(html).toContain('plugin.panel.reopen')
  })
})

describe('PluginPanelTab wiring', () => {
  // React.StrictMode runs the effect twice: the first answer must not mount a guest (review focus 5)
  it('prepares on mount and on each reopen, dropping an answer it no longer waits for', () => {
    expect(src).toMatch(/window\.api\.plugins\s*\.preparePanel\(pluginId, panelId, projectRoot \|\| null\)/)
    expect(src).toMatch(/if \(!current\) return/)
    expect(src).toMatch(/setState\(\{ phase: 'refused', code: r\.code \}\)/)
    expect(src).toMatch(/setState\(\{ phase: 'shown', url: r\.url, partition: r\.partition \}\)/)
    expect(src).toMatch(/return \(\) => \{\s*current = false\s*\}/)
    expect(src).toMatch(/\}, \[pluginId, panelId, projectRoot, attempt\]\)/)
  })

  // A token admits one guest once: a new answer needs a new element, never the old one pointed elsewhere
  it('gives each answered page an element of its own', () => {
    expect(src).toMatch(/<PluginGuest key=\{state\.url\}/)
  })

  // Main ends a guest's renderer when its plugin is turned off, removed or replaced (main/plugins/panelGuests.ts forget)
  // Screen check, measured: main's forget (renderer ended, then the guest closed) reaches the element as `close` and
  // `destroyed`, never as `render-process-gone`, which a page crash with its guest still there gives
  it('notices its guest is gone, and that the person moved into it', () => {
    expect(src).toMatch(/view\.addEventListener\('destroyed', ended\)/)
    expect(src).toMatch(/view\.addEventListener\('render-process-gone', gone\)/)
    expect(src).toMatch(/view\.addEventListener\('focus', focus\)/)
  })
})

// Every note a panel tab shows is worded in each language the app speaks, not left to fall back to Korean
describe('the panel tab’s words', () => {
  it('has each in ko, en, ja and es', async () => {
    const { CATALOGS, LANGS } = await import('../../../core/i18n')
    const keys = ['preparing', 'gone', 'reopen', ...['host', 'missing', 'disabled', 'notReady', 'noUi', 'noPanel', 'address', 'invalid'].map((c) => `refused.${c}`)]
    for (const lang of LANGS) for (const k of keys) expect((CATALOGS[lang].messages as Record<string, string>)[`plugin.panel.${k}`], `${lang}:${k}`).toBeTruthy()
  })
})

// Final review I1: running the plugin's command again is the person asking for the panel. A tab that says why it is not
// shown asks main again; a page already showing is not reloaded.
describe('running the command again', () => {
  it('asks again only when the tab is refused or its guest is gone', () => {
    expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(nonce === 0\) return\s*const phase = stateRef\.current\.phase\s*if \(phase === 'refused' \|\| phase === 'gone'\) \{\s*auto\.current = false\s*setAttempt\(\(n\) => n \+ 1\)\s*\}\s*\}, \[nonce\]\)/)
  })
})

// Phase 2 step 4b: main ends a guest when its plugin is installed again, turned off or removed; the tab asks main again by
// itself, so it shows the new page or says why not. A page that crashes is not asked again, and three asks in a row
// without a page loading stop, so nothing loops.
describe('a guest main ended', () => {
  it('asks main again on destroyed, at most three times without a page loading, and not after the tab closed', () => {
    expect(src).toMatch(/const AUTO_REOPEN_MAX = 3/)
    expect(src).toMatch(/onEnded=\{\(\) => \{\s*if \(!mounted\.current\) return\s*if \(autoReopens\.current < AUTO_REOPEN_MAX\) \{\s*autoReopens\.current \+= 1\s*auto\.current = true\s*setAttempt\(\(n\) => n \+ 1\)\s*\} else setState\(\{ phase: 'gone' \}\)/)
    expect(src).toMatch(/onLoaded=\{\(\) => \{\s*autoReopens\.current = 0\s*auto\.current = false\s*\}\}/)
    expect(src).toMatch(/view\.addEventListener\('destroyed', ended\)/)
    expect(src).toMatch(/view\.addEventListener\('render-process-gone', gone\)/)
    expect(src).toMatch(/view\.addEventListener\('dom-ready', loaded\)/)
  })
})

describe('a guest main ended, final review', () => {
  // I4: React.StrictMode unmounts and mounts once in development; mounted is set again, or no ask would ever be made
  it('sets mounted again on each mount', () => {
    expect(src).toMatch(/useEffect\(\(\) => \{\s*mounted\.current = true\s*return \(\) => \{\s*mounted\.current = false\s*\}\s*\}, \[\]\)/)
  })

  // M5: an ask it made by itself that finds the plugin not ready yet (just installed again) asks once more a moment later
  it('asks again a moment later when its own ask found the plugin not ready', () => {
    expect(src).toMatch(/if \(auto\.current && r\.code === 'notReady' && autoReopens\.current < AUTO_REOPEN_MAX\)/)
    expect(src).toMatch(/setTimeout\(\(\) => \{\s*if \(!mounted\.current\) return\s*autoReopens\.current \+= 1\s*setAttempt\(\(n\) => n \+ 1\)\s*\}, NOT_READY_RETRY_MS\)/)
  })
})
