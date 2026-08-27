import { describe, it, expect } from 'vitest'
import { contextFromLines, sessionUsageOf } from './codex'
import type { CodexLimitState } from '../rolling/codexSignal'

/** 실측한 token_count 레코드의 전체 모양 (codex 0.149.1). 읽지 않는 필드까지 그대로 둔다 —
 *  부분만 흉내낸 fixture 는 구현이 엉뚱한 필드를 읽어도 조용히 통과한다. */
const usage = (total: number): Record<string, number> => ({
  input_tokens: total,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
  total_tokens: total
})

const tokenCountLine = (opts: { last: number; window?: number | null; total?: number }): string =>
  JSON.stringify({
    timestamp: '2026-08-27T01:40:32.182Z',
    ordinal: 18,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: usage(opts.total ?? opts.last),
        last_token_usage: usage(opts.last),
        ...(opts.window === null || opts.window === undefined
          ? {}
          : { model_context_window: opts.window })
      },
      rate_limits: {
        limit_id: 'codex',
        limit_name: null,
        primary: { used_percent: 12, window_minutes: 300, resets_at: 1_787_808_468 },
        secondary: { used_percent: 31, window_minutes: 10_080, resets_at: 1_788_326_258 },
        credits: { has_credits: false, unlimited: false, balance: '0' },
        individual_limit: null,
        spend_control_reached: null,
        plan_type: 'plus',
        rate_limit_reached_type: null
      }
    }
  })

describe('contextFromLines', () => {
  // Codex TUI 와 같은 숫자가 나와야 한다. 20924 / 258400 은 실측 레코드의 값이고,
  // baseline 12000 을 분자·분모에서 빼면 남은 비율이 96.378% → 96% 이므로 사용률은 4%다.
  // 단순 비율(20924/258400)이면 8% 가 나온다 — 그 구현으로는 이 테스트가 깨진다.
  it('Codex 표시식(baseline 12000 차감)으로 사용률을 낸다', () => {
    expect(contextFromLines([tokenCountLine({ last: 20_924, window: 258_400 })])).toEqual({
      usedPercent: 4,
      usedTokens: 20_924,
      windowSize: 258_400
    })
  })

  // Codex 는 baseline 미만을 "100% context left" 로 표시한다
  it('토큰이 baseline 미만이면 0%', () => {
    expect(contextFromLines([tokenCountLine({ last: 5_000, window: 258_400 })])?.usedPercent).toBe(0)
  })

  it('창을 꽉 채우면 100%', () => {
    expect(contextFromLines([tokenCountLine({ last: 258_400, window: 258_400 })])?.usedPercent).toBe(
      100
    )
  })

  // 창 <= baseline 이면 Codex 는 remaining 0 을 반환한다(0 나눗셈 방지 분기)
  it('창이 baseline 이하면 100%', () => {
    expect(contextFromLines([tokenCountLine({ last: 100, window: 12_000 })])?.usedPercent).toBe(100)
  })

  // 반올림은 remaining 쪽에서 한 번만 해야 한다. 창 12200(유효 200), 사용 99 이면
  // remaining 101/200 = 50.5% → 51% → 사용률 49%.
  // used 쪽에서 직접 반올림하면 99/200 = 49.5% → 50% 가 되어 1%p 어긋난다.
  it('반올림을 remaining 쪽에서 한 번만 한다', () => {
    expect(contextFromLines([tokenCountLine({ last: 12_099, window: 12_200 })])?.usedPercent).toBe(
      49
    )
  })

  // total_token_usage 는 세션 누적이라 컨텍스트 창보다 훨씬 커질 수 있다
  it('total_token_usage 가 아니라 last_token_usage 를 쓴다', () => {
    const c = contextFromLines([
      tokenCountLine({ last: 20_924, total: 900_000, window: 258_400 })
    ])
    expect(c).toEqual({ usedPercent: 4, usedTokens: 20_924, windowSize: 258_400 })
  })

  // 한도에 걸리면 codex 가 창 없는 크레딧 레코드를 뒤이어 쓴다. 그 레코드로 값을 덮으면
  // 컨텍스트 표시가 사라진다.
  it('token_count 가 없는 배치는 이전 값을 유지한다', () => {
    const prev = { usedPercent: 4, usedTokens: 20_924, windowSize: 258_400 }
    const other = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete', error: null }
    })
    expect(contextFromLines([other, 'not json at all', ''], prev)).toBe(prev)
  })

  it('마지막 token_count 가 이긴다', () => {
    const c = contextFromLines([
      tokenCountLine({ last: 20_924, window: 258_400 }),
      tokenCountLine({ last: 129_200, window: 258_400 })
    ])
    expect(c?.usedPercent).toBe(48) // (246400-117200)/246400 = 52.4% 남음 → 52% → 48% 사용
  })

  // 창 크기는 token_count.info 하나에만 있다. 모르는 값을 0% 로 그리면 거짓이므로 null.
  it('model_context_window 가 없으면 null', () => {
    expect(contextFromLines([tokenCountLine({ last: 20_924, window: null })])).toBeNull()
  })

  it('빈 배치는 prev 가 없으면 null', () => {
    expect(contextFromLines([])).toBeNull()
  })
})

const limitState = (over: Partial<CodexLimitState> = {}): CodexLimitState => ({
  primary: null,
  secondary: null,
  reachedType: null,
  error: null,
  priorReset: null,
  at: 1_787_800_000_000,
  ...over
})

describe('sessionUsageOf', () => {
  // CodexWindow.resetsAt 은 epoch ms, RateLimitWindow.resetsAt 은 ISO 문자열이다
  it('창의 resetsAt(epoch ms)을 ISO 로 바꾼다', () => {
    const u = sessionUsageOf(
      null,
      limitState({
        primary: { usedPercent: 12, resetsAt: 1_787_808_468_000 },
        secondary: { usedPercent: 31, resetsAt: 1_788_326_258_000 }
      })
    )
    expect(u).toEqual({
      context: null,
      session: { usedPercent: 12, resetsAt: '2026-08-27T05:27:48.000Z' },
      weekly: { usedPercent: 31, resetsAt: '2026-09-02T05:17:38.000Z' }
    })
  })

  it('resetsAt 이 없는 창도 퍼센트는 살린다', () => {
    const u = sessionUsageOf(null, limitState({ primary: { usedPercent: 98, resetsAt: null } }))
    expect(u?.session).toEqual({ usedPercent: 98, resetsAt: null })
  })

  it('퍼센트를 0-100 정수로 클램프한다', () => {
    const u = sessionUsageOf(
      null,
      limitState({ primary: { usedPercent: 100.4, resetsAt: null }, secondary: { usedPercent: -3, resetsAt: null } })
    )
    expect(u?.session?.usedPercent).toBe(100)
    expect(u?.weekly?.usedPercent).toBe(0)
  })

  // 롤 직후: 컨텍스트는 시드로 살아 있고 한도는 새 턴까지 비어 있는 상태
  it('컨텍스트만 있어도 반환한다', () => {
    const context = { usedPercent: 4, usedTokens: 20_924, windowSize: 258_400 }
    expect(sessionUsageOf(context, null)).toEqual({ context, session: null, weekly: null })
  })

  it('셋 다 없으면 null', () => {
    expect(sessionUsageOf(null, null)).toBeNull()
    expect(sessionUsageOf(null, limitState())).toBeNull()
  })
})
