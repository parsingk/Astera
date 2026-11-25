// The main window's webPreferences, read from the source: index.ts calls app.requestSingleInstanceLock() at module scope, so
// it cannot be imported under vitest (navigationGuard.ts says the same). Spec E3 and the Phase 0 audit section 5.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const index = readFileSync(path.resolve(__dirname, 'index.ts'), 'utf8')
const prefs = index.match(/webPreferences: \{[^}]*\}/)?.[0] ?? ''

describe('the main window hardening (Phase 2 entry gate)', () => {
  it('names its isolation settings instead of relying on Electron defaults', () => {
    expect(prefs).toContain('contextIsolation: true')
    expect(prefs).toContain('nodeIntegration: false')
  })
})
