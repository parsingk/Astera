import { describe, it, expect } from 'vitest'
import {
  blockedUntil,
  laterBlock,
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

describe('laterBlock', () => {
  it('둘 다 없으면 null', () => {
    expect(laterBlock(null, null)).toBeNull()
  })

  it('a만 있으면 a', () => {
    const a = rec({ at: NOW + 1_000 })
    expect(laterBlock(a, null)).toBe(a)
  })

  it('b만 있으면 b', () => {
    const b = rec({ at: NOW + 1_000 })
    expect(laterBlock(null, b)).toBe(b)
  })

  it('b가 더 늦게까지 막으면 b가 이긴다', () => {
    const a = rec({ at: NOW + 1_000 })
    const b = rec({ at: NOW + 2_000 })
    expect(laterBlock(a, b)).toBe(b)
  })

  it('a가 더 늦게까지 막으면 b가 진다', () => {
    const a = rec({ at: NOW + 2_000 })
    const b = rec({ at: NOW + 1_000 })
    expect(laterBlock(a, b)).toBe(a)
  })

  // 동률(같은 시각까지 막음)이면 a를 지킨다. BlockRegistry.record()에서 a는 이미 갖고 있던
  // 기록이고 b는 방금 들어온 새 기록이다 — 더 늦게까지 막지 못하는 새 기록으로 바꿀 이유가 없다.
  // retryState()(다음 태스크)에서는 a가 이 체인이 직접 겪은 기록이고 b는 레지스트리가 공유한
  // 기록이다 — 같은 시각까지만 막는다면 공유된 기록은 새 정보를 주지 못하므로 체인 자신의
  // 1차 증거를 지킨다. 두 호출부 모두에서 "새 정보가 없으면 안 바꾼다"는 같은 답이 맞다.
  it('동률이면 a를 지킨다 (새 정보를 주지 못하는 쪽으로 바꾸지 않는다)', () => {
    const a = rec({ at: NOW + 1_000, weekly: true })
    const b = rec({ at: NOW + 1_000, weekly: false })
    expect(laterBlock(a, b)).toBe(a)
  })

  // 이긴 기록을 통째로 쓴다는 것을 보인다 — weekly만 따로 합치지 않는다. b가 더 늦게까지
  // 막으므로 b가 이기고, weekly도 (진 a의 true가 아니라) 이긴 b의 false가 그대로 남는다.
  it('둘이 weekly를 다르게 말하면 이긴 기록의 weekly가 그대로 남는다', () => {
    const a = rec({ at: NOW + 1_000, weekly: true })
    const b = rec({ at: NOW + 5_000, weekly: false })
    const result = laterBlock(a, b)
    expect(result).toBe(b)
    expect(result?.weekly).toBe(false)
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
