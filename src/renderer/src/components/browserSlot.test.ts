import { describe, expect, it } from 'vitest'
import { browserSlotDraw } from './browserSlot'

describe('browserSlotDraw', () => {
  it('draws the tab the pane is showing', () => {
    expect(browserSlotDraw({}, true, {})).toBe('shown')
  })

  it('leaves a background tab undrawn', () => {
    expect(browserSlotDraw({}, false, {})).toBe('off')
  })

  it('draws an agent tab in the background while its script runs', () => {
    expect(browserSlotDraw({ agentSessionId: 's1' }, false, { s1: true })).toBe('drawn')
  })

  it('leaves an agent tab undrawn once its script is over', () => {
    expect(browserSlotDraw({ agentSessionId: 's1' }, false, {})).toBe('off')
    expect(browserSlotDraw({ agentSessionId: 's1' }, false, { s1: false })).toBe('off')
  })

  // The one that matters: two sessions, one script. Drawing every agent tab because *some* session
  // is busy would put a second invisible page in front of the user for no reason.
  it('does not draw one session tab because another session is busy', () => {
    expect(browserSlotDraw({ agentSessionId: 's2' }, false, { s1: true })).toBe('off')
  })

  it('is shown, not drawn, when the user is watching the agent work', () => {
    expect(browserSlotDraw({ agentSessionId: 's1' }, true, { s1: true })).toBe('shown')
  })
})
