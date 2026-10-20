import { describe, it, expect } from 'vitest'
import { AGENT_TAB_CLOSE_DELAY_MS, AGENT_TAB_LOST_SIGHT_CLOSE_MS, closesWhenEnded } from './agentTab'
import { PTY_LOST_SIGHT_EXIT_CODE } from './pty'

// 2026-10-20: a session an agent started closes its tab when it ends; a person's tab stays
describe('closesWhenEnded', () => {
  const agent = { status: 'exited' as const, exitCode: 0, startedBy: 'agent' as const }

  it('is true for an agent’s session that ended, whatever its code', () => {
    expect(closesWhenEnded(agent)).toBe(true)
    expect(closesWhenEnded({ ...agent, exitCode: 1 })).toBe(true)
    expect(closesWhenEnded({ ...agent, exitCode: undefined })).toBe(true)
  })

  it('is false while it runs, for a person’s session, and for a session no longer known', () => {
    expect(closesWhenEnded({ ...agent, status: 'running' })).toBe(false)
    expect(closesWhenEnded({ status: 'exited', exitCode: 0 })).toBe(false)
    expect(closesWhenEnded(undefined)).toBe(false)
  })

  // The app lost sight of the Host: the session still runs there, and the reconnect brings it back under its id
  it('is false for an exit that only says the app lost sight of a Host session', () => {
    expect(closesWhenEnded({ ...agent, exitCode: PTY_LOST_SIGHT_EXIT_CODE })).toBe(false)
  })

  // Review M5: a session that really ended while the app could not see the Host stays exited with that code, and a
  // reconnect that does not hand it back says nothing more; past the longer wait it is gone
  it('is true for a lost-sight exit once the longer wait has passed', () => {
    expect(closesWhenEnded({ ...agent, exitCode: PTY_LOST_SIGHT_EXIT_CODE }, { afterLostSight: true })).toBe(true)
    expect(closesWhenEnded({ ...agent, status: 'running', exitCode: PTY_LOST_SIGHT_EXIT_CODE }, { afterLostSight: true })).toBe(false)
    expect(AGENT_TAB_LOST_SIGHT_CLOSE_MS).toBeGreaterThan(AGENT_TAB_CLOSE_DELAY_MS)
  })
})
