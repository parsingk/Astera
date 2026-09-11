import { describe, it, expect } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { fitTerminalToHost } from './fitTerminal'

/** Only the four things fitTerminalToHost reads, plus the resize it may call. */
const fakeTerm = (
  o: { cols?: number; rows?: number; cell?: { width: number; height: number } } = {}
): Terminal & { resized: Array<[number, number]> } => {
  const resized: Array<[number, number]> = []
  return {
    cols: o.cols ?? 80,
    rows: o.rows ?? 24,
    resize: (c: number, r: number) => resized.push([c, r]),
    resized,
    _core: { _renderService: { dimensions: { css: { cell: o.cell ?? { width: 8, height: 16 } } } } }
  } as unknown as Terminal & { resized: Array<[number, number]> }
}

const fakeHost = (clientWidth: number, clientHeight: number): HTMLElement =>
  ({ clientWidth, clientHeight }) as unknown as HTMLElement

describe('fitTerminalToHost', () => {
  it('fits the grid to the container', () => {
    const term = fakeTerm()
    expect(fitTerminalToHost(term, fakeHost(800, 480))).toBe(true)
    expect(term.resized).toEqual([[100, 30]])
  })

  it('reports no change when the grid already matches', () => {
    const term = fakeTerm({ cols: 100, rows: 30 })
    expect(fitTerminalToHost(term, fakeHost(800, 480))).toBe(false)
    expect(term.resized).toEqual([])
  })

  it('skips before xterm has computed its cell size', () => {
    const term = fakeTerm({ cell: { width: 0, height: 0 } })
    expect(fitTerminalToHost(term, fakeHost(800, 480))).toBe(false)
    expect(term.resized).toEqual([])
  })

  // A pane that is not on screen measures 0, and the clamps below would turn that into a 2x1 grid —
  // a real size as far as everything downstream is concerned. TerminalView sends the fitted size to
  // the PTY, and a 2x1 conpty kills the agent: measured, codex drew one character per line and the
  // pty ended with no exit code at all, about a second after it started. That is what three Job
  // workers in a row did, because a worker's tab opens behind the one already showing.
  it('does not fit a host that is not on screen', () => {
    const term = fakeTerm()
    expect(fitTerminalToHost(term, fakeHost(0, 0))).toBe(false)
    expect(term.resized).toEqual([])
  })

  it('does not fit when only one side has collapsed', () => {
    expect(fitTerminalToHost(fakeTerm(), fakeHost(800, 0))).toBe(false)
    expect(fitTerminalToHost(fakeTerm(), fakeHost(0, 480))).toBe(false)
  })
})
