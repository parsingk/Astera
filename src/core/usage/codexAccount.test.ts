import { describe, it, expect } from 'vitest'
import { mapCodexUsageResponse } from './codexAccount'

/** The response as measured on 2026-09-04 against a live `plan_type: "plus"` account, trimmed to the
 *  fields the mapper reads plus the neighbours it must leave alone. */
const measured = {
  user_id: 'user-XXXX',
  account_id: '00000000-0000-0000-0000-000000000000',
  email: 'someone@example.com',
  plan_type: 'plus',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 0,
      limit_window_seconds: 18000,
      reset_after_seconds: 18000,
      reset_at: 1788521543
    },
    secondary_window: {
      used_percent: 35,
      limit_window_seconds: 604800,
      reset_after_seconds: 253564,
      reset_at: 1788757106
    }
  },
  code_review_rate_limit: null,
  additional_rate_limits: null,
  model_usage: {},
  credits: { has_credits: false, unlimited: false, balance: '0' },
  spend_control: { reached: false, individual_limit: null },
  rate_limit_reached_type: null
}

describe('mapCodexUsageResponse', () => {
  it('maps the measured response to the two named windows', () => {
    expect(mapCodexUsageResponse(measured)).toEqual({
      session: { usedPercent: 0, resetsAt: '2026-09-04T11:32:23.000Z' },
      weekly: { usedPercent: 35, resetsAt: '2026-09-07T04:58:26.000Z' },
      maxPercent: 35,
      peak: { percent: 35, resetsAt: '2026-09-07T04:58:26.000Z', weekly: true },
      status: 'ok'
    })
  })

  // primary is the 5-hour window and secondary the weekly one — the same naming the rollout's
  // payload.rate_limits uses. Swapping them would put the weekly figure on the row's top track.
  it('primary becomes the session window and secondary the weekly one', () => {
    const r = mapCodexUsageResponse({
      rate_limit: {
        primary_window: { used_percent: 90, reset_at: 1788521543 },
        secondary_window: { used_percent: 10, reset_at: 1788757106 }
      }
    })
    expect(r.session?.usedPercent).toBe(90)
    expect(r.weekly?.usedPercent).toBe(10)
    // The peak is the fuller bucket, so here it is the session one — that is what decides how long
    // AccountUsageStore keeps a remembered reading.
    expect(r.peak).toEqual({ percent: 90, resetsAt: '2026-09-04T11:32:23.000Z', weekly: false })
  })

  it('one window alone still answers ok', () => {
    const r = mapCodexUsageResponse({
      rate_limit: { primary_window: { used_percent: 12, reset_at: 1788521543 } }
    })
    expect(r.status).toBe('ok')
    expect(r.weekly).toBeNull()
    expect(r.maxPercent).toBe(12)
  })

  // A response arrived and carried nothing usable — the same verdict mapUsageResponse gives, and the
  // one AccountUsageStore refuses to remember, so the row keeps whatever it had.
  it.each([
    ['no rate_limit at all', { plan_type: 'plus' }],
    ['an empty rate_limit', { rate_limit: {} }],
    ['windows with no percent', { rate_limit: { primary_window: { reset_at: 1788521543 } } }],
    ['a non-numeric percent', { rate_limit: { primary_window: { used_percent: '30' } } }],
    ['a null body', null],
    ['an array body', []],
    ['a string body', 'nope']
  ])('%s is an error with no windows', (_label, body) => {
    expect(mapCodexUsageResponse(body)).toEqual({
      session: null,
      weekly: null,
      maxPercent: null,
      peak: null,
      status: 'error'
    })
  })

  // These become CSS widths and a countdown, so neither is trusted as it arrives.
  it('a percent out of range is clamped and a fraction rounded', () => {
    const r = mapCodexUsageResponse({
      rate_limit: {
        primary_window: { used_percent: 130.4, reset_at: 1788521543 },
        secondary_window: { used_percent: -5, reset_at: 1788757106 }
      }
    })
    expect(r.session?.usedPercent).toBe(100)
    expect(r.weekly?.usedPercent).toBe(0)
  })

  it('an unusable reset_at leaves the window dateless rather than guessing', () => {
    const r = mapCodexUsageResponse({
      rate_limit: {
        primary_window: { used_percent: 40, reset_at: '2026-09-04T09:32:23Z' },
        secondary_window: { used_percent: 20, reset_at: 0 }
      }
    })
    expect(r.session).toEqual({ usedPercent: 40, resetsAt: null })
    expect(r.weekly).toEqual({ usedPercent: 20, resetsAt: null })
    // The peak is the session window and it carries no date, so the store will refuse the reading
    // outright — see its readPeak. A figure that cannot be dated is one nothing can expire.
    expect(r.peak).toEqual({ percent: 40, resetsAt: null, weekly: false })
  })
})
