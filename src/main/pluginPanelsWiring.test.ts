// The plugin panel guests' wiring (ADR-008), read from the source like the other *Wiring tests: the parts are tested on
// their own (core/plugins/panelGuest.test.ts, plugins/panelGuests.test.ts, ipcGuard.test.ts).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const read = (rel: string): string => readFileSync(path.resolve(__dirname, rel), 'utf8')

describe('plugin panel guests wiring', () => {
  it('registers the plugin scheme as privileged beside the media one', () => {
    expect(read('index.ts')).toMatch(/\{ scheme: PLUGIN_SCHEME, privileges: \{ standard: true, secure: true \} \}/)
  })

  it('routes a plugin partition to the panel guests in the preview attach guard, before the preview rule', () => {
    const guest = read('preview/guest.ts')
    expect(guest).toMatch(/const decision = plugins \? plugins\.decideAttach\(params, prefs\) : 'preview'\s*if \(decision === 'refuse'\) \{\s*e\.preventDefault\(\)\s*return\s*\}\s*if \(decision === 'plugin'\) return/)
    expect(guest).toMatch(/win\.webContents\.on\('did-attach-webview', \(_e, guest\) => \{\s*(?:\/\/[^\n]*\n\s*)*if \(plugins\?\.attached\(guest\)\) return/)
  })

  it('answers the bridge through the guard’s guest channel, and preparePanel through the guarded ipcMain', () => {
    const ipc = read('ipc.ts')
    expect(ipc).toMatch(/ipcMain\.handleGuest\('plugin-ui\.call', \(e, _guest, method: unknown, payload: unknown\) => panelGuests\.call\(e\.sender\.id, method, payload\)\)/)
    expect(ipc).toMatch(/ipcMain\.handle\('plugins\.preparePanel', \(_e, pluginId: unknown, panelId: unknown, projectRoot: unknown\) =>/)
    expect(read('../preload/index.ts')).toContain("preparePanel: invoke('plugins.preparePanel'),")
    // Arguments that are not ids are refused with a code the renderer words, as every other refusal
    expect(ipc).toContain("{ ok: false, code: 'invalid', reason: 'plugins.preparePanel needs a plugin id and a panel id' }")
  })

  it('builds the bridge preload as its own entry, exposing only astera.context on the one channel', () => {
    const config = readFileSync(path.resolve(__dirname, '../../electron.vite.config.ts'), 'utf8')
    expect(config).toMatch(/input: \{ index: 'src\/preload\/index\.ts', pluginBridge: 'src\/preload\/pluginBridge\.ts' \}/)
    const bridge = read('../preload/pluginBridge.ts')
    expect(bridge).toContain("import { contextBridge, ipcRenderer } from 'electron'")
    expect(bridge).toMatch(/contextBridge\.exposeInMainWorld\('astera', \{\s*context: \(\) => ipcRenderer\.invoke\('plugin-ui\.call', 'context', null\)\s*\}\)/)
  })
})

describe('plugin panels: final review wiring', () => {
  // I1: a guest whose element moved it to another partition by its webpreferences never attaches, preview or plugin
  it('refuses an attach whose preferences name another partition than the element, before either rule', () => {
    const guest = read('preview/guest.ts')
    expect(guest).toMatch(
      /win\.webContents\.on\('will-attach-webview', \(e, prefs, params\) => \{\s*(?:\/\/[^\n]*\n\s*)*const asked = \(prefs as \{ partition\?: string \}\)\.partition\s*if \(asked !== undefined && asked !== params\.partition\) \{\s*e\.preventDefault\(\)\s*return\s*\}/
    )
    // The preview rule turns the dangerous preferences off too
    for (const k of ['prefs.webviewTag = false', 'prefs.allowRunningInsecureContent = false', 'prefs.experimentalFeatures = false', 'prefs.nodeIntegrationInSubFrames = false'])
      expect(guest, k).toContain(k)
    expect(guest).toContain('delete prefs.enableBlinkFeatures')
  })

  // M1: no session hands a link to the operating system on a page's say-so; main opens links itself
  it('refuses openExternal in the preview sessions and in the app’s own session, and preview guests pick no Bluetooth device', () => {
    const guest = read('preview/guest.ts')
    expect(guest).toMatch(/callback\(permission !== 'openExternal' && permissionAllowed\(details\.requestingUrl\)\)/)
    expect(guest).toMatch(/guest\.on\('select-bluetooth-device', \(ev, _devices, callback\) => \{\s*ev\.preventDefault\(\)\s*callback\(''\)\s*\}\)/)
    expect(read('index.ts')).toMatch(/session\.defaultSession\.setPermissionRequestHandler\(\(_wc, permission, callback\) => callback\(permission !== 'openExternal'\)\)/)
  })

  // I2: turning a plugin off, removing or replacing it through this app forgets it first, and a watch catches the CLI
  it('forgets a plugin before the Host turns it off, removes or replaces it, and watches while anything is open', () => {
    const ipc = read('ipc.ts')
    expect(ipc).toMatch(/ipcMain\.handle\('plugins\.setEnabled', \(_e, id: unknown, enabled: unknown\) => \{\s*if \(enabled !== true && typeof id === 'string'\) panelGuests\.forget\(id\)/)
    expect(ipc).toMatch(/ipcMain\.handle\('plugins\.remove', \(_e, id: unknown\) => \{\s*if \(typeof id === 'string'\) panelGuests\.forget\(id\)/)
    expect(ipc).toMatch(/const replaces = \(a as \{ expect\?: \{ name\?: unknown \} \} \| null\)\?\.expect\?\.name\s*if \(typeof replaces === 'string'\) panelGuests\.forget\(replaces\)/)
    expect(ipc).toMatch(/setInterval\(\(\) => \{\s*if \(panelGuests\.active\(\)\) void panelGuests\.refresh\(\)\s*\}, PANEL_WATCH_MS\)\.unref\(\)/)
    expect(ipc).toMatch(/return r\.ok \? pluginRowsOf\(r\.body\) : null/)
  })

  // M7: the bridge imports nothing but electron, so the two preloads can never share a chunk a sandbox cannot load
  it('keeps the bridge preload to electron alone', () => {
    const imports = [...read('../preload/pluginBridge.ts').matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
    expect(imports).toEqual(['electron'])
  })
})
