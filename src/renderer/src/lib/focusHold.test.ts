import { describe, it, expect, vi, afterEach } from 'vitest'
import { activationFocusHeld, focusGivenByApp, giveFocus, holdActivationFocus } from './focusHold'

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

// Test matrix T17, finding A1, review: the palette closing gave the focus back to a plugin panel, whose focus event read
// as the person moving into it and put its pane back as the active one, undoing "focus left pane" picked in the palette.
// Electron confirms a guest's focus a moment after focus() returns, with a focus event of its own (measured on the hidden
// desktop: 2 ms), so the mark lasts a moment rather than the call.
describe('focus the app gives back', () => {
  afterEach(() => vi.useRealTimers())

  it('marks the element it gives the focus to for a moment, and no other', () => {
    vi.useFakeTimers()
    const a = { focus: vi.fn() }
    const b = { focus: vi.fn() }
    expect(focusGivenByApp(a)).toBe(false)
    giveFocus(a)
    expect(a.focus).toHaveBeenCalledTimes(1)
    expect(focusGivenByApp(a)).toBe(true)
    expect(focusGivenByApp(b)).toBe(false)
    vi.advanceTimersByTime(501)
    expect(focusGivenByApp(a)).toBe(false)
  })

  it('marks it before the element takes the focus, so an event fired inside focus() is the app’s too', () => {
    const seen: boolean[] = []
    const el: { focus: () => void } = { focus: () => void seen.push(focusGivenByApp(el)) }
    giveFocus(el)
    expect(seen).toEqual([true])
  })
})
