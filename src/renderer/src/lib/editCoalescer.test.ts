// Second pass R2-1: every keystroke in the file editor built the whole document as a string and stored it in App's
// state, drawing App and every pane under it again. The text goes on a short coalesce instead, and anything that
// reads the buffer (save, close, an outside change) flushes what is pending first.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createEditCoalescer, flushPendingEdits, EDIT_COALESCE_MS } from './editCoalescer'

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
