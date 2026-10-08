// Second pass R2-1: every keystroke in the file editor built the whole document as a string and stored it in App's
// state, drawing App and every pane under it again. The text goes on a short coalesce instead, and anything that
// reads the buffer (save, close, an outside change) flushes what is pending first.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createEchoLedger, createEditCoalescer, flushPendingEdits, EDIT_COALESCE_MS, EDIT_MAX_WAIT_MS } from './editCoalescer'

afterEach(() => vi.useRealTimers())

describe('createEditCoalescer', () => {
  it('reads and sends the text once for a burst of edits', async () => {
    vi.useFakeTimers()
    let reads = 0
    const sent: string[] = []
    const c = createEditCoalescer({ read: () => (reads++, 'abc'), send: (t) => sent.push(t) })
    c.changed()
    c.changed()
    c.changed()
    expect(sent).toEqual([])
    await vi.advanceTimersByTimeAsync(EDIT_COALESCE_MS)
    expect(sent).toEqual(['abc'])
    expect(reads).toBe(1)
    c.dispose()
  })

  // Final review C1: the timer was started at the first key and never moved, so a flush landed every 120 ms in the
  // middle of typing. A burst waits while keys keep coming, up to EDIT_MAX_WAIT_MS.
  it('waits while keys keep coming, and sends at the latest after the longest wait', async () => {
    vi.useFakeTimers()
    const sent: string[] = []
    const c = createEditCoalescer({ read: () => 't', send: (t) => sent.push(t) })
    for (let i = 0; i < 5; i++) {
      c.changed()
      await vi.advanceTimersByTimeAsync(EDIT_COALESCE_MS - 20)
    }
    expect(sent).toEqual([])
    for (let elapsed = 5 * (EDIT_COALESCE_MS - 20); elapsed < EDIT_MAX_WAIT_MS; elapsed += EDIT_COALESCE_MS - 20) {
      c.changed()
      await vi.advanceTimersByTimeAsync(EDIT_COALESCE_MS - 20)
    }
    expect(sent).toEqual(['t'])
    c.dispose()
  })

  it('a flush sends what is pending now, and nothing when nothing is', () => {
    vi.useFakeTimers()
    const sent: string[] = []
    const c = createEditCoalescer({ read: () => 'x', send: (t) => sent.push(t) })
    c.flush()
    expect(sent).toEqual([])
    c.changed()
    c.flush()
    expect(sent).toEqual(['x'])
    vi.advanceTimersByTime(EDIT_COALESCE_MS)
    expect(sent).toEqual(['x'])
    c.dispose()
  })

  it('flushPendingEdits sends every editor’s pending text, before App reads its buffers', () => {
    vi.useFakeTimers()
    const sent: string[] = []
    const a = createEditCoalescer({ read: () => 'a', send: (t) => sent.push(t) })
    const b = createEditCoalescer({ read: () => 'b', send: (t) => sent.push(t) })
    a.changed()
    b.changed()
    flushPendingEdits()
    expect(sent.sort()).toEqual(['a', 'b'])
    a.dispose()
    b.dispose()
  })

  it('a disposed coalescer sends nothing more', () => {
    vi.useFakeTimers()
    const sent: string[] = []
    const c = createEditCoalescer({ read: () => 'x', send: (t) => sent.push(t) })
    c.changed()
    c.dispose()
    flushPendingEdits()
    vi.advanceTimersByTime(EDIT_COALESCE_MS)
    expect(sent).toEqual([])
  })
})

// Final review C1: App's copy of the text comes back to the editor after a render that can trail the keys typed since.
// The editor took that echo for an outside change and replaced its document: keys lost, cursor to the start, undo gone.
describe('createEchoLedger', () => {
  it('knows its own text coming back, however late, and an outside text as outside', () => {
    const l = createEchoLedger()
    l.sent('abc')
    l.sent('abcd')
    expect(l.isEcho('abc')).toBe(true)
    expect(l.isEcho('abcd')).toBe(true)
    expect(l.isEcho('from disk')).toBe(false)
  })

  it('an echo forgets what was sent before it, so an old text returning later is outside', () => {
    const l = createEchoLedger()
    l.sent('a')
    l.sent('ab')
    expect(l.isEcho('ab')).toBe(true)
    expect(l.isEcho('a')).toBe(false)
  })
})
