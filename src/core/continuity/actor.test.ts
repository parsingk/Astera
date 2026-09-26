import { describe, it, expect } from 'vitest'
import { APP_CALLER, HOST_CALLER } from '../host/driver'
import { emptyState, type OrchState } from '../orchestration/state'
import { actorFromJson, actorOf, commitStamp, isJournalActor } from './actor'

describe('the journal actor (J4)', () => {
  it('reads the four surfaces, with or without a session', () => {
    expect(actorFromJson('{"surface":"cli"}')).toEqual({ surface: 'cli' })
    expect(actorFromJson('{"surface":"agent","sessionId":"ses_1"}')).toEqual({ surface: 'agent', sessionId: 'ses_1' })
    for (const s of ['desktop', 'cli', 'agent', 'host']) expect(isJournalActor({ surface: s })).toBe(true)
  })
  it('reads a v2 row, a foreign surface and broken JSON as unknown (null), inferring nothing', () => {
    expect(actorFromJson(null)).toBeNull()
    expect(actorFromJson(undefined)).toBeNull()
    expect(actorFromJson('{"surface":"robot"}')).toBeNull()
    expect(actorFromJson('{"surface":"cli","sessionId":7}')).toBeNull()
    expect(actorFromJson('{')).toBeNull()
  })
})

describe('actorOf (J4, P5)', () => {
  const NOW = '2026-09-26T10:00:00.000Z'
  const state = {
    ...emptyState(),
    dispatches: [{ id: 'dsp_1', sessionId: 'ses_w' }, { id: 'dsp_0', sessionId: 'ses_old', endedAt: NOW }],
    runs: [{ id: 'run_1', coordinatorSessionId: 'ses_c' }]
  } as unknown as OrchState

  it('the app is named by its connection’s role', () => {
    expect(actorOf({ sessionId: '', role: 'app', state })).toEqual({ surface: 'desktop' })
    expect(actorOf({ sessionId: APP_CALLER, role: 'app', state })).toEqual({ surface: 'desktop' })
  })
  // Final review M1: the reserved caller ids are one environment variable away for any shell or agent.
  // Only the app's own connection counts as the desktop; the Host's own commands never come through here.
  it('a caller that is not the app claiming a reserved caller id is the CLI', () => {
    for (const sessionId of [HOST_CALLER, APP_CALLER]) {
      expect(actorOf({ sessionId, role: 'cli', state })).toEqual({ surface: 'cli', sessionId })
      expect(actorOf({ sessionId, state })).toEqual({ surface: 'cli', sessionId })
    }
  })
  it('a session with an open Dispatch or a Run to coordinate is an agent', () => {
    expect(actorOf({ sessionId: 'ses_w', role: 'cli', state })).toEqual({ surface: 'agent', sessionId: 'ses_w' })
    expect(actorOf({ sessionId: 'ses_c', role: 'cli', state })).toEqual({ surface: 'agent', sessionId: 'ses_c' })
  })
  it('anything else is the CLI, with its session when it has one', () => {
    expect(actorOf({ sessionId: '', role: 'cli', state })).toEqual({ surface: 'cli' })
    expect(actorOf({ sessionId: 'ses_old', role: 'cli', state })).toEqual({ surface: 'cli', sessionId: 'ses_old' })
    expect(actorOf({ sessionId: 'ses_w', state: null })).toEqual({ surface: 'cli', sessionId: 'ses_w' })
  })
  it('a stamp names the Host life and the version (P1)', () => {
    expect(commitStamp('2026-09-26T01:00:00.000Z', 5)).toBe('2026-09-26T01:00:00.000Z#5')
    expect(commitStamp('2026-09-26T01:00:00.000Z', 'load')).toBe('2026-09-26T01:00:00.000Z#load')
    expect(commitStamp('a', 5)).not.toBe(commitStamp('b', 5))
  })
})
