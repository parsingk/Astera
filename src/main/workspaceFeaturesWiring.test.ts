// The workspace feature switches' wiring in main and preload, read from the source like the other *Wiring tests: the
// narrowing is tested in core/settings/workspaceFeatures.test.ts and the store in appSettingsStore.test.ts.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const ipc = readFileSync(path.resolve(__dirname, 'ipc.ts'), 'utf8')
const preload = readFileSync(path.resolve(__dirname, '../preload/index.ts'), 'utf8')
const types = readFileSync(path.resolve(__dirname, '../core/types.ts'), 'utf8')

describe('workspace feature switches wiring', () => {
  it('answers the switches from the settings store', () => {
    expect(ipc).toContain("ipcMain.handle('settings.getWorkspaceFeatures', () => core.appSettings.getWorkspaceFeatures())")
  })

  it('refuses a record whose five switches are not all booleans', () => {
    expect(ipc).toMatch(/ipcMain\.handle\('settings\.setWorkspaceFeatures', async \(_e, next: unknown\) => \{/)
    expect(ipc).toMatch(/for \(const k of \['layoutMemory', 'problemsTab', 'contextBridge', 'testsTab', 'languageServers'\]\)\s*if \(typeof o\[k\] !== 'boolean'\) throw new Error\(`INVALID_WORKSPACE_FEATURES: /)
    expect(ipc).toContain('await core.appSettings.setWorkspaceFeatures(next as WorkspaceFeatures)')
  })

  it('is on window.api.settings', () => {
    expect(preload).toContain("getWorkspaceFeatures: invoke('settings.getWorkspaceFeatures'),")
    expect(preload).toContain("setWorkspaceFeatures: invoke('settings.setWorkspaceFeatures'),")
    expect(types).toContain('getWorkspaceFeatures(): Promise<WorkspaceFeatures>')
    expect(types).toContain('setWorkspaceFeatures(next: WorkspaceFeatures): Promise<void>')
  })
})
