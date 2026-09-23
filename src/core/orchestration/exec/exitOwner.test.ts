import { describe, it, expect } from 'vitest'
import { EXIT_DEFER_MS, hostOwnsExit } from './exitOwner'

describe('hostOwnsExit', () => {
  it('owns the exit of an agent session no app holds', () => {
    expect(hostOwnsExit({ kind: 'session', heldByApp: false })).toBe(true)
  })
  it('leaves the exit of an agent session an app holds to that app', () => {
    expect(hostOwnsExit({ kind: 'session', heldByApp: true })).toBe(false)
  })
  it('never owns the exit of a pty that is not an agent session', () => {
    expect(hostOwnsExit({ kind: 'terminal', heldByApp: false })).toBe(false)
    expect(hostOwnsExit({ kind: 'terminal', heldByApp: true })).toBe(false)
  })
  it('never owns the exit of a pty opened without a note', () => {
    expect(hostOwnsExit({ kind: null, heldByApp: false })).toBe(false)
  })
  it('defers an exit by the window the app and Slack use', () => {
    expect(EXIT_DEFER_MS).toBe(3_000)
  })
})
