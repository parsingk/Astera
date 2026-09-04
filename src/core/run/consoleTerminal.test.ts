import { describe, it, expect } from 'vitest'
import { consoleTerminalOptions, findHighlightPaint } from './consoleTerminal'

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
      theme: { ...theme, selectionBackground: '#d9a44166' }
    })
  })

  // The find bar's active match sits inside xterm's selection, so whatever the selection paints is what
  // the active match looks like. It is the alpha form of the find highlight (see findHighlightPaint),
  // which xterm blends against this same background to the decorations' opaque colour.
  it('takes its selection colour from the find highlight', () => {
    expect(consoleTerminalOptions({ fontFamily: 'monospace', theme, findHighlight: '#d9a441' }).theme.selectionBackground).toBe('#d9a44166')
  })

  it('passes a colour it cannot add an alpha to through unchanged', () => {
    expect(consoleTerminalOptions({ fontFamily: 'monospace', theme, findHighlight: 'rgb(217, 164, 65)' }).theme.selectionBackground).toBe(
      'rgb(217, 164, 65)'
    )
  })
})

describe('findHighlightPaint', () => {
  // Measured against this xterm: a decoration keeps only the RGB it is given while a selection blends
  // the alpha, so the two forms below are what make one colour out of the two paint paths.
  it('blends the decoration colour and leaves the selection to xterm', () => {
    expect(findHighlightPaint({ highlight: '#d9a441', background: '#000000', outline: '#fafafa' })).toEqual({
      decorationBackground: '#57421a',
      selectionBackground: '#d9a44166',
      activeBorder: '#fafafa',
      ruler: '#d9a441'
    })
  })

  it('blends against a background that is not black', () => {
    // 0.4 of each channel over #17171a: r 217*.4 + 23*.6 = 101 (0x65), g 164*.4 + 23*.6 = 79 (0x4f),
    // b 65*.4 + 26*.6 = 42 (0x2a)
    expect(findHighlightPaint({ highlight: '#d9a441', background: '#17171a', outline: '#fafafa' }).decorationBackground).toBe('#654f2a')
  })

  it('falls back to the highlight itself when a colour cannot be blended', () => {
    const out = findHighlightPaint({ highlight: 'rgb(217, 164, 65)', background: '#000000', outline: '#fafafa' })
    expect(out.decorationBackground).toBe('rgb(217, 164, 65)')
    expect(out.selectionBackground).toBe('rgb(217, 164, 65)')
  })
})
