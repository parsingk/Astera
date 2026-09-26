import { describe, it, expect } from 'vitest'
import { actorFromJson, isJournalActor } from './actor'

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
