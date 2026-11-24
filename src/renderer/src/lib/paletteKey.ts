// The keys the command palette answers itself. Everything else goes to its box as typing, and nothing is answered
// while an IME is composing (Enter then commits the composition, it does not run a row).

export type PaletteKeyOutcome =
  | { do: 'close' }
  | { do: 'select'; index: number }
  | { do: 'choose'; index: number }
  /** Taken, with nothing to do: Tab (focus must not leave the dialog), or Enter and the arrows on an empty list. */
  | { do: 'keep' }

export function paletteKey(key: string, selected: number, count: number, composing: boolean): PaletteKeyOutcome | null {
  if (composing) return null
  if (key === 'Escape') return { do: 'close' }
  if (key === 'Tab') return { do: 'keep' }
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    if (count === 0) return { do: 'keep' }
    const step = key === 'ArrowDown' ? 1 : -1
    return { do: 'select', index: (selected + step + count) % count }
  }
  if (key === 'Enter') return selected >= 0 && selected < count ? { do: 'choose', index: selected } : { do: 'keep' }
  return null
}
