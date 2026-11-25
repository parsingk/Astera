import { describe, it, expect } from 'vitest'
import path from 'node:path'
import {
  BRIDGE_MAX_CALLS_PER_SECOND,
  BRIDGE_MAX_PAYLOAD,
  PLUGIN_SCHEME,
  PLUGIN_UI_CSP,
  bridgeRefusal,
  isPluginPartition,
  panelAttach,
  pluginFilePath,
  pluginHostProblem,
  pluginPageUrl,
  pluginPartition,
  type PreparedPanel
} from './panelGuest'

// ADR-008: what a plugin panel guest may load, attach as and ask, decided apart from Electron so each rule is tested
describe('plugin panel guest decisions', () => {
  it('names one partition and one scheme host per plugin, a scoped one written scope+name', () => {
    expect(PLUGIN_SCHEME).toBe('astera-plugin')
    expect(pluginPartition('hello-panel')).toBe('plugin-hello-panel')
    expect(pluginPartition('@acme/x')).toBe('plugin-acme+x')
    expect(isPluginPartition('plugin-hello-panel')).toBe(true)
    expect(isPluginPartition('persist:preview')).toBe(false)
    expect(isPluginPartition(undefined)).toBe(false)
  })

  it('serves a CSP that blocks network, frames and inline script by default', () => {
    expect(PLUGIN_UI_CSP).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    )
  })

  it('builds a panel page URL on the plugin host with the panel and a one-time token in the query, a leading ./ left out', () => {
    expect(pluginPageUrl('hello-panel', 'dist/ui/index.html', 'main', 'tok1')).toBe('astera-plugin://hello-panel/dist/ui/index.html?panel=main&t=tok1')
    expect(pluginPageUrl('@acme/x', './ui page.html', 'side.view', 'tok2')).toBe('astera-plugin://acme+x/ui%20page.html?panel=side.view&t=tok2')
  })

  // Review M4: Chromium rewrites a standard scheme's host that reads as an address (123 becomes 0.0.0.123)
  it('says when a plugin id reads as an address, which no panel could be shown on', () => {
    expect(pluginHostProblem('hello-panel')).toBeNull()
    expect(pluginHostProblem('@acme/x')).toBeNull()
    for (const id of ['123', '1.2', '0x10']) expect(pluginHostProblem(id), id).toBe(`${id} reads as an address, so its panels cannot be shown; rename the plugin`)
  })

  describe('pluginFilePath', () => {
    const root = path.resolve('/plugins/installed/hello-panel')
    const at = (url: string): ReturnType<typeof pluginFilePath> => pluginFilePath(root, url, 'hello-panel')
    it('maps a page and its assets to files inside the package', () => {
      expect(at('astera-plugin://hello-panel/dist/ui/index.html?panel=main')).toEqual({ ok: true, file: path.join(root, 'dist', 'ui', 'index.html') })
      expect(at('astera-plugin://hello-panel/dist/ui/a%20b.css')).toEqual({ ok: true, file: path.join(root, 'dist', 'ui', 'a b.css') })
    })
    it('refuses another plugin’s host, a path that escapes, a backslash, NUL, a device name or a part ending in a dot or space', () => {
      for (const url of [
        'astera-plugin://other/dist/ui/index.html',
        'astera-plugin://hello-panel/dist/%2e%2e%2f%2e%2e%2fsecret',
        'astera-plugin://hello-panel/dist%5c..%5c..%5cx',
        'astera-plugin://hello-panel/dist/a%00.html',
        'astera-plugin://hello-panel/dist/con.txt',
        'astera-plugin://hello-panel/dist/NUL',
        'astera-plugin://hello-panel/dist/COM%C2%B9',
        'astera-plugin://hello-panel/dist/lpt%C2%B3.txt',
        'astera-plugin://hello-panel/dist./index.html',
        'astera-plugin://hello-panel/dist%20/index.html',
        'https://hello-panel/dist/ui/index.html'
      ]) {
        expect(at(url), url).toEqual({ ok: false, status: 403 })
      }
    })
    // The URL parser itself folds a %2e%2e part, so at the root it can only stay inside the package
    it('keeps a folded %2e%2e part inside the package', () => {
      expect(at('astera-plugin://hello-panel/%2e%2e/other/index.html')).toEqual({ ok: true, file: path.join(root, 'other', 'index.html') })
    })

    it('answers 404 for a folder and 400 for an address that does not decode', () => {
      expect(at('astera-plugin://hello-panel/dist/ui/')).toEqual({ ok: false, status: 404 })
      expect(at('astera-plugin://hello-panel/')).toEqual({ ok: false, status: 404 })
      expect(at('astera-plugin://hello-panel/dist/%E0%A4%A.html')).toEqual({ ok: false, status: 400 })
    })
  })

  describe('panelAttach', () => {
    const prepared: PreparedPanel[] = [
      { key: 'hello-panel:main', pluginId: 'hello-panel', panelId: 'main', partition: 'plugin-hello-panel', url: 'astera-plugin://hello-panel/dist/ui/index.html?panel=main' }
    ]
    it('leaves a non-plugin partition to the preview rule', () => {
      expect(panelAttach({ partition: 'persist:preview', src: 'http://localhost:5173/' }, prepared)).toEqual({ kind: 'preview' })
    })
    it('attaches a prepared panel’s exact URL in its own partition', () => {
      expect(panelAttach({ partition: 'plugin-hello-panel', src: prepared[0].url }, prepared)).toEqual({ kind: 'plugin', key: 'hello-panel:main' })
    })
    it('refuses another URL, another panel, another plugin’s partition, or a panel never prepared', () => {
      for (const p of [
        { partition: 'plugin-hello-panel', src: 'astera-plugin://hello-panel/dist/ui/other.html?panel=main' },
        { partition: 'plugin-hello-panel', src: 'astera-plugin://hello-panel/dist/ui/index.html?panel=side' },
        { partition: 'plugin-other', src: prepared[0].url },
        { partition: 'plugin-hello-panel', src: 'https://127.0.0.1:9/' },
        { partition: 'plugin-hello-panel' }
      ]) {
        expect(panelAttach(p, prepared), JSON.stringify(p)).toEqual({ kind: 'refuse' })
      }
      expect(panelAttach({ partition: 'plugin-hello-panel', src: prepared[0].url }, [])).toEqual({ kind: 'refuse' })
    })
  })

  describe('bridgeRefusal', () => {
    it('answers only the allowed methods, within the size and rate limits', () => {
      const calls: number[] = []
      expect(bridgeRefusal(calls, 'context', {}, 1000)).toBeNull()
      expect(bridgeRefusal(calls, 'files.read', {}, 1001)).toBe('UNKNOWN_METHOD: files.read')
      expect(bridgeRefusal(calls, 'context', 'x'.repeat(BRIDGE_MAX_PAYLOAD), 1002)).toBe(`PAYLOAD_TOO_LARGE: at most ${BRIDGE_MAX_PAYLOAD} bytes as JSON`)
      // An unserializable payload is refused, not thrown
      const loop: Record<string, unknown> = {}
      loop.self = loop
      expect(bridgeRefusal(calls, 'context', loop, 1003)).toBe('PAYLOAD_NOT_JSON')
    })
    it('refuses past the calls a second allows, and allows again once the second has passed', () => {
      const calls: number[] = []
      for (let i = 0; i < BRIDGE_MAX_CALLS_PER_SECOND; i++) expect(bridgeRefusal(calls, 'context', null, 5000 + i)).toBeNull()
      expect(bridgeRefusal(calls, 'context', null, 5100)).toBe(`TOO_MANY_CALLS: at most ${BRIDGE_MAX_CALLS_PER_SECOND} a second`)
      expect(bridgeRefusal(calls, 'context', null, 6100)).toBeNull()
    })
  })
})

// Review M5: a refused call counts against the rate, so refusals cannot be sent at any rate
describe('bridgeRefusal counts every call', () => {
  it('refuses past the rate even when the calls before were refused for their method', () => {
    const calls: number[] = []
    for (let i = 0; i < BRIDGE_MAX_CALLS_PER_SECOND; i++) bridgeRefusal(calls, 'files.read', null, 9000 + i)
    expect(bridgeRefusal(calls, 'context', null, 9050)).toBe(`TOO_MANY_CALLS: at most ${BRIDGE_MAX_CALLS_PER_SECOND} a second`)
  })
})
