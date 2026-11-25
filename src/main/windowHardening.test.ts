// The main window's webPreferences, read from the source: index.ts calls app.requestSingleInstanceLock() at module scope, so
// it cannot be imported under vitest (navigationGuard.ts says the same). Spec E3 and the Phase 0 audit section 5.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const index = readFileSync(path.resolve(__dirname, 'index.ts'), 'utf8')
const preload = readFileSync(path.resolve(__dirname, '../preload/index.ts'), 'utf8')
const ipc = readFileSync(path.resolve(__dirname, 'ipc.ts'), 'utf8')
const prefs = index.match(/webPreferences: \{[^}]*\}/)?.[0] ?? ''

describe('the main window hardening (Phase 2 entry gate)', () => {
  it('names its isolation settings instead of relying on Electron defaults', () => {
    expect(prefs).toContain('contextIsolation: true')
    expect(prefs).toContain('nodeIntegration: false')
  })
})

// A sandboxed preload gets contextBridge, ipcRenderer, webUtils and a few more, not clipboard. The terminal's key handler
// asks the clipboard synchronously (xterm wants its answer at once), so main answers through synchronous IPC.
describe('the sandboxed main window and its clipboard', () => {
  it('runs sandboxed', () => {
    expect(prefs).toContain('sandbox: true')
    expect(prefs).not.toContain('sandbox: false')
  })

  it('takes nothing from electron that a sandboxed preload lacks', () => {
    const fromElectron = preload.match(/import \{([^}]*)\} from 'electron'/)?.[1] ?? ''
    for (const name of fromElectron.split(',').map((s) => s.trim()).filter(Boolean)) {
      expect(['contextBridge', 'ipcRenderer', 'webUtils', 'webFrame', 'nativeImage', 'crashReporter']).toContain(name)
    }
  })

  it('reads, writes and asks the clipboard through main, synchronously', () => {
    // Final review I2: a refused call answers null, so the renderer is still handed a string and a boolean
    expect(preload).toMatch(/readText: \(\): string => \{\s*const text: unknown = ipcRenderer\.sendSync\('clipboard\.readTextSync'\)\s*return typeof text === 'string' \? text : ''\s*\}/)
    expect(preload).toMatch(/writeText: \(text: string\): void => void ipcRenderer\.sendSync\('clipboard\.writeTextSync', text\)/)
    expect(preload).toMatch(/hasFiles: \(\): boolean => ipcRenderer\.sendSync\('clipboard\.hasFilesSync'\) === true/)
    expect(ipc).toMatch(/ipcMain\.on\('clipboard\.readTextSync', \(e\) => \{\s*e\.returnValue = clipboard\.readText\(\)/)
    expect(ipc).toMatch(/ipcMain\.on\('clipboard\.writeTextSync', \(e, text: unknown\) => \{\s*if \(typeof text === 'string'\) clipboard\.writeText\(text\)\s*e\.returnValue = true/)
    expect(ipc).toMatch(/ipcMain\.on\('clipboard\.hasFilesSync', \(e\) => \{\s*(?:\/\/[^\n]*\n\s*)*e\.returnValue = clipboard\.availableFormats\(\)\.includes\('text\/uri-list'\)/)
  })
})
