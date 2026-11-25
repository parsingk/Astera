import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// The settings pane is pinned by its text, like the other settings components: it needs a DOM to render.
const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(here, 'WorkspaceFeatureSettings.tsx'), 'utf8')

describe('the workspace feature switches in Settings (Phase 1 gate)', () => {
  it('lists the three switches in order, each a labelled checkbox with a hint', () => {
    expect(src).toMatch(/key: 'layoutMemory',\s*label: 'settings\.workspace\.layoutMemory',\s*hint: 'settings\.workspace\.layoutMemoryHint'/)
    expect(src).toMatch(/key: 'problemsTab',\s*label: 'settings\.workspace\.problemsTab',\s*hint: 'settings\.workspace\.problemsTabHint'/)
    expect(src).toMatch(/key: 'contextBridge',\s*label: 'settings\.workspace\.contextBridge',\s*hint: 'settings\.workspace\.contextBridgeHint'/)
    expect(src.indexOf("key: 'layoutMemory'")).toBeLessThan(src.indexOf("key: 'problemsTab'"))
    expect(src.indexOf("key: 'problemsTab'")).toBeLessThan(src.indexOf("key: 'contextBridge'"))
    expect(src).toMatch(/<label className="settings-row">/)
    expect(src).toMatch(/<span className="settings-hint">\{t\(hint\)\}<\/span>/)
  })

  it('says where the key-only features are turned off', () => {
    expect(src).toMatch(/<span className="settings-hint">\{t\('settings\.workspace\.hint'\)\}<\/span>/)
  })

  // Unchecked and disabled until main answers, so a switch does not flip itself a moment after the tab opens
  it('is controlled by App and waits for the first read', () => {
    expect(src).toMatch(/value: WorkspaceFeatures \| null/)
    expect(src).toMatch(/checked=\{value\?\.\[key\] \?\? false\}/)
    expect(src).toMatch(/disabled=\{value === null\}/)
    expect(src).toMatch(/onChange=\{\(e\) => onToggle\(key, e\.target\.checked\)\}/)
  })
})
