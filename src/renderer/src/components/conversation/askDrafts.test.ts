import { describe, it, expect, beforeEach } from 'vitest'
import { rememberAskAnswers, recallAskAnswers, forgetOtherAskAnswers, resetAskDraftsForTest } from './askDrafts'

describe('askDrafts', () => {
  beforeEach(() => resetAskDraftsForTest())
  it('recalls what was remembered for the same call, null for another', () => {
    const a = [{ picks: [1], other: '' }]
    rememberAskAnswers('call-1', a)
    expect(recallAskAnswers('call-1')).toBe(a)
    expect(recallAskAnswers('call-2')).toBeNull()
  })
  it('forgetting others keeps only the named call', () => {
    rememberAskAnswers('call-1', [{ picks: [], other: 'x' }])
    rememberAskAnswers('call-2', [{ picks: [0], other: '' }])
    forgetOtherAskAnswers('call-2')
    expect(recallAskAnswers('call-1')).toBeNull()
    expect(recallAskAnswers('call-2')).toEqual([{ picks: [0], other: '' }])
  })
})
