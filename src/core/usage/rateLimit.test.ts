import { describe, it, expect } from 'vitest'
import { mapUsageResponse } from './rateLimit'

describe('mapUsageResponse', () => {
  it('maps five_hour/seven_day used_percentage + resets_at(ISO)', () => {
    const r = mapUsageResponse({
      five_hour: { used_percentage: 37, resets_at: '2026-07-21T10:20:00.000Z' },
      seven_day: { used_percentage: 28, resets_at: '2026-07-27T10:00:00.000Z' }
    })
    expect(r.status).toBe('ok')
    expect(r.session).toEqual({ usedPercent: 37, resetsAt: '2026-07-21T10:20:00.000Z' })
    expect(r.weekly).toEqual({ usedPercent: 28, resetsAt: '2026-07-27T10:00:00.000Z' })
  })

  it('accepts utilization alias and epoch-seconds resets_at', () => {
    const epoch = 1_784_000_000 // seconds
    const r = mapUsageResponse({ five_hour: { utilization: 40, resets_at: epoch } })
    expect(r.session?.usedPercent).toBe(40)
    expect(r.session?.resetsAt).toBe(new Date(epoch * 1000).toISOString())
    expect(r.weekly).toBeNull()
  })

  it('rounds and clamps percent into 0-100', () => {
    const r = mapUsageResponse({
      five_hour: { used_percentage: 100.6 },
      seven_day: { used_percentage: -3 }
    })
    expect(r.session?.usedPercent).toBe(100)
    expect(r.weekly?.usedPercent).toBe(0)
  })

  it('null resets_at when missing/invalid', () => {
    const r = mapUsageResponse({ five_hour: { used_percentage: 10 } })
    expect(r.session?.resetsAt).toBeNull()
  })

  it('status=error when no usable window', () => {
    expect(mapUsageResponse({}).status).toBe('error')
    expect(mapUsageResponse({ five_hour: {} }).status).toBe('error')
    expect(mapUsageResponse(null).status).toBe('error')
    expect(mapUsageResponse('nonsense').status).toBe('error')
  })
})

// 한도 판정에는 five_hour/seven_day 두 창만으로 부족하다 — LIMIT_RE는 "Opus limit"·"Sonnet limit"·
// "Fable 5 limit"·"usage credit limit"도 매치하는데 그것들은 별도 버킷이라 두 창에 안 잡힌다.
// 실측 응답(2026-08-08)에는 limits[] 배열이 kind·percent로 모든 버킷을 싣고 온다.
describe('maxPercent — 모든 한도 버킷 중 최댓값', () => {
  it('limits[] 전체에서 최댓값을 고른다 — 두 창에 없는 버킷도 포함', () => {
    const r = mapUsageResponse({
      five_hour: { utilization: 30 },
      seven_day: { utilization: 55 },
      limits: [
        { kind: 'session', percent: 30 },
        { kind: 'weekly_all', percent: 55 },
        { kind: 'weekly_scoped', percent: 100, scope: { model: { display_name: 'Opus' } } }
      ]
    })
    expect(r.maxPercent).toBe(100)
  })

  it('limits[]가 없으면 두 창으로 폴백한다', () => {
    const r = mapUsageResponse({ five_hour: { utilization: 97 }, seven_day: { utilization: 69 } })
    expect(r.maxPercent).toBe(97)
  })

  it('쓸 수 있는 값이 하나도 없으면 null', () => {
    expect(mapUsageResponse({}).maxPercent).toBeNull()
  })

  it('실측 응답 형태(2026-08-08)를 그대로 처리한다', () => {
    const r = mapUsageResponse({
      five_hour: { utilization: 97, resets_at: '2026-08-08T08:40:00.895519+00:00' },
      seven_day: { utilization: 69, resets_at: '2026-08-09T15:00:00.895540+00:00' },
      seven_day_opus: null,
      limits: [
        { kind: 'session', group: 'session', percent: 97, severity: 'critical', is_active: true },
        { kind: 'weekly_all', group: 'weekly', percent: 69, severity: 'normal', is_active: false },
        { kind: 'weekly_scoped', group: 'weekly', percent: 19, severity: 'normal', is_active: false }
      ]
    })
    expect(r.status).toBe('ok')
    expect(r.maxPercent).toBe(97)
    expect(r.session?.usedPercent).toBe(97)
  })
})

