// The window's layout and the person's saved layout presets (spec W3), kept in localStorage beside the other cm.* keys:
// window state that only this renderer reads, read synchronously before the first paint. What reads as a layout and
// what does not is core/panes/savedLayout.ts and presets.ts; this file only reaches storage, and treats storage that is
// off, full or throwing as holding nothing, so a layout can never stop the window from opening.

import { readSaved, type SavedLayout } from '../../../core/panes/savedLayout'
import { readPresets, toPresetsRecord, type SavedPreset } from '../../../core/panes/presets'

const LAYOUT_KEY = 'cm.layout'
const PRESETS_KEY = 'cm.layoutPresets'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage off or full: the window opens with the default layout next time, as it always did.
  }
}

export const readLayout = (): SavedLayout | null => readSaved(read(LAYOUT_KEY))
export const writeLayout = (layout: SavedLayout): void => write(LAYOUT_KEY, layout)
export const readSavedPresets = (): SavedPreset[] => readPresets(read(PRESETS_KEY))
export const writeSavedPresets = (list: readonly SavedPreset[]): void => write(PRESETS_KEY, toPresetsRecord(list))
