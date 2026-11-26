import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Phase 3 Part 3: how main carries the language servers between the window and the Host. ipc.ts needs Electron to load,
// so its wiring is pinned by its text; the view, the producer and the interpreter rule are tested on their own.
const here = path.dirname(fileURLToPath(import.meta.url))
const ipc = readFileSync(path.join(here, 'ipc.ts'), 'utf8')
const preload = readFileSync(path.join(here, '../preload/index.ts'), 'utf8')
const types = readFileSync(path.join(here, '../core/types.ts'), 'utf8')

describe('language servers in main', () => {
  it('keeps one view of the Host, sends through whatever client is up, and takes its pushes', () => {
    expect(ipc).toMatch(/const lspView = createHostLspView\(\{\s*status: \(\) => hostClient\?\.status\(\) \?\? \{ connected: false, features: \[\] \},\s*send: \(m\) => hostClient\?\.send\(m\) \?\? false,/)
    expect(ipc).toMatch(/changed: \(\) => problemsPing\.touch\(\),\s*stateChanged: \(servers\) => send\('lsp:state', servers\)/)
    expect(ipc).toContain('client.onMessage((m) => lspView.pushed(m))')
    expect(ipc).toContain('client.onConnect(() => void lspView.connected())')
    expect(ipc).toContain('client.onStatusChange(() => lspView.status())')
  })

  // Final review I4: the servers' states feed a note per unchecked root
  it('feeds Problems only while the switch is on', () => {
    expect(ipc).toMatch(
      /lspProducer\(\{\s*files: \(p\) => \(core\.appSettings\.getWorkspaceFeatures\(\)\.languageServers \? lspView\.files\(p\) : \[\]\),\s*servers: \(\) => \(core\.appSettings\.getWorkspaceFeatures\(\)\.languageServers \? lspView\.servers\(\) : \[\]\),\s*stat: statMtime\s*\}\)/
    )
  })

  // Final review C2, I3, M7, M13: a settings change refreshes, deletions ride with the saves, the open set's guard
  // resolves `..`, and an interpreter that cannot be pyright's is refused
  it('refreshes after a settings change, passes deletions, guards with isPathWithin, and refuses a bad interpreter', () => {
    expect(ipc).toMatch(/await core\.appSettings\.setLanguageServers\(next\)[\s\S]{0,300}await lspView\.refresh\(\)/)
    expect(ipc).toMatch(/interpreterPathProblem\(next\.python\.interpreter\)/)
    expect(ipc).toMatch(/ipcMain\.handle\('lsp\.saved', \(_e, paths: unknown, deleted: unknown\) => \{\s*lspView\.saved\(strings\(paths\), strings\(deleted\)\)/)
    expect(ipc).toMatch(/!isPathWithin\(o\.root, o\.path\)\) continue/)
    expect(ipc).toMatch(/ipcMain\.handle\('lsp\.restart', \(_e, server: string, root: string\) => lspAnswer\(lspRoute, 'lsp-restart', \{ server, root \}\)\)/)
  })

  it('answers the window: open files, saves, status, install, remove, log, a project’s venv, and the settings', () => {
    for (const ch of ['lsp.setOpen', 'lsp.saved', 'lsp.status', 'lsp.install', 'lsp.remove', 'lsp.restart', 'lsp.log', 'lsp.venvFor', 'settings.getLanguageServers', 'settings.setLanguageServers'])
      expect(ipc, ch).toContain(`ipcMain.handle('${ch}'`)
    expect(ipc).toMatch(/languageServerPathProblem\(/)
    expect(preload).toMatch(/lsp: \{\s*setOpen: invoke\('lsp\.setOpen'\),\s*saved: invoke\('lsp\.saved'\),\s*status: invoke\('lsp\.status'\),\s*install: invoke\('lsp\.install'\),\s*remove: invoke\('lsp\.remove'\),\s*restart: invoke\('lsp\.restart'\),\s*log: invoke\('lsp\.log'\),\s*venvFor: invoke\('lsp\.venvFor'\)\s*\}/)
    expect(preload).toContain("getLanguageServers: invoke('settings.getLanguageServers'),")
    expect(types).toContain('getLanguageServers(): Promise<LanguageServerSettings>')
    expect(types).toContain('saved(paths: string[], deleted?: string[]): Promise<void>')
    expect(types).toContain('restart(server: string, root: string): Promise<unknown>')
    expect(types).toMatch(/'lsp:state'/)
  })
})
