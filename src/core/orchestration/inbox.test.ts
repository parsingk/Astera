import { describe, expect, it } from 'vitest'
import { NO_COORDINATOR_ANSWER, unattendedQuestions, unreadUpwardMail } from './inbox'
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

  // **판정의 기준은 "답할 코디네이터가 있는가" 하나다.** 예전에는 autoDispatch 로 물었는데, 그때는
  // 코디네이터 세션이라는 개념이 없어 그 둘이 같았다. 이제 코디네이터에게 넘긴 Run 은 autoDispatch
  // 가 꺼져 있고(한 Run 에 운전자는 하나), 그 Run 의 질문은 앱이 답해서는 안 된다.
  it('코디네이터가 붙어 있으면 보지 않는다 — 그가 답한다', () => {
    const s = state({ runs: [run({ autoDispatch: undefined, coordinatorSessionId: 'coord1' })] })
    expect(unattendedQuestions(s)).toEqual([])
  })

  it('코디네이터가 없으면 앱이 돌리는 Run 이 아니어도 본다 — 사람이 탭을 닫은 Run 이 그 갈래다', () => {
    const s = state({ runs: [run({ autoDispatch: undefined, coordinatorAccountId: 'acc1' })] })
    expect(unattendedQuestions(s)).toEqual(['msg_1'])
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

describe('unreadUpwardMail', () => {
  const T0 = Date.parse(NOW)
  const STALE = 60_000
  const withCoord = (over: Partial<Run> = {}): Run =>
    run({ coordinatorSessionId: 'coord1', ...over })

  const mail = (over: Partial<Message> = {}): Message =>
    question({ type: 'worker_done', answered: true, answerBody: '보고', ...over })

  it('오래된 미확인 메일이 있으면 그 세션을 깨울 대상으로 낸다', () => {
    const s = state({ runs: [withCoord()], messages: [mail()] })
    expect(unreadUpwardMail(s, { nowMs: T0 + STALE, staleMs: STALE })).toEqual([
      { runId: 'run_1', sessionId: 'coord1', messageIds: ['msg_1'] }
    ])
  })

  // 유예가 없으면 `check --wait` 안에 있는 코디네이터를 헛되이 찌른다
  it('아직 유예 안에 있으면 깨우지 않는다', () => {
    const s = state({ runs: [withCoord()], messages: [mail()] })
    expect(unreadUpwardMail(s, { nowMs: T0 + STALE - 1, staleMs: STALE })).toEqual([])
  })

  it('확인된 메일은 깨울 이유가 아니다 — ack 이 읽었다는 증거다', () => {
    const s = state({ runs: [withCoord()], messages: [mail({ ackedAt: NOW })] })
    expect(unreadUpwardMail(s, { nowMs: T0 + STALE, staleMs: STALE })).toEqual([])
  })

  it('코디네이터가 없는 Run 은 깨울 대상이 없다', () => {
    const s = state({ runs: [run()], messages: [mail()] })
    expect(unreadUpwardMail(s, { nowMs: T0 + STALE, staleMs: STALE })).toEqual([])
  })

  // heartbeat 만으로는 코디네이터가 할 일이 없다 — 그것으로 깨우면 살아 있는 코디네이터를
  // 주기적으로 두드린다
  it('heartbeat 만 쌓인 것으로는 깨우지 않는다', () => {
    const s = state({ runs: [withCoord()], messages: [mail({ type: 'heartbeat' })] })
    expect(unreadUpwardMail(s, { nowMs: T0 + STALE, staleMs: STALE })).toEqual([])
  })

  it('코디네이터의 행동이 필요한 유형은 전부 센다', () => {
    for (const type of ['worker_done', 'status', 'question', 'escalation', 'decision_gate'] as const) {
      const s = state({ runs: [withCoord()], messages: [mail({ type })] })
      expect(unreadUpwardMail(s, { nowMs: T0 + STALE, staleMs: STALE })).toHaveLength(1)
    }
  })

  it('Run 이 여럿이면 각자 자기 세션과 자기 메일을 낸다', () => {
    const s = state({
      runs: [withCoord(), withCoord({ id: 'run_2', coordinatorSessionId: 'coord2' })],
      messages: [mail(), mail({ id: 'msg_2', runId: 'run_2' })]
    })
    expect(unreadUpwardMail(s, { nowMs: T0 + STALE, staleMs: STALE })).toEqual([
      { runId: 'run_1', sessionId: 'coord1', messageIds: ['msg_1'] },
      { runId: 'run_2', sessionId: 'coord2', messageIds: ['msg_2'] }
    ])
  })
})
