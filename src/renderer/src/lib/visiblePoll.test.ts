import { describe, it, expect, vi } from 'vitest'
import { pollWhileVisible } from './visiblePoll'

// Performance audit R2: the token usage poll re-read and re-set its state every 3 s, re-rendering the whole app, also
// while the window was hidden. It now asks nothing while hidden and asks once as the window shows again.
describe('pollWhileVisible', () => {
  const fakeDoc = () => {
    const t = new EventTarget() as EventTarget & { hidden: boolean }
    t.hidden = false
    return t
  }

  it('asks now and every interval while shown, nothing while hidden, and once as it shows again', async () => {
    vi.useFakeTimers()
    try {
      const doc = fakeDoc()
      let n = 0
      const stop = pollWhileVisible(() => void n++, 3_000, doc)
      expect(n).toBe(1)
      vi.advanceTimersByTime(3_000)
      expect(n).toBe(2)
      doc.hidden = true
      doc.dispatchEvent(new Event('visibilitychange'))
      vi.advanceTimersByTime(30_000)
      expect(n).toBe(2)
      doc.hidden = false
      doc.dispatchEvent(new Event('visibilitychange'))
      expect(n).toBe(3)
      stop()
      vi.advanceTimersByTime(30_000)
      doc.dispatchEvent(new Event('visibilitychange'))
      expect(n).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })
})
