import { describe, it, expect } from 'vitest'
import { chatAvailabilityOf } from './useChatAvailability'

describe('chatAvailabilityOf', () => {
  it('any account is enabled when the Host speaks proc', () => {
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
