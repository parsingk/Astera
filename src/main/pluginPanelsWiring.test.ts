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
  })

  it('builds the bridge preload as its own entry, exposing only astera.context on the one channel', () => {
    const config = readFileSync(path.resolve(__dirname, '../../electron.vite.config.ts'), 'utf8')
    expect(config).toMatch(/input: \{ index: 'src\/preload\/index\.ts', pluginBridge: 'src\/preload\/pluginBridge\.ts' \}/)
    const bridge = read('../preload/pluginBridge.ts')
    expect(bridge).toContain("import { contextBridge, ipcRenderer } from 'electron'")
    expect(bridge).toMatch(/contextBridge\.exposeInMainWorld\('astera', \{\s*context: \(\) => ipcRenderer\.invoke\('plugin-ui\.call', 'context', null\)\s*\}\)/)
  })
})
