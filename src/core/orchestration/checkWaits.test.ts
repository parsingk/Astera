import { describe, it, expect } from 'vitest'
import { createCheckWaits } from './checkWaits'

describe('createCheckWaits (final round 2, I-A)', () => {
  it('is parked only between entry and exit, per Run and session', () => {
    const w = createCheckWaits()
    expect(w.parked('run_1', 'coord')).toBe(false)
    const leave = w.enter('run_1', 'coord')
    expect(w.parked('run_1', 'coord')).toBe(true)
    expect(w.parked('run_2', 'coord')).toBe(false)
    expect(w.parked('run_1', 'other')).toBe(false)
    leave()
    expect(w.parked('run_1', 'coord')).toBe(false)
  })

  it('counts overlapping waits, and a second exit call does nothing', () => {
    const w = createCheckWaits()
    const a = w.enter('run_1', 'coord')
    const b = w.enter('run_1', 'coord')
    a()
    a()
    expect(w.parked('run_1', 'coord')).toBe(true)
    b()
    expect(w.parked('run_1', 'coord')).toBe(false)
  })
})
