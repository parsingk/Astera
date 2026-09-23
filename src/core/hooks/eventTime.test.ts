import { describe, it, expect } from 'vitest'
import { HOOK_EVENT_AT, REORDER_WINDOW_MS, hookEventAt, happenedBefore } from './eventTime'

describe('hookEventAt', () => {
  // 캡처 프로세스가 시작한 시각이다(statusline.ts HOOK_CAPTURE_SCRIPT, performance.timeOrigin).
  it('캡처가 찍은 시각을 읽는다', () => {
    expect(HOOK_EVENT_AT).toBe('astera_at')
    expect(hookEventAt({ hook_event_name: 'Stop', astera_at: 1_700_000_000_123 })).toBe(1_700_000_000_123)
  })

  // 예전 캡처가 쓴 줄에는 이 필드가 없다 — 시각이 없다는 답이지 0 이 아니다.
  it('필드가 없거나 숫자가 아니면 null', () => {
    expect(hookEventAt({ hook_event_name: 'Stop' })).toBeNull()
    expect(hookEventAt({ astera_at: '1700000000123' })).toBeNull()
    expect(hookEventAt({ astera_at: Number.NaN })).toBeNull()
    expect(hookEventAt(null)).toBeNull()
    expect(hookEventAt('Stop')).toBeNull()
  })
})

describe('happenedBefore', () => {
  it('둘 다 시각이 있고 앞의 것이 더 이르면 true', () => {
    expect(happenedBefore(100, 101)).toBe(true)
    expect(happenedBefore(101, 100)).toBe(false)
  })

  // 같은 밀리초는 순서를 말하지 않는다 — 붙은 순서(append order)가 그대로 답이 되게 false.
  it('같은 시각은 false', () => {
    expect(happenedBefore(100, 100)).toBe(false)
  })

  // 뒤집혀 붙는 것은 1초도 안 되는 폭이다. 그보다 훨씬 벌어진 차이는 벽시계가 뒤로 설정된 것이라
  // 시각을 믿지 않고 붙은 순서를 따른다 — 안 그러면 되돌아간 시계 뒤의 이벤트가 모두 "먼저" 가 된다.
  it(`차이가 REORDER_WINDOW_MS(${REORDER_WINDOW_MS}ms) 이상이면 false`, () => {
    expect(REORDER_WINDOW_MS).toBe(5_000)
    expect(happenedBefore(100, 100 + REORDER_WINDOW_MS - 1)).toBe(true)
    expect(happenedBefore(100, 100 + REORDER_WINDOW_MS)).toBe(false)
    expect(happenedBefore(1_000_000 - 30_000, 1_000_000)).toBe(false)
  })

  // 한쪽이라도 예전 캡처의 줄이면 시각으로는 가를 수 없다 — 붙은 순서를 따른다.
  it('어느 한쪽이라도 시각이 없으면 false', () => {
    expect(happenedBefore(null, 100)).toBe(false)
    expect(happenedBefore(100, null)).toBe(false)
    expect(happenedBefore(null, null)).toBe(false)
  })
})
