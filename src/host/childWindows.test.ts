import { describe, it, expect } from 'vitest'
import { hideForkedConsoleWindows, type ForkHolder } from './childWindows'

/** Records what the real `fork` would have been called with. Nothing is forked. */
function holder(): { cp: ForkHolder; calls: unknown[][] } {
  const calls: unknown[][] = []
  const cp = {
    fork: (...args: unknown[]) => {
      calls.push(args)
      return {} as never
    }
  } as unknown as ForkHolder
  return { cp, calls }
}

describe('hideForkedConsoleWindows', () => {
  it('adds windowsHide to the three-argument form node-pty uses', () => {
    const { cp, calls } = holder()
    expect(hideForkedConsoleWindows(cp, 'win32')).toBe(true)
    // Exactly node-pty's call: fork(agentPath, [pid]) — the kill path in windowsPtyAgent.js.
    cp.fork('C:/app/conpty_console_list_agent', ['4242'])
    expect(calls).toEqual([['C:/app/conpty_console_list_agent', ['4242'], { windowsHide: true }]])
  })

  it('keeps the options the caller already passed', () => {
    const { cp, calls } = holder()
    hideForkedConsoleWindows(cp, 'win32')
    cp.fork('m.js', ['a'], { cwd: 'C:/somewhere', silent: true })
    expect(calls[0][2]).toEqual({ cwd: 'C:/somewhere', silent: true, windowsHide: true })
  })

  it('handles fork(path, options) — the second argument is not always an args array', () => {
    const { cp, calls } = holder()
    hideForkedConsoleWindows(cp, 'win32')
    cp.fork('m.js', { cwd: 'C:/x' })
    expect(calls).toEqual([['m.js', { cwd: 'C:/x', windowsHide: true }]])
  })

  it('never lets a caller turn it back off', () => {
    const { cp, calls } = holder()
    hideForkedConsoleWindows(cp, 'win32')
    cp.fork('m.js', ['a'], { windowsHide: false } as never)
    expect((calls[0][2] as { windowsHide: boolean }).windowsHide).toBe(true)
  })

  it('leaves fork alone off win32 — there is no console window to hide', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const { cp, calls } = holder()
      const before = cp.fork
      expect(hideForkedConsoleWindows(cp, platform)).toBe(false)
      expect(cp.fork).toBe(before)
      cp.fork('m.js', ['a'])
      expect(calls).toEqual([['m.js', ['a']]])
    }
  })
})
