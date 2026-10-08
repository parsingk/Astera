import { describe, it, expect } from 'vitest'
import { clockFor } from './runClock'

// Audit UI-11: the Jobs sidebar ticked once a second while anything ran, and every Run card drew again on each tick,
// the finished ones too. A card with nothing running is handed a clock that does not move, so it is not drawn again.
describe('clockFor', () => {
  const running = { tasks: [{ startedAt: '2026-10-09T00:00:00Z' }] }
  const waiting = { tasks: [{ waiting: { resetsAt: '2026-10-09T01:00:00Z' } }] }
  const done = { tasks: [{ startedAt: undefined }] }
  it('is the clock for a Run with a task running or waiting', () => {
    expect(clockFor(running, 1234)).toBe(1234)
    expect(clockFor(waiting, 1234)).toBe(1234)
  })
  it('is a fixed value for a Run with nothing running', () => {
    expect(clockFor(done, 1234)).toBe(clockFor(done, 9999))
  })
})
