import { describe, it, expect } from 'vitest'
import { paletteKey } from './paletteKey'

describe('paletteKey', () => {
  it('closes on Escape', () => {
    expect(paletteKey('Escape', 0, 3, false)).toEqual({ do: 'close' })
  })

  it('moves the selection with the arrows, wrapping at both ends', () => {
    expect(paletteKey('ArrowDown', 0, 3, false)).toEqual({ do: 'select', index: 1 })
    expect(paletteKey('ArrowDown', 2, 3, false)).toEqual({ do: 'select', index: 0 })
    expect(paletteKey('ArrowUp', 0, 3, false)).toEqual({ do: 'select', index: 2 })
  })

  it('chooses the selected row on Enter, and keeps the key when there is none', () => {
    expect(paletteKey('Enter', 1, 3, false)).toEqual({ do: 'choose', index: 1 })
    expect(paletteKey('Enter', -1, 0, false)).toEqual({ do: 'keep' })
    expect(paletteKey('ArrowDown', -1, 0, false)).toEqual({ do: 'keep' })
  })

  it('keeps Tab, so focus cannot leave the dialog for the workbench behind it', () => {
    expect(paletteKey('Tab', 0, 3, false)).toEqual({ do: 'keep' })
  })

  it('leaves every other key, and every key while an IME is composing, to the box', () => {
    expect(paletteKey('a', 0, 3, false)).toBeNull()
    expect(paletteKey('Backspace', 0, 3, false)).toBeNull()
    expect(paletteKey('Enter', 0, 3, true)).toBeNull()
    expect(paletteKey('Escape', 0, 3, true)).toBeNull()
  })
})
