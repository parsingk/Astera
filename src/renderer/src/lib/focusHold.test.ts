import { describe, it, expect, vi, afterEach } from 'vitest'
import { activationFocusHeld, holdActivationFocus } from './focusHold'

// Agent tabs close on exit (2026-10-20), review M4: when the app closes the tab a person is looking at, the tab beside it
// becomes active, and a terminal takes focus as it activates. Held for a moment, the keys a person goes on typing do
// not land in that terminal — another worker's permission prompt, say — until they click it.
describe('the activation focus hold', () => {
  afterEach(() => vi.useRealTimers())
  it('is held for the moment given and free after it', () => {
    vi.useFakeTimers()
    expect(activationFocusHeld()).toBe(false)
    holdActivationFocus(1000)
    expect(activationFocusHeld()).toBe(true)
    vi.advanceTimersByTime(1001)
    expect(activationFocusHeld()).toBe(false)
  })
})
