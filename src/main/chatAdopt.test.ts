import { describe, it, expect } from 'vitest'
import { chatAdoptPlan } from './chatAdopt'

const plan = (over: Partial<Parameters<typeof chatAdoptPlan>[0]> = {}) =>
  chatAdoptPlan({ restore: {}, hostSpeaksChatTakeover: true, rollAccounts: 2, adopting: false, appHoldsOld: () => false, rolledFrom: null, ...over })

describe('chatAdoptPlan (chat takeover, the app side)', () => {
  it('defers a proc the Host is still starting, only in front of a chat-takeover Host (P5)', () => {
    expect(plan({ restore: { hostStarting: true } }).defer).toBe(true)
    expect(plan({ restore: { hostStarting: true }, hostSpeaksChatTakeover: false }).defer).toBe(false)
    expect(plan({ restore: { hostStarting: null } }).defer).toBe(false)
  })
  it('leaves a Host-marked chain to the Host, and decides otherwise', () => {
    expect(plan({ restore: { rolledBy: 'host' } }).rolling).toBe('host')
    expect(plan({ restore: { rolledBy: 'host' }, hostSpeaksChatTakeover: false }).rolling).toBe('decide')
    expect(plan({ restore: {} }).rolling).toBe('decide')
  })
  // Review Focus 1.
  it('a Host-rolled chat proc adopted as the new half of a pushed roll announces no second tab', () => {
    expect(plan({ adopting: true, rolledFrom: 'c1', appHoldsOld: (id) => id === 'c1' }).announce).toBe(false)
    expect(plan({ adopting: true, rolledFrom: 'c1', appHoldsOld: () => false }).announce).toBe(true)
    expect(plan({}).announce).toBe(true)
  })
})
