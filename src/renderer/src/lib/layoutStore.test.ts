import { describe, it, expect, afterEach, vi } from 'vitest'
import { toSaved, type SavedPanels } from '../../../core/panes/savedLayout'
import { createGroup } from '../../../core/panes/tree'
import { clearLayout, readLayout, readSavedPresets, writeLayout, writeSavedPresets } from './layoutStore'

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: () => null,
    get length() {
      return data.size
    }
  }
}

const throwing: Storage = {
  getItem: () => {
    throw new Error('storage off')
  },
  setItem: () => {
    throw new Error('quota')
  },
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0
}

const panels: SavedPanels = { sidebar: { open: true, view: 'jobs' }, bottom: { open: true, tab: 'kube' } }

afterEach(() => vi.unstubAllGlobals())

describe('layout store', () => {
  it('round-trips a layout and the saved presets', () => {
    vi.stubGlobal('localStorage', memoryStorage())
    const g = createGroup('session:s1')
    const layout = toSaved(g, g.id, panels, { files: {}, records: {}, browsers: {}, plugins: {} })
    writeLayout(layout)
    expect(readLayout()).toEqual(layout)
    writeSavedPresets([{ name: 'Mine', tree: layout.tree, panels, sidebarWidth: 300, bottomHeight: 300 }])
    expect(readSavedPresets().map((p) => p.name)).toEqual(['Mine'])
  })

  it('reads nothing when storage throws', () => {
    vi.stubGlobal('localStorage', throwing)
    expect(readLayout()).toBeNull()
    expect(readSavedPresets()).toEqual([])
  })

  it('writes nothing and does not throw when storage throws', () => {
    vi.stubGlobal('localStorage', throwing)
    const g = createGroup('session:s1')
    expect(() => writeLayout(toSaved(g, g.id, panels, { files: {}, records: {}, browsers: {}, plugins: {} }))).not.toThrow()
    expect(() => writeSavedPresets([])).not.toThrow()
  })

  it('reads junk under its keys as nothing saved', () => {
    vi.stubGlobal('localStorage', memoryStorage({ 'cm.layout': '{"v":1,"tree":7}', 'cm.layoutPresets': 'nope' }))
    expect(readLayout()).toBeNull()
    expect(readSavedPresets()).toEqual([])
  })
})

// Phase 1 gate: turning layout memory off deletes the saved layout, and only that
describe('clearLayout', () => {
  it('removes the window layout and keeps the saved presets', () => {
    vi.stubGlobal('localStorage', memoryStorage({ 'cm.layout': '{}', 'cm.layoutPresets': '{}', 'cm.sidebarWidth': '300' }))
    clearLayout()
    expect(localStorage.getItem('cm.layout')).toBeNull()
    expect(localStorage.getItem('cm.layoutPresets')).toBe('{}')
    expect(localStorage.getItem('cm.sidebarWidth')).toBe('300')
  })

  it('does not throw when storage throws', () => {
    vi.stubGlobal('localStorage', {
      ...throwing,
      removeItem: () => {
        throw new Error('storage off')
      }
    })
    expect(() => clearLayout()).not.toThrow()
  })
})
