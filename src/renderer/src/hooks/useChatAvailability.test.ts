import { describe, it, expect } from 'vitest'
import { chatAvailabilityOf } from './useChatAvailability'

describe('chatAvailabilityOf', () => {
  it('a Codex account can start 대화 once the Host speaks proc', () => {
    expect(chatAvailabilityOf({ hostOk: true })).toEqual({
      hostOk: true,
      reason: null,
      enabled: true
    })
  })

  it('a Claude account can start 대화 once the Host speaks proc, same as Codex', () => {
    expect(chatAvailabilityOf({ hostOk: true })).toEqual({
      hostOk: true,
      reason: null,
      enabled: true
    })
  })

  it('the Host is the only reason it can be unavailable', () => {
    expect(chatAvailabilityOf({ hostOk: false })).toEqual({ hostOk: false, reason: 'host', enabled: false })
  })
})
