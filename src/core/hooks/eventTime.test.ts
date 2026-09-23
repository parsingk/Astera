import { describe, it, expect } from 'vitest'
import { HOOK_EVENT_AT, hookEventAt, happenedBefore } from './eventTime'

describe('hookEventAt', () => {
  // 캡처 스크립트가 stdin 을 읽기 전에 잰 시각이다(statusline.ts HOOK_CAPTURE_SCRIPT).
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

  // 한쪽이라도 예전 캡처의 줄이면 시각으로는 가를 수 없다 — 붙은 순서를 따른다.
  it('어느 한쪽이라도 시각이 없으면 false', () => {
    expect(happenedBefore(null, 100)).toBe(false)
    expect(happenedBefore(100, null)).toBe(false)
    expect(happenedBefore(null, null)).toBe(false)
  })
})
