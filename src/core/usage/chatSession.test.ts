import { describe, it, expect } from 'vitest'
import { chatSessionUsage } from './chatSession'
import { claudeEffectsOf } from '../chat/claudeProtocol'
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

// Not a second copy of the parser's own tests: this pins the whole path, frame to chip, on numbers
// taken off a live turn rather than a recorded fixture, and on the model pair a real session actually
// produces — the conversation's own 1M window beside a sub-agent's 200k.
describe('a turn captured from a live session (2026-09-18)', () => {
  const RESULT_FRAME = {
    kind: 'message' as const,
    type: 'result',
    subtype: 'success',
    body: {
      type: 'result',
      subtype: 'success',
      session_id: 'captured',
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 15_981,
        cache_read_input_tokens: 17_114,
        output_tokens: 4
      },
      modelUsage: {
        'claude-haiku-4-5-20251001': { contextWindow: 200_000 },
        'claude-opus-5[1m]': { contextWindow: 1_000_000 }
      }
    }
  }

  it('reaches the context chip as a percentage of the session model window', () => {
    const effect = claudeEffectsOf(RESULT_FRAME as never).find((e) => e.type === 'usage')
    expect(effect).toEqual({
      type: 'usage',
      usedTokens: 33_101,
      windowByModel: { 'claude-haiku-4-5-20251001': 200_000, 'claude-opus-5[1m]': 1_000_000 }
    })
    const chip = chatSessionUsage({
      context: { usedTokens: 33_101, windowByModel: { 'claude-haiku-4-5-20251001': 200_000, 'claude-opus-5[1m]': 1_000_000 } },
      model: 'claude-opus-5[1m]',
      limits: null,
      account: null
    })
    // The sub-agent's 200k would have read 17%. Naming the model is what keeps it honest.
    expect(chip?.context).toEqual({ usedPercent: 3, usedTokens: 33_101, windowSize: 1_000_000 })
  })
})
