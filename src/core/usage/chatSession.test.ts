import { describe, it, expect } from 'vitest'
import { chatSessionUsage } from './chatSession'
import type { AccountUsage, RateLimitWindow } from '../types'

const win = (usedPercent: number): RateLimitWindow => ({ usedPercent, resetsAt: null })

const account = (session: number, weekly: number): AccountUsage => ({
  session: win(session),
  weekly: win(weekly),
  readAt: '2026-09-18T00:00:00Z',
  remembered: false
})

const context = { usedTokens: 250_000, windowByModel: { small: 200_000, big: 1_000_000 } }

describe('chatSessionUsage', () => {
  it('turns the turn tokens into a percentage of the model the session is on', () => {
    const u = chatSessionUsage({ context, model: 'big', limits: null, account: null })
    expect(u?.context).toEqual({ usedPercent: 25, usedTokens: 250_000, windowSize: 1_000_000 })
  })

  it('falls back to the widest window offered when the model is not known', () => {
    // The frame accounts for sub-agent models too, and theirs are the narrow ones. Picking the widest
    // is wrong less often than picking the first, and a chat session names its model soon enough.
    const u = chatSessionUsage({ context, model: null, limits: null, account: null })
    expect(u?.context?.windowSize).toBe(1_000_000)
  })

  it('falls back to the widest window when the model it names is not in the frame', () => {
    const u = chatSessionUsage({ context, model: 'a-model-that-never-answered', limits: null, account: null })
    expect(u?.context?.windowSize).toBe(1_000_000)
  })

  it('reports no context when no window size came with the tokens', () => {
    const u = chatSessionUsage({
      context: { usedTokens: 10, windowByModel: {} },
      model: null,
      limits: null,
      account: account(4, 31)
    })
    expect(u?.context).toBeNull()
    expect(u?.session).toEqual(win(4)) // the limits still answer
  })

  it('reads the two limit windows off the account when the session has said nothing', () => {
    // The ordinary case. A chat session is told its limits only by a warning, which a fresh one has
    // not had, and leaving both chips blank until the account is nearly spent is the bug being fixed.
    const u = chatSessionUsage({ context: null, model: null, limits: null, account: account(4, 31) })
    expect(u).toEqual({ context: null, session: win(4), weekly: win(31) })
  })

  it('prefers what the session itself was told over the account cache', () => {
    const u = chatSessionUsage({
      context: null,
      model: null,
      limits: { session: win(42), weekly: win(99) },
      account: account(4, 31)
    })
    expect(u).toEqual({ context: null, session: win(42), weekly: win(99) })
  })

  it('fills a window the session left null from the account', () => {
    const u = chatSessionUsage({
      context: null,
      model: null,
      limits: { session: win(42), weekly: null },
      account: account(4, 31)
    })
    expect(u).toEqual({ context: null, session: win(42), weekly: win(31) })
  })

  it('answers null when there is not one usable figure', () => {
    expect(chatSessionUsage({ context: null, model: null, limits: null, account: null })).toBeNull()
  })
})
