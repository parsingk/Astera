import { describe, it, expect } from 'vitest'
import { foldChatEvent } from './useChatState'
import type { ChatState } from '../../../core/chat/types'

const base: ChatState = {
  status: 'idle',
  request: null,
  model: { model: null, effort: null, permissionMode: 'default' },
  error: null,
  exitCode: null,
  errorDetail: null,
  outlivesApp: true,
  truncated: true,
  provider: 'codex'
}

describe('foldChatEvent', () => {
  it('a status event carrying truncated ends the guess; one without it leaves the flag alone', () => {
    expect(foldChatEvent(base, { type: 'status', status: 'working', truncated: false })).toMatchObject({
      status: 'working',
      truncated: false
    })
    expect(foldChatEvent(base, { type: 'status', status: 'working' }).truncated).toBe(true)
  })
  it('a turn starting still clears the previous turn’s error', () => {
    const failed = { ...base, error: 'rate limited' }
    expect(foldChatEvent(failed, { type: 'status', status: 'working', truncated: false }).error).toBeNull()
    expect(foldChatEvent(failed, { type: 'status', status: 'idle', truncated: false }).error).toBe('rate limited')
  })
})

// A pane already mounted when the process dies hears only the event — it never re-reads main's
// ChatState — so exitCode/errorDetail/error have to travel on `exit` itself, not just sit in state.
describe('foldChatEvent — exit', () => {
  it('꼬리가 있으면 exitCode·errorDetail·error 셋 다 이벤트에서 그대로 옮겨온다', () => {
    const next = foldChatEvent(base, {
      type: 'exit',
      code: 8,
      error: 'error: Could not parse project manifest',
      errorDetail: '\nerror: Could not parse project manifest\nat C:\\p\\package.json\n'
    })
    expect(next.exitCode).toBe(8)
    expect(next.error).toBe('error: Could not parse project manifest')
    expect(next.errorDetail).toBe('\nerror: Could not parse project manifest\nat C:\\p\\package.json\n')
    expect(next.status).toBe('idle')
    expect(next.request).toBeNull()
  })
  // error 칸이 없는 이벤트는 "이유 없음"이다 — 지어내지 않고, 그 직전 error 를 그대로 둔다.
  it('꼬리가 없으면 errorDetail 은 null 이 되지만 error 는 지어내지 않고 그대로 둔다', () => {
    const failed = { ...base, error: 'rate limited' }
    const next = foldChatEvent(failed, { type: 'exit', code: 8, errorDetail: null })
    expect(next.exitCode).toBe(8)
    expect(next.errorDetail).toBeNull()
    expect(next.error).toBe('rate limited')
  })

  // design F5: bypassOffer 는 매번 이 이벤트가 새로 정한다 — error 와 달리 "칸이 없으면 그대로 둔다"
  // 가 아니다. 지난 죽음의 true 가 이번의, 버튼을 낼 이유가 없는 죽음까지 물려받으면 안 된다.
  it('bypassOffer 는 이벤트가 실은 값 그대로 옮겨오고, 없으면 false 다', () => {
    expect(foldChatEvent(base, { type: 'exit', code: 8, errorDetail: null, bypassOffer: true }).bypassOffer).toBe(true)
    const stale = { ...base, bypassOffer: true }
    expect(foldChatEvent(stale, { type: 'exit', code: 0, errorDetail: null }).bypassOffer).toBe(false)
  })
})

// Task 7 (design F5): 우회 재시도가 성공했다는 것을 그 자신의 칸에 싣는다 — error 에 실으면 종료
// 배너가 그것을 사유로 오해한다.
describe('foldChatEvent — notice', () => {
  it('bypassed 알림은 notice 칸에만 실린다', () => {
    const next = foldChatEvent(base, { type: 'notice', key: 'bypassed' })
    expect(next.notice).toBe('bypassed')
    expect(next.error).toBeNull()
  })

  it('새 턴이 시작되면 알림도 error 와 함께 걷힌다', () => {
    const noticed = { ...base, notice: 'bypassed' as const }
    expect(foldChatEvent(noticed, { type: 'status', status: 'working', truncated: false }).notice).toBeNull()
    expect(foldChatEvent(noticed, { type: 'status', status: 'idle', truncated: false }).notice).toBe('bypassed')
  })

  // design F5: 알림이 뜬다는 것은 재시도가 실제로 성공해 세션이 다시 산다는 뜻이다 — 방금 전 실패의
  // 자국(error·errorDetail·exitCode·bypassOffer)을 그대로 두면, chatBannerFor 가 그 error 를 이
  // notice 보다 위에 두므로(request·error·notice 순) 다시 산 세션이 죽은 시도의 사유를 계속 보인다.
  it('알림은 방금 전 실패의 흔적(error·errorDetail·exitCode·bypassOffer)도 함께 지운다', () => {
    const failed = {
      ...base,
      error: 'error: Could not parse project manifest',
      errorDetail: 'tail',
      exitCode: 8,
      bypassOffer: true
    }
    const next = foldChatEvent(failed, { type: 'notice', key: 'bypassed' })
    expect(next.error).toBeNull()
    expect(next.errorDetail).toBeNull()
    expect(next.exitCode).toBeNull()
    expect(next.bypassOffer).toBe(false)
  })
})
