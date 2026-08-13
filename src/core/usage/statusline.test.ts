import { describe, it, expect } from 'vitest'
import { parseStatusLinePayload, extractStatusLineSession } from './statusline'

describe('parseStatusLinePayload', () => {
  it('context_window.used_percentage를 그대로 쓰고 rate_limits를 매핑한다', () => {
    const u = parseStatusLinePayload({
      context_window: {
        used_percentage: 42,
        context_window_size: 200000,
        current_usage: { input_tokens: 10, cache_read_input_tokens: 80000, cache_creation_input_tokens: 5000 }
      },
      rate_limits: {
        five_hour: { used_percentage: 3, resets_at: '2026-07-21T15:20:00Z' },
        seven_day: { used_percentage: 30, resets_at: '2026-07-27T10:00:00Z' }
      }
    })
    expect(u).toEqual({
      context: { usedPercent: 42, usedTokens: 85010, windowSize: 200000 },
      session: { usedPercent: 3, resetsAt: '2026-07-21T15:20:00Z' },
      weekly: { usedPercent: 30, resetsAt: '2026-07-27T10:00:00Z' }
    })
  })

  it('used_percentage가 없으면 토큰/창크기로 폴백 계산한다', () => {
    const u = parseStatusLinePayload({
      context_window: {
        context_window_size: 1000000,
        current_usage: { input_tokens: 0, cache_read_input_tokens: 250000, cache_creation_input_tokens: 0 }
      }
    })
    expect(u?.context).toEqual({ usedPercent: 25, usedTokens: 250000, windowSize: 1000000 })
    expect(u?.session).toBeNull()
  })

  it('창 크기는 Claude가 준 값을 그대로 쓴다(1M도 정확) — 휴리스틱 없음', () => {
    const u = parseStatusLinePayload({
      context_window: { used_percentage: 20, context_window_size: 1000000 }
    })
    expect(u?.context?.usedPercent).toBe(20)
    expect(u?.context?.windowSize).toBe(1000000)
  })

  it('epoch seconds resets_at은 ISO로 정규화한다', () => {
    const epoch = 1_784_000_000
    const u = parseStatusLinePayload({ rate_limits: { five_hour: { used_percentage: 5, resets_at: epoch } } })
    expect(u?.session?.resetsAt).toBe(new Date(epoch * 1000).toISOString())
  })

  it('퍼센트를 0-100으로 반올림·클램프한다', () => {
    const u = parseStatusLinePayload({
      context_window: { used_percentage: 103.6 },
      rate_limits: { seven_day: { used_percentage: -2 } }
    })
    expect(u?.context?.usedPercent).toBe(100)
    expect(u?.weekly?.usedPercent).toBe(0)
  })

  it('쓸 값이 없으면 null', () => {
    expect(parseStatusLinePayload({})).toBeNull()
    expect(parseStatusLinePayload({ context_window: {} })).toBeNull()
    expect(parseStatusLinePayload(null)).toBeNull()
    expect(parseStatusLinePayload('nope')).toBeNull()
  })
})

describe('extractStatusLineSession', () => {
  it('session_id와 transcript_path를 꺼낸다', () => {
    expect(
      extractStatusLineSession({
        session_id: 'abc-123',
        transcript_path: 'C:\\Users\\me\\.claude\\projects\\D--work\\abc-123.jsonl'
      })
    ).toEqual({
      sessionId: 'abc-123',
      transcriptPath: 'C:\\Users\\me\\.claude\\projects\\D--work\\abc-123.jsonl'
    })
  })

  it('없거나 문자열이 아니면 null', () => {
    expect(extractStatusLineSession({})).toEqual({ sessionId: null, transcriptPath: null })
    expect(extractStatusLineSession(null)).toEqual({ sessionId: null, transcriptPath: null })
    expect(extractStatusLineSession({ session_id: 42, transcript_path: '' })).toEqual({
      sessionId: null,
      transcriptPath: null
    })
  })
})
