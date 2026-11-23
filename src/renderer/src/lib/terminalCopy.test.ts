// The project terminal (TerminalBody, the bottom panel's tabs the rail's terminal button opens) had no copy key: Ctrl+C over
// a selection reached the shell as an interrupt and nothing was copied (2026-11-19). These drive the real xterm.js the
// renderer ships (xtermFixtures.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openXterm, type Xterm } from './xtermFixtures'
import { selectionCopy } from './terminalCopy'

let x: Xterm
let copied: string[]
let copy: { key: (e: KeyboardEvent) => boolean; dispose: () => void }
const wire = (isMac: boolean): void => {
  copy = selectionCopy(x.term, { isMac, writeText: (text) => copied.push(text) })
  x.term.attachCustomKeyEventHandler(copy.key)
}
const write = (data: string): Promise<void> =>
  new Promise((resolve) => {
    x.term.write(data, () => resolve())
    vi.runAllTimers()
  })
const ctrlC = (): void => {
  x.key('c', 67, { ctrlKey: true })
  vi.runAllTimers()
}

beforeEach(() => {
  vi.useFakeTimers()
  x = openXterm()
  vi.runAllTimers()
  copied = []
})
afterEach(() => {
  copy.dispose()
  x.dispose()
  vi.useRealTimers()
})

describe('selectionCopy', () => {
  it('Ctrl+C over a selection copies it, clears it, and sends the shell nothing', async () => {
    wire(false)
    await write('hello world')
    x.term.select(0, 0, 5)
    ctrlC()
    expect(copied).toEqual(['hello'])
    expect(x.sent).toEqual([])
    expect(x.term.hasSelection()).toBe(false)
  })

  it('Ctrl+C with nothing selected still interrupts the shell and leaves the clipboard alone', async () => {
    wire(false)
    await write('hello world')
    ctrlC()
    expect(x.sent).toEqual(['\x03'])
    expect(copied).toEqual([])
  })

  it('copies what was selected even after the screen is drawn over', async () => {
    wire(false)
    await write('hello world')
    x.term.select(0, 0, 5)
    await write('\x1b[H\x1b[2J')
    ctrlC()
    expect(copied).toEqual(['hello'])
    expect(x.sent).toEqual([])
  })

  it('on macOS Ctrl+C is the interrupt even over a selection, since Cmd+C is the copy key there', async () => {
    wire(true)
    await write('hello world')
    x.term.select(0, 0, 5)
    ctrlC()
    expect(x.sent).toEqual(['\x03'])
    expect(copied).toEqual([])
  })
})
