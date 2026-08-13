import { describe, it, expect } from 'vitest'
import {
  MIN_CHECKING_MS,
  isCheckResult,
  showChecking,
  formatCheckedAt,
  shouldNotifyDownloaded
} from './checkFeedback'

describe('isCheckResult — 확인이 끝났다고 볼 수 있는 상태', () => {
  it('결과 상태는 마지막 확인 시각 갱신 대상', () => {
    expect(isCheckResult('uptodate')).toBe(true)
    expect(isCheckResult('available')).toBe(true)
    expect(isCheckResult('downloaded')).toBe(true)
    expect(isCheckResult('error')).toBe(true)
  })

  it('진행 중·초기 상태는 아니다 — downloading은 진행률마다 밀려들어온다', () => {
    expect(isCheckResult('init')).toBe(false)
    expect(isCheckResult('checking')).toBe(false)
    expect(isCheckResult('downloading')).toBe(false)
  })
})

describe('showChecking — 확인 중 표시 판정', () => {
  const T = 1_000_000

  it('실제로 확인 중이면 클릭 이력과 무관하게 표시', () => {
    expect(showChecking('checking', null, T)).toBe(true)
    expect(showChecking('checking', T - 10_000, T)).toBe(true)
  })

  it('응답이 최소 구간보다 빨리 와도 그 구간 동안은 계속 표시', () => {
    // 실제 왕복 355ms로 uptodate가 도착한 시점 (로그 근거)
    expect(showChecking('uptodate', T, T + 355)).toBe(true)
    expect(showChecking('uptodate', T, T + MIN_CHECKING_MS - 1)).toBe(true)
  })

  it('최소 구간이 지나면 결과 상태를 그대로 보여준다', () => {
    expect(showChecking('uptodate', T, T + MIN_CHECKING_MS)).toBe(false)
    expect(showChecking('uptodate', T, T + 5_000)).toBe(false)
    expect(showChecking('uptodate', null, T)).toBe(false)
  })

  it('상태가 아직 없어도(구독 직후) 클릭 직후면 표시', () => {
    expect(showChecking(undefined, T, T + 100)).toBe(true)
    expect(showChecking(undefined, null, T)).toBe(false)
  })
})

describe('shouldNotifyDownloaded — 버전당 1회', () => {
  it('아직 아무것도 알리지 않았으면 알린다', () => {
    expect(shouldNotifyDownloaded('0.3.11', null)).toBe(true)
  })

  it('같은 버전은 다시 알리지 않는다 — 재확인 시 캐시 재사용으로 downloaded가 반복된다', () => {
    expect(shouldNotifyDownloaded('0.3.11', '0.3.11')).toBe(false)
  })

  it('더 새 버전이 받아지면 다시 알린다', () => {
    expect(shouldNotifyDownloaded('0.3.12', '0.3.11')).toBe(true)
  })

  it('버전이 없으면 알리지 않는다 — 문구에 실을 내용이 없다', () => {
    expect(shouldNotifyDownloaded(undefined, null)).toBe(false)
    expect(shouldNotifyDownloaded('', null)).toBe(false)
  })
})

describe('formatCheckedAt — 로컬 HH:MM', () => {
  it('한 자리 시/분을 0으로 채운다', () => {
    expect(formatCheckedAt(new Date(2026, 7, 4, 9, 5).getTime())).toBe('09:05')
  })

  it('자정과 23:59 경계', () => {
    expect(formatCheckedAt(new Date(2026, 7, 4, 0, 0).getTime())).toBe('00:00')
    expect(formatCheckedAt(new Date(2026, 7, 4, 23, 59).getTime())).toBe('23:59')
  })

  it('오후는 24시간제로', () => {
    expect(formatCheckedAt(new Date(2026, 7, 4, 17, 43).getTime())).toBe('17:43')
  })
})
