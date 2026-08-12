import { describe, it, expect } from 'vitest'
import {
  blockedUntil,
  pickAvailable,
  planRetry,
  RETRY_FALLBACK_MS,
  RETRY_MARGIN_MS,
  RETRY_MIN_FLOOR_MS,
  type BlockRecord,
  type RetryState
} from './retry'

const NOW = 1_000_000
const rec = (over: Partial<BlockRecord> = {}): BlockRecord => ({
  at: null,
  weekly: false,
  since: NOW,
  ...over
})
const state = (over: Partial<RetryState> = {}): RetryState => ({
  accountIds: ['a', 'b', 'c'],
  currentIndex: 0,
  recovery: [null, null, null],
  ...over
})

describe('blockedUntil', () => {
  it('reset 시각을 알면 그 시각까지 막힌 것으로 본다', () => {
    expect(blockedUntil(rec({ at: NOW + 5_000 }))).toBe(NOW + 5_000)
  })

  it('reset 미상이면 기록 시각 + 폴백 간격까지 막힌 것으로 본다', () => {
    expect(blockedUntil(rec({ at: null, since: NOW }))).toBe(NOW + RETRY_FALLBACK_MS)
  })
})

describe('pickAvailable', () => {
  it('fromIndex부터 순회해 첫 가용 계정을 준다', () => {
    expect(pickAvailable(state(), 1, NOW)).toBe(1)
  })

  it('현재 계정은 건너뛴다 (같은 계정으로 롤하지 않는다)', () => {
    expect(pickAvailable(state({ currentIndex: 1 }), 1, NOW)).toBe(2)
  })

  it('끝에 닿으면 한 바퀴 돌아 앞쪽을 본다', () => {
    expect(pickAvailable(state({ currentIndex: 2 }), 2, NOW)).toBe(0)
  })

  it('차단이 아직 안 풀린 계정은 건너뛴다', () => {
    const s = state({ currentIndex: 0, recovery: [null, rec({ at: NOW + 60_000 }), null] })
    expect(pickAvailable(s, 1, NOW)).toBe(2)
  })

  it('차단 시각이 지났으면 다시 쓸 수 있다 (경계: 같은 시각도 가용)', () => {
    const s = state({ currentIndex: 0, recovery: [null, rec({ at: NOW }), null] })
    expect(pickAvailable(s, 1, NOW)).toBe(1)
  })

  it('전부 차단이면 null', () => {
    const blocked = rec({ at: NOW + 60_000 })
    const s = state({ currentIndex: 0, recovery: [blocked, blocked, blocked] })
    expect(pickAvailable(s, 1, NOW)).toBe(null)
  })
})

describe('planRetry', () => {
  it('가장 빨리 회복되는 계정을 target으로 고른다', () => {
    const s = state({
      recovery: [rec({ at: NOW + 900_000 }), rec({ at: NOW + 300_000 }), rec({ at: NOW + 600_000 })]
    })
    expect(planRetry(s, NOW).target).toBe(1)
  })

  it('reset을 아는 계정만 있으면 그 시각 + MARGIN', () => {
    const at = NOW + 900_000
    const s = state({ recovery: [rec({ at }), rec({ at: at + 1_000 }), rec({ at: at + 2_000 })] })
    expect(planRetry(s, NOW).retryAt).toBe(at + RETRY_MARGIN_MS)
  })

  // 기록 없음은 now+FALLBACK으로 취급하고 MARGIN을 더하지 않는다 — reset을 아는 게 아니기 때문이다.
  // 기록 있는 계정의 at은 FALLBACK과 동률이 되지 않도록 충분히 뒤로 둔다(동률이면 먼저 순회한
  // 쪽이 이겨 무엇을 검증하는지 흐려진다).
  it('기록 없는 계정은 now+폴백으로 취급한다 (MARGIN 없음)', () => {
    const s = state({ recovery: [rec({ at: NOW + 3_600_000 }), null, null] })
    expect(planRetry(s, NOW)).toEqual({
      target: 1,
      retryAt: NOW + RETRY_FALLBACK_MS,
      weekly: false
    })
  })

  it('하한(MIN_FLOOR)으로 클램프한다 — 해머링 방지', () => {
    const s = state({ recovery: [rec({ at: NOW - 10_000 }), rec({ at: NOW }), rec({ at: NOW })] })
    expect(planRetry(s, NOW).retryAt).toBe(NOW + RETRY_MIN_FLOOR_MS)
  })

  it('주간 한도 여부를 target 계정의 기록에서 가져온다', () => {
    const s = state({
      recovery: [
        rec({ at: NOW + 900_000 }),
        rec({ at: NOW + 300_000, weekly: true }),
        rec({ at: NOW + 600_000 })
      ]
    })
    expect(planRetry(s, NOW).weekly).toBe(true)
  })
})
