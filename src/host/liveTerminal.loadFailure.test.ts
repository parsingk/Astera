// Second pass H2-3: a terminal library that failed to load was cached as failed, and every live pty then kept its
// whole output in the early buffer for good, never reported broken.
import { describe, it, expect, vi, afterEach } from 'vitest'

afterEach(() => {
  vi.doUnmock('@xterm/headless')
  vi.resetModules()
})

describe('a live terminal whose library does not load', () => {
  it('reports itself broken and keeps nothing, and the next terminal loads again', async () => {
    vi.resetModules()
    let fail = true
    vi.doMock('@xterm/headless', async (orig) => {
      if (fail) throw new Error('the runtime files are gone')
      return orig()
    })
    const { createLiveTerminal } = await import('./liveTerminal')
    const t = createLiveTerminal({ cols: 80, rows: 24 })
    await new Promise((r) => setTimeout(r, 20))
    expect(t.broken()).toBe(true)
    t.apply({ kind: 'data', seq: 1, data: 'x'.repeat(1024) })
    await expect(t.checkpoint()).rejects.toThrow()

    fail = false
    const again = createLiveTerminal({ cols: 80, rows: 24 })
    again.apply({ kind: 'data', seq: 1, data: 'hello' })
    const cp = await again.checkpoint()
    expect(cp.watermark).toBe(1)
    expect(again.broken()).toBe(false)
  })
})
