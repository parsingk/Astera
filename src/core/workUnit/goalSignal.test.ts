import { describe, it, expect } from 'vitest'
import { goalSignalOf } from './goalSignal'

const claudeSet = {
  type: 'attachment',
  attachment: { type: 'goal_status', met: false, sentinel: true, condition: 'rpg 게임을 만들어줘' }
}
const claudeMet = {
  type: 'attachment',
  attachment: {
    type: 'goal_status',
    met: true,
    condition: 'rpg 게임을 만들어줘',
    reason: '평가자가 조건이 충족됐다고 판단했다',
    iterations: 1,
    durationMs: 13353,
    tokens: 742
  }
}
const claudeNotYet = {
  type: 'attachment',
  attachment: { type: 'goal_status', met: false, condition: 'rpg 게임을 만들어줘', iterations: 2 }
}
const codexGoal = (status: string, objective = 'rpg 게임을 만들어줘') => ({
  type: 'event_msg',
  payload: {
    type: 'thread_goal_updated',
    threadId: '01a05a3e-e46e-74c2-839f-90682822b99f',
    goal: { threadId: '01a05a3e', objective, status, tokensUsed: 0, timeUsedSeconds: 0 }
  }
})

describe('goalSignalOf', () => {
  it('claude 의 sentinel 은 목표의 시작이다', () => {
    expect(goalSignalOf(claudeSet)).toEqual({
      kind: 'start',
      objective: 'rpg 게임을 만들어줘',
      declared: true
    })
  })

  it('claude 의 met 은 목표의 끝이고, 평가자의 이유를 요약으로 가져온다', () => {
    expect(goalSignalOf(claudeMet)).toEqual({
      kind: 'end',
      summary: '평가자가 조건이 충족됐다고 판단했다'
    })
  })

  it('아직 충족되지 않았다는 판정은 신호가 아니다 — 회차마다 오고 경계가 아니다', () => {
    expect(goalSignalOf(claudeNotYet)).toBeNull()
  })

  it('codex 의 active 는 시작, complete 는 끝이다', () => {
    expect(goalSignalOf(codexGoal('active'))).toEqual({
      kind: 'start',
      objective: 'rpg 게임을 만들어줘',
      declared: false
    })
    expect(goalSignalOf(codexGoal('complete'))).toEqual({ kind: 'end' })
  })

  it('되돌아올 수 있는 codex 상태는 아무 신호도 아니다 — 기록에 대응하는 상태가 없다', () => {
    for (const s of ['paused', 'blocked', 'usageLimited', 'budgetLimited'])
      expect(goalSignalOf(codexGoal(s)), s).toBeNull()
  })

  it('빈 목표는 시작이 아니다 — 이름 없는 줄은 화면에서 고를 수 없다', () => {
    expect(goalSignalOf(codexGoal('active', '   '))).toBeNull()
    expect(
      goalSignalOf({ type: 'attachment', attachment: { type: 'goal_status', sentinel: true, condition: '' } })
    ).toBeNull()
  })

  it('목표와 무관한 기록은 통과시킨다', () => {
    expect(goalSignalOf({ type: 'user', message: { role: 'user' } })).toBeNull()
    expect(goalSignalOf({ type: 'attachment', attachment: { type: 'hook_success' } })).toBeNull()
    expect(goalSignalOf({ type: 'event_msg', payload: { type: 'item_completed' } })).toBeNull()
  })
})
