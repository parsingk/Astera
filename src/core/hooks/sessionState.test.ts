import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { hookEventState, sessionStateOf, hookEventsDirIn, hookEventsFileIn, latestEventLine } from './sessionState'

describe('hookEventState', () => {
  // 턴 안에서만 나는 이벤트다 — 도구 호출이 있었다는 것은 아직 Stop 이 오지 않은 턴이 돈다는 뜻이다.
  it.each(['PreToolUse', 'PostToolUse'])('%s 는 working', (name) => {
    expect(hookEventState({ hook_event_name: name, tool_name: 'Bash', tool_use_id: 't1' })).toBe('working')
  })

  // 턴이 보내졌다 — 로컬 명령(/clear 같은, 모델에 묻지 않는 입력)은 이 훅을 부르지 않는다.
  it('UserPromptSubmit 은 working', () => {
    expect(hookEventState({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })).toBe('working')
  })

  // AskUserQuestion 의 PreToolUse 는 질문이 화면에 뜨는 순간이다(pendingPrompt.ts 가 카드로 그린다).
  it('AskUserQuestion 의 PreToolUse 는 waiting, 그 PostToolUse 는 working', () => {
    expect(hookEventState({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'q' })).toBe(
      'waiting'
    )
    expect(hookEventState({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'q' })).toBe(
      'working'
    )
  })

  // Slack 이 턴 끝 요약을 보내는 바로 그 이벤트다. StopFailure 는 API 오류로 끝난 턴에 Stop 대신 난다.
  it.each(['Stop', 'StopFailure'])('%s 는 waiting — 턴이 끝났고 다음 입력을 기다린다', (name) => {
    expect(hookEventState({ hook_event_name: name })).toBe('waiting')
  })

  // 이 세션 자신이 사람을 기다리는 화면이다.
  it.each(['permission_prompt', 'elicitation_dialog', 'idle_prompt'])('%s 알림은 waiting', (type) => {
    expect(hookEventState({ hook_event_name: 'Notification', notification_type: type })).toBe('waiting')
  })

  // 다른 에이전트(백그라운드 에이전트, 팀원 워커)의 일이라 이 세션의 턴이 돌고 있어도 난다.
  it.each(['agent_needs_input', 'worker_permission_prompt'])('%s 알림은 판정하지 않는다', (type) => {
    expect(hookEventState({ hook_event_name: 'Notification', notification_type: type })).toBeNull()
  })

  // 처음 보는 타입, 타입이 없는 알림(옛 버전)은 무엇을 뜻하는지 모른다 — unknown 이 틀릴 수 없는 답이다.
  it('처음 보는 알림 타입과 타입 없는 알림은 판정하지 않는다', () => {
    expect(hookEventState({ hook_event_name: 'Notification', notification_type: 'brand_new' })).toBeNull()
    expect(hookEventState({ hook_event_name: 'Notification', message: 'Claude is waiting for your input' })).toBeNull()
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

/**
 * **줄이 붙은 순서가 아니라 일어난 순서.** UserPromptSubmit 과 StopFailure 는 async 훅이라 캡처
 * 프로세스가 붙는 순서가 뒤집힐 수 있다. 캡처는 시작하자마자 잰 시각을 `astera_at` 으로 싣고, 가장
 * 늦게 일어난 이벤트가 판정한다.
 */
describe('latestEventLine', () => {
  const line = (payload: object) => JSON.stringify(payload)

  // 곧바로 난 API 오류: 그 턴의 StopFailure 가 제 UserPromptSubmit 보다 먼저 붙었다.
  it('StopFailure 가 제 턴의 UserPromptSubmit 보다 먼저 붙어도 StopFailure 가 마지막이다', () => {
    const failure = line({ hook_event_name: 'StopFailure', error: 'server_error', astera_at: 1_005 })
    const prompt = line({ hook_event_name: 'UserPromptSubmit', astera_at: 1_000 })
    expect(latestEventLine([failure, prompt])).toBe(failure)
  })

  // 실패한 턴 바로 뒤에 보낸 프롬프트: 새 UserPromptSubmit 이 이전 턴의 StopFailure 보다 먼저 붙었다.
  it('다음 턴의 UserPromptSubmit 이 이전 StopFailure 보다 먼저 붙어도 UserPromptSubmit 이 마지막이다', () => {
    const prompt = line({ hook_event_name: 'UserPromptSubmit', astera_at: 1_020 })
    const failure = line({ hook_event_name: 'StopFailure', error: 'rate_limit', astera_at: 1_000 })
    expect(latestEventLine([prompt, failure])).toBe(prompt)
  })

  // 예전 캡처가 쓴 줄에는 시각이 없다 — 오늘까지의 규칙대로 마지막에 붙은 줄이다.
  it('시각이 없는 줄은 붙은 순서를 따른다', () => {
    const prompt = line({ hook_event_name: 'UserPromptSubmit' })
    const failure = line({ hook_event_name: 'StopFailure' })
    expect(latestEventLine([prompt, failure])).toBe(failure)
    expect(latestEventLine([failure, prompt])).toBe(prompt)
    // 새 줄 뒤에 붙은 예전 줄도, 예전 줄 뒤에 붙은 새 줄도 가를 수 없으니 붙은 순서다.
    const stamped = line({ hook_event_name: 'Stop', astera_at: 5_000 })
    expect(latestEventLine([stamped, prompt])).toBe(prompt)
    expect(latestEventLine([prompt, stamped])).toBe(stamped)
  })

  // 같은 밀리초는 순서를 말하지 않는다 — 붙은 순서가 답이다.
  it('시각이 같으면 나중에 붙은 줄이다', () => {
    const a = line({ hook_event_name: 'UserPromptSubmit', astera_at: 1_000 })
    const b = line({ hook_event_name: 'StopFailure', astera_at: 1_000 })
    expect(latestEventLine([a, b])).toBe(b)
    expect(latestEventLine([b, a])).toBe(a)
  })

  // JSON 이 아닌 줄은 시각이 없는 줄이다 — 마지막에 붙었으면 그대로 마지막이고, sessionStateOf 가 unknown 으로 읽는다.
  it('JSON 이 아닌 줄과 빈 목록', () => {
    const stop = line({ hook_event_name: 'Stop', astera_at: 1_000 })
    expect(latestEventLine([stop, 'garbage'])).toBe('garbage')
    expect(latestEventLine([])).toBeNull()
  })
})

describe('hook event file location', () => {
  // 캡처 스크립트가 쓰는 자리(statusline.ts)와 Host 가 읽는 자리가 한 규칙이다.
  it('프로필 아래 hook-events/<sessionId>.jsonl', () => {
    expect(hookEventsDirIn('/prof')).toBe(path.join('/prof', 'hook-events'))
    expect(hookEventsFileIn(hookEventsDirIn('/prof'), 'ses-1')).toBe(path.join('/prof', 'hook-events', 'ses-1.jsonl'))
  })
})
