import { describe, it, expect } from 'vitest'
import { consoleTerminalOptions } from './consoleTerminal'

const theme = { background: '#000000', foreground: '#d0d0d6', cursor: '#37b0c4' }

describe('consoleTerminalOptions', () => {
  // The regression this module exists for: without it, every findNext throws before it selects or
  // highlights anything, the throw goes to the renderer console, and the find bar silently does
  // nothing. Reproduced against this xterm and addon: with the flag, findNext returns true, the addon
  // reports its result count, and the matches carry decorations.
  it('allows proposed API, which is what the search addon decorates through', () => {
    expect(consoleTerminalOptions({ fontFamily: 'monospace', theme, findHighlight: '#d9a441' }).allowProposedApi).toBe(true)
  })

  it('carries the font and theme it is given, and the console defaults', () => {
    expect(consoleTerminalOptions({ fontFamily: 'JetBrains Mono', theme, findHighlight: '#d9a441' })).toEqual({
      fontSize: 13,
      fontFamily: 'JetBrains Mono',
      scrollback: 5000,
      allowProposedApi: true,
      theme: { ...theme, selectionBackground: '#d9a4418c' }
    })
  })

  // The find bar's active match sits inside xterm's selection, and the DOM renderer lets the selection
  // win over a decoration's background — so without a selection colour of our own the active match
  // drew in xterm's default grey while the others drew amber. Same hue, stronger alpha.
  it('takes its selection colour from the find highlight', () => {
    expect(consoleTerminalOptions({ fontFamily: 'monospace', theme, findHighlight: '#d9a441' }).theme.selectionBackground).toBe('#d9a4418c')
  })

  it('passes a colour it cannot add an alpha to through unchanged', () => {
    expect(consoleTerminalOptions({ fontFamily: 'monospace', theme, findHighlight: 'rgb(217, 164, 65)' }).theme.selectionBackground).toBe(
      'rgb(217, 164, 65)'
    )
  })
})
