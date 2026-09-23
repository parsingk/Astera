import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { hookEventState, sessionStateOf, hookEventsDirIn, hookEventsFileIn } from './sessionState'

describe('hookEventState', () => {
  // 턴 안에서만 나는 이벤트다 — 도구 호출이 있었다는 것은 아직 Stop 이 오지 않은 턴이 돈다는 뜻이다.
  it.each(['PreToolUse', 'PostToolUse'])('%s 는 working', (name) => {
    expect(hookEventState({ hook_event_name: name, tool_use_id: 't1' })).toBe('working')
  })

  // Slack 이 턴 끝 요약을 보내는 바로 그 이벤트다.
  it('Stop 은 waiting — 턴이 끝났고 다음 입력을 기다린다', () => {
    expect(hookEventState({ hook_event_name: 'Stop' })).toBe('waiting')
  })

  it.each(['permission_prompt', 'worker_permission_prompt', 'agent_needs_input', 'elicitation_dialog'])(
    '%s 알림은 waiting — 사람을 기다리는 화면이다',
    (type) => {
      expect(hookEventState({ hook_event_name: 'Notification', notification_type: type })).toBe('waiting')
    }
  )

  // "Claude is waiting for your input" — 턴이 끝나고 한동안 입력이 없을 때 난다.
  it('idle_prompt 알림도 waiting', () => {
    expect(hookEventState({ hook_event_name: 'Notification', notification_type: 'idle_prompt' })).toBe('waiting')
  })

  // 앱과 같은 판정(notification.ts): 처음 보는 타입은 기다리는 화면 쪽으로 기운다.
  it('처음 보는 알림 타입은 앱처럼 waiting', () => {
    expect(hookEventState({ hook_event_name: 'Notification', notification_type: 'brand_new' })).toBe('waiting')
  })

  // 이미 일어난 일의 보고라 지금 무엇을 하는지는 말하지 않는다.
  it.each(['agent_completed', 'auth_success', 'push_notification', 'computer_use_exit'])(
    '%s 알림은 판정하지 않는다',
    (type) => {
      expect(hookEventState({ hook_event_name: 'Notification', notification_type: type })).toBeNull()
    }
  )

  it('모르는 이벤트와 객체가 아닌 값은 판정하지 않는다', () => {
    expect(hookEventState({ hook_event_name: 'SessionStart' })).toBeNull()
    expect(hookEventState(null)).toBeNull()
    expect(hookEventState('Stop')).toBeNull()
  })
})

describe('sessionStateOf', () => {
  const stop = JSON.stringify({ hook_event_name: 'Stop' })

  it('마지막 이벤트가 판정한다', () => {
    expect(sessionStateOf({ lastLine: stop, eventAt: 1000, lastInputAt: null })).toBe('waiting')
    expect(sessionStateOf({ lastLine: '{"hook_event_name":"PreToolUse"}', eventAt: 1000, lastInputAt: 500 })).toBe(
      'working'
    )
  })

  it('이벤트 파일이 없으면 unknown', () => {
    expect(sessionStateOf({ lastLine: null, eventAt: null, lastInputAt: null })).toBe('unknown')
  })

  it('JSON 이 아닌 줄, 판정하지 않는 이벤트는 unknown', () => {
    expect(sessionStateOf({ lastLine: 'not json', eventAt: 1000, lastInputAt: null })).toBe('unknown')
    expect(
      sessionStateOf({
        lastLine: '{"hook_event_name":"Notification","notification_type":"agent_completed"}',
        eventAt: 1000,
        lastInputAt: null
      })
    ).toBe('unknown')
  })

  // **이벤트 뒤에 들어간 입력은 그 이벤트를 무효로 한다.** 다음 턴을 보낸 것(Enter), 권한을 허락한
  // 것, Esc 로 끊은 것 — 어느 것이든 턴 시작을 알리는 훅이 없으니 파일에는 흔적이 남지 않는다.
  it('마지막 이벤트 뒤에 입력이 들어갔으면 unknown', () => {
    expect(sessionStateOf({ lastLine: stop, eventAt: 1000, lastInputAt: 1001 })).toBe('unknown')
    expect(sessionStateOf({ lastLine: stop, eventAt: 1000, lastInputAt: 1000 })).toBe('unknown')
    expect(sessionStateOf({ lastLine: '{"hook_event_name":"PreToolUse"}', eventAt: 1000, lastInputAt: 2000 })).toBe(
      'unknown'
    )
  })
})

describe('hook event file location', () => {
  // 캡처 스크립트가 쓰는 자리(statusline.ts)와 Host 가 읽는 자리가 한 규칙이다.
  it('프로필 아래 hook-events/<sessionId>.jsonl', () => {
    expect(hookEventsDirIn('/prof')).toBe(path.join('/prof', 'hook-events'))
    expect(hookEventsFileIn(hookEventsDirIn('/prof'), 'ses-1')).toBe(path.join('/prof', 'hook-events', 'ses-1.jsonl'))
  })
})
