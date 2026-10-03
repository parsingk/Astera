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

// codex-cli 0.160.0, measured 2026-10-03: the goal's end is no longer a `thread_goal_updated`
// event. The model calls `update_goal` from its `exec` tool, and the only record of the new state is
// that call's output, one `input_text` item of which is the goal as JSON. Trimmed from a real rollout.
const codex160GoalJson = (goal: Record<string, unknown>): string =>
  JSON.stringify({ goal, remainingTokens: null, completionBudgetReport: 'Goal achieved. Report final usage.' })
const codex160Output = (texts: string[]) => ({
  type: 'response_item',
  payload: {
    type: 'custom_tool_call_output',
    id: 'ctco_01a10168-d535-7342-887c-e08fc41a6abe',
    call_id: 'call_yVigquLYV9PzHNxLz5CLt93X',
    output: texts.map((text) => ({ type: 'input_text', text }))
  }
})
const codex160Goal = (status: string, objective: unknown = 'Create a file own.txt and commit it.') => ({
  threadId: '01a10166-d6cb-7523-9833-91b3fa9301d4',
  objective,
  status,
  tokensUsed: 29776,
  timeUsedSeconds: 107,
  createdAt: 1791024901,
  updatedAt: 1791025009
})
const codex160Header = 'Script completed\nWall time 1.1 seconds\nOutput:\n'

describe('goalSignalOf — codex 0.160 의 update_goal 결과', () => {
  it('complete 목표를 담은 도구 결과는 끝이다', () => {
    expect(goalSignalOf(codex160Output([codex160Header, codex160GoalJson(codex160Goal('complete'))]))).toEqual({
      kind: 'end'
    })
  })

  it('그 결과를 부른 exec 호출 자체는 신호가 아니다', () => {
    expect(
      goalSignalOf({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          status: 'completed',
          call_id: 'call_yVigquLYV9PzHNxLz5CLt93X',
          name: 'exec',
          input: 'text(await tools.update_goal({status:"complete"}));\n'
        }
      })
    ).toBeNull()
  })

  it('complete 가 아닌 목표는 끝이 아니다', () => {
    for (const s of ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited'])
      expect(goalSignalOf(codex160Output([codex160Header, codex160GoalJson(codex160Goal(s))])), s).toBeNull()
  })

  it('목표가 아닌 JSON, 이름 없는 목표, JSON 이 아닌 글은 신호가 아니다', () => {
    const cases = [
      JSON.stringify({ status: 'complete' }),
      JSON.stringify({ goal: 'complete' }),
      JSON.stringify([{ goal: codex160Goal('complete') }]),
      JSON.stringify({ result: { goal: codex160Goal('complete') } }),
      codex160GoalJson(codex160Goal('complete', 42)),
      codex160GoalJson(codex160Goal('complete', '  ')),
      // the goal JSON quoted inside other text is a message, not the field
      'Done: ' + codex160GoalJson(codex160Goal('complete')),
      'not json at all',
      ''
    ]
    for (const text of cases) expect(goalSignalOf(codex160Output([codex160Header, text])), text).toBeNull()
  })

  it('다른 도구의 결과 모양이면 읽지 않는다', () => {
    const json = codex160GoalJson(codex160Goal('complete'))
    // a function call's output carries a plain string, not input_text items
    expect(
      goalSignalOf({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c', output: json } })
    ).toBeNull()
    expect(
      goalSignalOf({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c', output: json } })
    ).toBeNull()
    expect(
      goalSignalOf({
        type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'c', output: [{ type: 'output_text', text: json }] }
      })
    ).toBeNull()
  })

  it('0.160 의 시작은 0.151 과 같은 thread_goal_updated 로 온다', () => {
    expect(
      goalSignalOf({
        type: 'event_msg',
        payload: {
          type: 'thread_goal_updated',
          threadId: '01a10166-d6cb-7523-9833-91b3fa9301d4',
          goal: codex160Goal('active')
        }
      })
    ).toEqual({ kind: 'start', objective: 'Create a file own.txt and commit it.', declared: false })
  })
})
