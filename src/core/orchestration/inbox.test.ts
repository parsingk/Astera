import { describe, expect, it } from 'vitest'
import { NO_COORDINATOR_ANSWER, unattendedQuestions } from './inbox'
import { emptyState, type OrchState } from './state'
import type { Dispatch, Message, Run } from './types'

const NOW = '2026-08-28T00:00:00.000Z'

const run = (over: Partial<Run> = {}): Run => ({
  id: 'run_1',
  objective: 'o',
  cwd: '/p',
  createdAt: NOW,
  autoDispatch: true,
  ...over
})

const dispatch = (over: Partial<Dispatch> = {}): Dispatch => ({
  id: 'd1',
  taskId: 't1',
  accountId: 'a',
  provider: 'claude',
  sessionId: 's1',
  cwd: '/p',
  specPath: '/spec.md',
  startedAt: NOW,
  workerState: 'ready',
  retained: false,
  ...over
})

const question = (over: Partial<Message> = {}): Message => ({
  id: 'msg_1',
  runId: 'run_1',
  type: 'question',
  taskId: 't1',
  dispatchId: 'd1',
  subject: 'Approve this?',
  body: 'Approve this?',
  answered: false,
  createdAt: NOW,
  ...over
})

const state = (over: Partial<OrchState> = {}): OrchState => ({
  ...emptyState(),
  runs: [run()],
  dispatches: [dispatch()],
  messages: [question()],
  ...over
})

describe('NO_COORDINATOR_ANSWER', () => {
  // 워커가 읽는 문구다 — 무엇을 하라는 것인지와, 그래도 막히면 어디로 가라는 것까지 있어야
  // "답을 받았지만 무엇을 할지 모르는" 상태가 안 된다
  it('무엇을 하라는 것과 막혔을 때 갈 곳을 함께 말한다', () => {
    expect(NO_COORDINATOR_ANSWER).toContain('no coordinator')
    expect(NO_COORDINATOR_ANSWER).toContain('your spec')
    expect(NO_COORDINATOR_ANSWER).toContain('--type escalation')
  })
})

describe('unattendedQuestions', () => {
  it('답을 기다리는 질문을 낸다', () => {
    expect(unattendedQuestions(state())).toEqual(['msg_1'])
  })

  // 답이 실리면 다음 바퀴에 걸리지 않는다 — 그래서 되풀이가 없다
  it('이미 답한 질문은 내지 않는다', () => {
    const s = state({ messages: [question({ answered: true, answerBody: '승인' })] })
    expect(unattendedQuestions(s)).toEqual([])
  })

  // settlePendingQuestions 가 남기는 정리 표시는 답이 아니다. `ask` 의 probe 가 같은 규칙을
  // 쓰므로(server.ts — "a real answerBody can never be the empty string") 두 판단이 갈리면
  // 그 틈에서 워커가 영원히 선다
  it('빈 답만 실린 질문은 답이 아니다 — ask 쪽 폴링과 같은 규칙', () => {
    const s = state({ messages: [question({ answered: true, answerBody: '' })] })
    expect(unattendedQuestions(s)).toEqual(['msg_1'])
  })

  it('Dispatch 가 끝났으면 내지 않는다 — 기다리는 쪽이 없다', () => {
    for (const over of [{ endedAt: NOW }, { outcome: 'succeeded' as const }]) {
      const s = state({ dispatches: [dispatch(over)] })
      expect(unattendedQuestions(s)).toEqual([])
    }
  })

  it('Dispatch 를 가리키지 않는 질문은 내지 않는다 — 누가 기다리는지 알 수 없다', () => {
    const s = state({ messages: [question({ dispatchId: undefined })] })
    expect(unattendedQuestions(s)).toEqual([])
  })

  // 코디네이터가 있는 Run 은 그가 답한다. 이 그물은 답할 사람이 없는 Run 만 본다
  it('앱이 돌리지 않는 Run 은 보지 않는다', () => {
    const s = state({ runs: [run({ autoDispatch: undefined })] })
    expect(unattendedQuestions(s)).toEqual([])
  })

  it('예약 템플릿은 보지 않는다 — 템플릿 아래에는 도는 워커가 없다', () => {
    const s = state({ runs: [run({ schedule: { kind: 'daily', time: '09:00' } })] })
    expect(unattendedQuestions(s)).toEqual([])
  })

  // 부드리기가 있는 것은 question 뿐이다. 나머지는 워커가 계속 도는 중이라 풀어 줄 것이 없다
  it('question 이 아닌 유형은 보지 않는다', () => {
    const s = state({
      messages: [
        question({ id: 'm_status', type: 'status' }),
        question({ id: 'm_esc', type: 'escalation' }),
        question({ id: 'm_hb', type: 'heartbeat' })
      ]
    })
    expect(unattendedQuestions(s)).toEqual([])
  })

  it('여럿이면 여럿을 낸다 — Run 이 둘이어도 각자 것을 낸다', () => {
    const s = state({
      runs: [run(), run({ id: 'run_2' })],
      dispatches: [dispatch(), dispatch({ id: 'd2', taskId: 't2', sessionId: 's2' })],
      messages: [
        question(),
        question({ id: 'msg_2', runId: 'run_2', taskId: 't2', dispatchId: 'd2' })
      ]
    })
    expect(unattendedQuestions(s)).toEqual(['msg_1', 'msg_2'])
  })
})
