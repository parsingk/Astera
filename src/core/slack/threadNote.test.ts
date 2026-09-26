import { describe, it, expect } from 'vitest'
import { notedThreadOf, threadNotePatch } from './threadNote'

describe('threadNote (spec S5)', () => {
  it('reads a thread only when both keys are strings', () => {
    expect(notedThreadOf({ slackThreadTs: '1.2', slackChannel: 'C1' })).toEqual({ ts: '1.2', channel: 'C1' })
    for (const r of [{}, { slackThreadTs: '1.2' }, { slackThreadTs: null, slackChannel: null }, { slackThreadTs: 1, slackChannel: 'C1' }])
      expect(notedThreadOf(r)).toBeNull()
  })
  it('patches both keys, or drops both', () => {
    expect(threadNotePatch({ ts: '1.2', channel: 'C1' })).toEqual({ slackThreadTs: '1.2', slackChannel: 'C1' })
    expect(threadNotePatch(null)).toEqual({ slackThreadTs: null, slackChannel: null })
  })
})
