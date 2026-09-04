import { describe, it, expect } from 'vitest'
import { consoleTerminalOptions } from './consoleTerminal'

const theme = { background: '#000000', foreground: '#d0d0d6', cursor: '#37b0c4' }

describe('consoleTerminalOptions', () => {
  // The regression this module exists for: without it, every findNext throws before it selects or
  // highlights anything, the throw goes to the renderer console, and the find bar silently does
  // nothing. Reproduced against this xterm and addon: with the flag, findNext returns true, the addon
  // reports its result count, and the matches carry decorations.
  it('allows proposed API, which is what the search addon decorates through', () => {
    expect(consoleTerminalOptions({ fontFamily: 'monospace', theme }).allowProposedApi).toBe(true)
  })

  it('carries the font and theme it is given, and the console defaults', () => {
    expect(consoleTerminalOptions({ fontFamily: 'JetBrains Mono', theme })).toEqual({
      fontSize: 13,
      fontFamily: 'JetBrains Mono',
      scrollback: 5000,
      allowProposedApi: true,
      theme
    })
  })
})
