import { describe, it, expect } from 'vitest'
import { chatAvailabilityOf } from './useChatAvailability'

describe('chatAvailabilityOf', () => {
  it('a Codex account with a Host that has proc can start 대화', () => {
    expect(chatAvailabilityOf({ hostOk: true, provider: 'codex' })).toEqual({
      hostOk: true,
      reason: null,
      enabled: true
    })
  })

  it('a Claude account is told about the account, even while the Host is still connecting', () => {
    expect(chatAvailabilityOf({ hostOk: false, provider: 'claude' }).reason).toBe('provider')
    expect(chatAvailabilityOf({ hostOk: true, provider: 'claude' }).reason).toBe('provider')
  })

  it('the Host is the reason only once the account is not', () => {
    const a = chatAvailabilityOf({ hostOk: false, provider: 'codex' })
    expect(a).toEqual({ hostOk: false, reason: 'host', enabled: false })
  })
})
