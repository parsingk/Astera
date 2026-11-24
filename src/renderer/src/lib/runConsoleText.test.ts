import { describe, it, expect } from 'vitest'
import { readRunConsole, registerRunConsole } from './runConsoleText'

describe('run console registry', () => {
  it('reads what a run console registered, and nothing once it let go', () => {
    expect(readRunConsole('r1')).toBeNull()
    const off = registerRunConsole('r1', () => ({ selection: 'sel', tail: ['a'] }))
    expect(readRunConsole('r1')).toEqual({ selection: 'sel', tail: ['a'] })
    off()
    expect(readRunConsole('r1')).toBeNull()
  })

  it('does not let an old console unregister a newer one for the same run', () => {
    const offOld = registerRunConsole('r2', () => ({ selection: 'old', tail: [] }))
    registerRunConsole('r2', () => ({ selection: 'new', tail: [] }))
    offOld()
    expect(readRunConsole('r2')?.selection).toBe('new')
  })

  it('answers null when the console cannot be read', () => {
    registerRunConsole('r3', () => {
      throw new Error('disposed')
    })
    expect(readRunConsole('r3')).toBeNull()
  })
})
