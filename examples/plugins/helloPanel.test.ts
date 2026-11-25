// The Hello panel sample (Plugin Platform V2, Phase 2 step 3): a UI-only plugin a person installs from this folder, whose
// command opens its panel as a workbench tab. Its manifest is one Astera installs as restricted UI, and its page keeps to
// what a plugin page may do (ADR-008's CSP): its own script and style files, no inline script or handler, no network.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseManifest } from '../../src/core/plugins/manifest'
import { pluginFilePath, pluginPageUrl } from '../../src/core/plugins/panelGuest'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hello-panel')
const read = (file: string): string => readFileSync(path.join(dir, file), 'utf8')

describe('the Hello panel sample', () => {
  it('is a restricted UI plugin with one command opening its one panel', () => {
    const parsed = parseManifest(JSON.parse(read('package.json')))
    if (!parsed.ok) throw new Error(parsed.problems.join('; '))
    const m = parsed.manifest
    expect(m.trust).toBe('restricted-ui')
    expect(m.entry).toBeUndefined()
    expect(m.ui).toBe('ui/index.html')
    expect(m.permissions).toEqual(['commands.register', 'panels.register', 'workspace.read'])
    expect(m.contributes).toEqual({
      panels: [{ id: 'hello', title: 'Hello' }],
      commands: [{ id: 'open', title: 'Open Hello panel', panel: 'hello' }]
    })
  })

  it('serves its page and the files the page names from inside its folder', () => {
    const page = read('ui/index.html')
    const named = [...page.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
    expect(named.sort()).toEqual(['panel.css', 'panel.js'])
    for (const file of ['ui/index.html', ...named.map((n) => `ui/${n}`)]) {
      expect(existsSync(path.join(dir, file)), file).toBe(true)
      // The address the panel's guest asks for resolves to that file, inside the folder
      const url = pluginPageUrl('astera-hello-panel', file, 'hello', 't').replace(/\?.*$/, '')
      expect(pluginFilePath(dir, url, 'astera-hello-panel'), file).toEqual({ ok: true, file: path.join(dir, file) })
    }
  })

  it('keeps to what a plugin page may do: no inline script or handler, no address outside itself, no HTML from text', () => {
    const page = read('ui/index.html')
    expect(page).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/)
    expect(page).not.toMatch(/\son[a-z]+=/i)
    const script = read('ui/panel.js')
    for (const text of [page, script, read('ui/panel.css')]) expect(text).not.toMatch(/https?:\/\//)
    expect(script).toContain('window.astera.context()')
    expect(script).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/)
  })

  // Screen check: every Astera theme is dark (main/startup.ts), and a page that follows the system's light mode stood
  // white beside it
  it('draws dark, as every Astera theme is', () => {
    expect(read('ui/panel.css')).toMatch(/color-scheme: dark;/)
  })
})
