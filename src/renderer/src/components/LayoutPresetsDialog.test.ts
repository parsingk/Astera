import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// The dialog needs a DOM; its wiring is pinned by its text. What a saved preset holds and how it is applied is
// core/panes/presets.ts, tested there.
const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(here, 'LayoutPresetsDialog.tsx'), 'utf8')
const app = readFileSync(path.join(here, '../App.tsx'), 'utf8')

describe('the saved layout presets dialog (spec W3)', () => {
  it('names the current layout, with a bound on the name and no blank save', () => {
    expect(src).toMatch(/maxLength=\{MAX_PRESET_NAME\}/)
    expect(src).toMatch(/disabled=\{trimmed === ''\}/)
    // Final review M6: Enter that commits a Korean or Japanese composition does not save
    expect(src).toMatch(/if \(e\.key === 'Enter' && !e\.nativeEvent\.isComposing\) save\(\)/)
  })

  it('says when there is no room for one more, and that a same name is replaced', () => {
    expect(src).toMatch(/\{full && <p className="warn">\{t\('layout\.presets\.full'\)\}<\/p>\}/)
    expect(src).toMatch(/t\('layout\.presets\.replaces'\)/)
  })

  it('applies or deletes each saved preset, and says when there is none', () => {
    expect(src).toMatch(/onClick=\{\(\) => onApply\(p\)\}/)
    expect(src).toMatch(/onClick=\{\(\) => onDelete\(p\.name\)\}/)
    expect(src).toMatch(/t\('layout\.presets\.empty'\)/)
  })

  it('closes on Escape, on its button and on a press that began on the backdrop', () => {
    expect(src).toMatch(/if \(e\.key === 'Escape'\) \{\s*e\.stopPropagation\(\)\s*onClose\(\)/)
    expect(src).toMatch(/backdropProps\(onClose\)/)
  })
})

describe('the layout actions (spec W3)', () => {
  it('arranges the open tabs and shows the preset’s panels, never opening a tab', () => {
    for (const id of ['coding', 'review', 'agents', 'devops']) expect(app).toMatch(new RegExp(`'layout\\.${id}': \\{ run: \\(\\) => applyPreset\\('${id}'\\) \\}`))
    expect(app).toMatch(/applyTree\(presetTree\(id, tabIds, active\)\)/)
    expect(app).toMatch(/applyPanels\(p\)/)
  })

  it('resets to the default arrangement and the default sizes', () => {
    expect(app).toMatch(/'layout\.reset': \{ run: \(\) => applyPreset\('default'\) \}/)
    expect(app).toMatch(/if \(id === 'default'\) \{\s*setSidebarSize\(500\)\s*setPanelHeight\(220\)/)
  })

  it('opens the saved presets dialog, which saves, applies and deletes through the store', () => {
    expect(app).toMatch(/'layout\.presets': \{ run: \(\) => setPresetsOpen\(true\) \}/)
    expect(app).toMatch(/writeSavedPresets\(next\)/)
    expect(app).toMatch(/applyTree\(applySaved\(p, tabIds, active\)\)/)
  })
})
