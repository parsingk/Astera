import { describe, it, expect } from 'vitest'
import { isIdleNotification, isUnknownNotificationType } from './notification'

describe('isIdleNotification', () => {
  it('idle_prompt 타입이면 유휴로 본다', () => {
    expect(isIdleNotification({ notification_type: 'idle_prompt' })).toBe(true)
  })

  // 실제로 관찰된 나머지 타입들 — 전부 유휴가 아니다
  it.each([
    'worker_permission_prompt',
    'agent_needs_input',
    'agent_completed',
    'elicitation_response',
    'elicitation_complete',
    'computer_use_enter',
    'computer_use_exit',
    'push_notification',
    'auth_success'
  ])('%s 타입은 유휴가 아니다', (type) => {
    expect(isIdleNotification({ notification_type: type })).toBe(false)
  })

  it('타입이 있으면 문구는 보지 않는다 — 문구가 바뀌어도 판정이 뒤집히지 않게', () => {
    expect(
      isIdleNotification({ notification_type: 'idle_prompt', message: '전혀 다른 문구' })
    ).toBe(true)
    expect(
      isIdleNotification({
        notification_type: 'worker_permission_prompt',
        message: 'Claude is waiting for your input'
      })
    ).toBe(false)
  })

  it('타입이 없으면(구버전) 문구로 폴백한다', () => {
    expect(isIdleNotification({ message: 'Claude is waiting for your input' })).toBe(true)
    expect(isIdleNotification({ message: 'Claude is waiting for your response' })).toBe(true)
    expect(isIdleNotification({ message: 'Claude needs your permission to use Bash' })).toBe(false)
  })

  it('타입도 문구도 없으면 유휴가 아니다 — 모르면 개입하지 않는다', () => {
    expect(isIdleNotification({})).toBe(false)
    expect(isIdleNotification({ message: '' })).toBe(false)
  })

  it('타입이 문자열이 아니면 문구로 폴백한다', () => {
    expect(
      isIdleNotification({ notification_type: 123, message: 'Claude is waiting for your input' })
    ).toBe(true)
    expect(isIdleNotification({ notification_type: null, message: 'something else' })).toBe(false)
  })

  // 빈 문자열은 다른 비문자열 값들과 경로가 다르다 — typeof 검사를 통과하므로 문구로 폴백하지
  // 않고 곧바로 false가 된다. 안전한 방향이지만(PTY 주입 없음) 경로가 갈리므로 고정한다.
  it('빈 문자열 타입은 문구로 폴백하지 않고 유휴가 아니라고 본다', () => {
    expect(
      isIdleNotification({ notification_type: '', message: 'Claude is waiting for your input' })
    ).toBe(false)
  })
})

describe('isUnknownNotificationType', () => {
  it('실측 목록에 있는 타입은 처음 보는 것이 아니다', () => {
    expect(isUnknownNotificationType({ notification_type: 'idle_prompt' })).toBe(false)
    expect(isUnknownNotificationType({ notification_type: 'worker_permission_prompt' })).toBe(false)
    expect(isUnknownNotificationType({ notification_type: 'auth_success' })).toBe(false)
  })

  it('목록에 없는 타입은 처음 보는 것이다 — 호출처가 로그로 남길 근거', () => {
    expect(isUnknownNotificationType({ notification_type: 'idle_prompt_v2' })).toBe(true)
    expect(isUnknownNotificationType({ notification_type: 'session_idle' })).toBe(true)
    expect(isUnknownNotificationType({ notification_type: '' })).toBe(true)
  })

  it('타입이 없는 구버전 페이로드는 처음 보는 타입이 아니다', () => {
    expect(isUnknownNotificationType({ message: 'Claude is waiting for your input' })).toBe(false)
    expect(isUnknownNotificationType({})).toBe(false)
    expect(isUnknownNotificationType({ notification_type: 123 })).toBe(false)
  })
})
