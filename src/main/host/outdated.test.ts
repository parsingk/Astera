import { describe, it, expect } from 'vitest'
import { hostIsOutdated, hostSpeaksProcs, hostSpeaksPing, hostSpeaksSpawn, hostSpeaksWorktrees, hostSpeaksDispatch, hostSpeaksRolling, hostSpeaksBlocks } from './outdated'

describe('hostIsOutdated', () => {
  it('is true when the Host is strictly older than the app', () => {
    expect(hostIsOutdated('1.3.20', '1.3.21')).toBe(true)
    expect(hostIsOutdated('1.2.99', '1.3.0')).toBe(true)
    expect(hostIsOutdated('0.9.9', '1.0.0')).toBe(true)
  })

  it('is false for the same version', () => {
    expect(hostIsOutdated('1.3.21', '1.3.21')).toBe(false)
  })

  it('is false when the Host is newer — after a downgrade the app is the one behind', () => {
    expect(hostIsOutdated('1.3.21', '1.3.20')).toBe(false)
  })

  it('never calls an unreadable version outdated — that would be replacing a Host on a guess', () => {
    expect(hostIsOutdated(null, '1.3.21')).toBe(false)
    expect(hostIsOutdated('', '1.3.21')).toBe(false)
    expect(hostIsOutdated('dev', '1.3.21')).toBe(false)
    expect(hostIsOutdated('1.3.20-beta.1', '1.3.21')).toBe(false)
    expect(hostIsOutdated('1.3.20', 'unknown')).toBe(false)
  })
})

describe('hostSpeaksProcs', () => {
  it('is true for a connected Host that named the proc feature', () => {
    expect(hostSpeaksProcs({ connected: true, features: ['proc'] })).toBe(true)
  })

  it('is false for a connected Host that named no features at all — it predates proc-list', () => {
    expect(hostSpeaksProcs({ connected: true, features: [] })).toBe(false)
  })

  // Nothing to ask, whatever the last hello said: there is no connection to send proc-list on.
  it('is false while disconnected, even if the last hello named the feature', () => {
    expect(hostSpeaksProcs({ connected: false, features: ['proc'] })).toBe(false)
  })
})

describe('hostSpeaksPing', () => {
  it('is true for a connected Host that named the ping feature', () => {
    expect(hostSpeaksPing({ connected: true, features: ['proc', 'ping'] })).toBe(true)
  })

  // A Host from before the heartbeat logs a ping as an unknown message and says nothing back. Sending
  // one anyway and reading that silence as a fault would call a perfectly well Host unresponsive.
  it('is false for a Host that predates the heartbeat', () => {
    expect(hostSpeaksPing({ connected: true, features: ['proc'] })).toBe(false)
    expect(hostSpeaksPing({ connected: true, features: [] })).toBe(false)
  })

  it('is false while disconnected — there is nothing to ping on', () => {
    expect(hostSpeaksPing({ connected: false, features: ['ping'] })).toBe(false)
  })
})

describe('hostSpeaksSpawn', () => {
  it('hostSpeaksSpawn is the spawn feature on a connected Host', () => {
    expect(hostSpeaksSpawn({ connected: true, features: ['proc', 'spawn'] })).toBe(true)
    expect(hostSpeaksSpawn({ connected: true, features: ['proc'] })).toBe(false)
    expect(hostSpeaksSpawn({ connected: false, features: ['spawn'] })).toBe(false)
  })
})

describe('hostSpeaksWorktrees', () => {
  it('hostSpeaksWorktrees is the worktrees feature on a connected Host', () => {
    expect(hostSpeaksWorktrees({ connected: true, features: ['spawn', 'worktrees'] })).toBe(true)
    expect(hostSpeaksWorktrees({ connected: true, features: ['spawn'] })).toBe(false)
    expect(hostSpeaksWorktrees({ connected: false, features: ['spawn', 'worktrees'] })).toBe(false)
  })
})

describe('hostSpeaksDispatch', () => {
  it('hostSpeaksDispatch needs a connected Host that announced dispatch', () => {
    expect(hostSpeaksDispatch({ connected: true, features: ['spawn', 'worktrees', 'dispatch'] })).toBe(true)
    expect(hostSpeaksDispatch({ connected: true, features: ['spawn', 'worktrees'] })).toBe(false) // an S3 Host (D5)
    expect(hostSpeaksDispatch({ connected: false, features: ['dispatch'] })).toBe(false)
  })
  // Task 14 review I1: an unresponsive Host still drives (it sees a yielding app attached), so the app
  // keeps yielding until it answers, is replaced, or the connection drops.
  it('hostSpeaksDispatch stays true while a Host that announced dispatch is unresponsive', () => {
    expect(hostSpeaksDispatch({ connected: false, unresponsive: true, features: ['spawn', 'worktrees', 'dispatch'] })).toBe(true)
    expect(hostSpeaksDispatch({ connected: false, unresponsive: true, features: ['spawn', 'worktrees'] })).toBe(false)
    expect(hostSpeaksDispatch({ connected: false, unresponsive: false, features: ['spawn', 'worktrees', 'dispatch'] })).toBe(false)
  })
})

describe('hostSpeaksRolling', () => {
  it('hostSpeaksRolling needs a connected Host that announced rolling', () => {
    expect(hostSpeaksRolling({ connected: true, features: ['spawn', 'worktrees', 'dispatch', 'rolling'] })).toBe(true)
    expect(hostSpeaksRolling({ connected: true, features: ['spawn', 'worktrees', 'dispatch'] })).toBe(false) // an S4+S5 Host
    expect(hostSpeaksRolling({ connected: false, features: ['rolling'] })).toBe(false)
  })
  // The hostSpeaksDispatch rule: an unresponsive Host still rolls what it owns, so the app keeps yielding.
  it('hostSpeaksRolling stays true while a Host that announced rolling is unresponsive', () => {
    expect(hostSpeaksRolling({ connected: false, unresponsive: true, features: ['rolling'] })).toBe(true)
    expect(hostSpeaksRolling({ connected: false, unresponsive: true, features: ['dispatch'] })).toBe(false)
    expect(hostSpeaksRolling({ connected: false, unresponsive: false, features: ['rolling'] })).toBe(false)
  })
})

describe('hostSpeaksBlocks', () => {
  it('needs a Host that announced blocks, connected or unresponsive (the hostSpeaksRolling rule)', () => {
    expect(hostSpeaksBlocks({ connected: true, features: ['rolling', 'blocks'] })).toBe(true)
    expect(hostSpeaksBlocks({ connected: true, features: ['spawn', 'worktrees', 'dispatch', 'rolling'] })).toBe(false) // an S6 Host before Task 3
    expect(hostSpeaksBlocks({ connected: false, features: ['blocks'] })).toBe(false)
    expect(hostSpeaksBlocks({ connected: false, unresponsive: true, features: ['blocks'] })).toBe(true)
  })
})