// 2026-08-30 실측 응답. limits[] 는 버킷마다 resets_at 을 함께 준다 — 그 시각이 버려지고 있었고,
// 그 때문에 한도로 멈춘 세션이 언제 풀리는지 알 길이 화면 문구밖에 없었다(그 문구가 없는 화면도 있다).
describe('peak — 가장 많이 찬 버킷과 그것이 풀리는 시각', () => {
  const live = {
    five_hour: { utilization: 6, resets_at: '2026-08-31T04:39:59.629608+00:00' },
    seven_day: { utilization: 88, resets_at: '2026-09-02T09:59:59.629629+00:00' },
    limits: [
      { kind: 'session', group: 'session', percent: 6, resets_at: '2026-08-31T04:39:59.629608+00:00', is_active: false },
      { kind: 'weekly_all', group: 'weekly', percent: 88, resets_at: '2026-09-02T09:59:59.629629+00:00', is_active: true },
      { kind: 'weekly_scoped', group: 'weekly', percent: 0, resets_at: null, is_active: false }
    ]
  }

  it('가장 많이 찬 버킷의 시각과 종류를 함께 준다', () => {
    const u = mapUsageResponse(live)
    expect(u.peak).toEqual({
      percent: 88,
      resetsAt: '2026-09-02T09:59:59.629629+00:00',
      weekly: true
    })
  })

  it('maxPercent 는 그 버킷의 수치와 같다 — 두 값이 갈라지지 않는다', () => {
    const u = mapUsageResponse(live)
    expect(u.maxPercent).toBe(u.peak!.percent)
  })

  it('5시간 창이 한도면 그쪽 시각이 나온다 — weekly=false', () => {
    const u = mapUsageResponse({
      ...live,
      limits: [
        { kind: 'session', group: 'session', percent: 100, resets_at: '2026-08-31T04:39:59Z' },
        { kind: 'weekly_all', group: 'weekly', percent: 88, resets_at: '2026-09-02T09:59:59Z' }
      ]
    })
    expect(u.peak).toEqual({ percent: 100, resetsAt: '2026-08-31T04:39:59Z', weekly: false })
  })

  // limits[] 가 없는 옛 응답 모양 — 두 창이 전부다
  it('limits[] 가 없으면 두 창에서 고른다', () => {
    const u = mapUsageResponse({
      five_hour: { utilization: 30, resets_at: '2026-08-31T04:00:00Z' },
      seven_day: { utilization: 95, resets_at: '2026-09-02T09:00:00Z' }
    })
    expect(u.peak).toEqual({ percent: 95, resetsAt: '2026-09-02T09:00:00Z', weekly: true })
  })

  it('버킷에 시각이 없으면 null 이다 — 지어내지 않는다', () => {
    const u = mapUsageResponse({
      five_hour: { utilization: 10 },
      limits: [{ kind: 'weekly_scoped', group: 'weekly', percent: 100, resets_at: null }]
    })
    expect(u.peak).toEqual({ percent: 100, resetsAt: null, weekly: true })
  })

  it('읽을 버킷이 하나도 없으면 peak 도 없다', () => {
    expect(mapUsageResponse({}).peak).toBeNull()
    expect(mapUsageResponse({}).maxPercent).toBeNull()
  })

  // group 이 예상 밖의 값이면 주간으로 넘겨짚지 않는다 — 잘못된 weekly 는 기록하는 대기의 성격을
  // 잘못 적는다
  it('모르는 group 은 주간으로 보지 않는다', () => {
    const u = mapUsageResponse({
      five_hour: { utilization: 1 },
      limits: [{ kind: 'x', group: 'monthly', percent: 100, resets_at: '2026-09-01T00:00:00Z' }]
    })
    expect(u.peak!.weekly).toBe(false)
  })
})
