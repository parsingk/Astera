import { describe, it, expect } from 'vitest'
import { timelineFor, eventCountFor } from './timeline'
import { emptyState } from './state'
import type { OrchState } from './state'
import type { Dispatch, Gate, Message, Run, Task } from './types'
import { absPath } from '../testPaths'

const T = (n: number): string => `2026-08-18T00:0${n}:00.000Z`
const run = (id: string): Run => ({
  id, objective: `objective ${id}`, cwd: absPath('p'), createdAt: T(0)
})
const task = (id: string, runId: string, createdAt = T(1)): Task => ({
  id, runId, title: `task ${id}`, spec: '', deps: [], status: 'pending',
  consecutiveFailures: 0, createdAt, updatedAt: createdAt
})
const dispatch = (id: string, taskId: string, startedAt = T(2)): Dispatch => ({
  id, taskId, sessionId: `ses-${id}`, startedAt, provider: 'claude', accountId: 'acc',
  cwd: absPath('p'), specPath: '', workerState: 'ready', retained: false
})
const message = (id: string, runId: string, type: Message['type'], createdAt = T(3)): Message => ({
  id, runId, type, subject: `subject ${id}`, body: `body ${id}`, answered: false, createdAt
})
const gate = (id: string, taskId: string, createdAt = T(4)): Gate => ({
  id, runId: 'r1', taskId, question: 'first line\nsecond line', status: 'open', createdAt
})
const state = (p: Partial<OrchState>): OrchState => ({ ...emptyState(), ...p })
const anySession = (): boolean => true
const noSession = (): boolean => false

describe('timelineFor', () => {
  it('Task 가 없는 Run 은 run-created 하나다', () => {
    const s = state({ runs: [run('r1')] })
    const evts = timelineFor(s, 'r1', anySession)
    expect(evts.map((e) => e.kind)).toEqual(['run-created'])
    expect(evts[0].summary).toBe('objective r1')
  })

  it('없는 Run 은 빈 목록이다', () => {
    expect(timelineFor(emptyState(), 'nope', anySession)).toEqual([])
  })

  it('Task 생성이 이벤트가 되고 제목을 싣는다', () => {
    const s = state({ runs: [run('r1')], tasks: [task('t1', 'r1')] })
    const e = timelineFor(s, 'r1', anySession).find((x) => x.kind === 'task-created')
    expect(e?.taskId).toBe('t1')
    expect(e?.taskTitle).toBe('task t1')
  })

  it('Dispatch 시작이 provider 와 함께 이벤트가 된다', () => {
    const s = state({
      runs: [run('r1')], tasks: [task('t1', 'r1')], dispatches: [dispatch('d1', 't1')]
    })
    const e = timelineFor(s, 'r1', anySession).find((x) => x.kind === 'dispatch-started')
    expect(e?.provider).toBe('claude')
    expect(e?.taskTitle).toBe('task t1')
    expect(e?.retry).toBeUndefined()
  })

  it('retryOf 가 있는 Dispatch 는 retry 로 표시된다', () => {
    const s = state({
      runs: [run('r1')], tasks: [task('t1', 'r1')],
      dispatches: [{ ...dispatch('d2', 't1'), retryOf: 'd1' }]
    })
    const e = timelineFor(s, 'r1', anySession).find((x) => x.kind === 'dispatch-started')
    expect(e?.retry).toBe(true)
  })

  it('review 인 Dispatch 는 review 로 표시된다', () => {
    const s = state({
      runs: [run('r1')], tasks: [task('t1', 'r1')],
      dispatches: [{ ...dispatch('d1', 't1'), review: true }]
    })
    const e = timelineFor(s, 'r1', anySession).find((x) => x.kind === 'dispatch-started')
    expect(e?.review).toBe(true)
  })

  // Dispatch 는 runId 를 갖지 않는다 — 이 Run 의 Task 를 통해서만 골라야 한다
  it('다른 Run 의 Dispatch 는 섞이지 않는다', () => {
    const s = state({
      runs: [run('r1'), run('r2')],
      tasks: [task('t1', 'r1'), task('t2', 'r2')],
      dispatches: [dispatch('d1', 't1'), dispatch('d2', 't2')]
    })
    const ids = timelineFor(s, 'r1', anySession)
      .filter((e) => e.kind === 'dispatch-started').map((e) => e.sourceId)
    expect(ids).toEqual(['d1'])
  })

  it('메시지가 종류와 본문을 싣고 이벤트가 된다', () => {
    const s = state({ runs: [run('r1')], messages: [message('m1', 'r1', 'worker_done')] })
    const e = timelineFor(s, 'r1', anySession).find((x) => x.kind === 'message')
    expect(e?.messageType).toBe('worker_done')
    expect(e?.summary).toBe('subject m1')
    expect(e?.body).toBe('body m1')
  })

  // 사람이 읽을 이벤트가 아니고, 세면 eventCount 가 계속 올라 푸시가 끊이지 않는다
  it('heartbeat 은 빠진다', () => {
    const s = state({ runs: [run('r1')], messages: [message('m1', 'r1', 'heartbeat')] })
    expect(timelineFor(s, 'r1', anySession).filter((e) => e.kind === 'message')).toEqual([])
  })

  // createGate 가 Gate 레코드와 함께 만드는 사본이다 — 둘을 다 세면 같은 질문이 두 줄로 나온다
  it('decision_gate 메시지는 빠진다 (Gate 레코드가 그 자리다)', () => {
    const s = state({
      runs: [run('r1')], tasks: [task('t1', 'r1')],
      messages: [message('m1', 'r1', 'decision_gate')], gates: [gate('g1', 't1')]
    })
    const kinds = timelineFor(s, 'r1', anySession).map((e) => e.kind)
    expect(kinds).not.toContain('message')
    expect(kinds).toContain('gate-opened')
  })

  it('열린 Gate 는 이벤트 하나, 해제된 Gate 는 둘이다', () => {
    const open = state({ runs: [run('r1')], tasks: [task('t1', 'r1')], gates: [gate('g1', 't1')] })
    expect(timelineFor(open, 'r1', anySession).filter((e) => e.kind.startsWith('gate')).length).toBe(1)
    const resolved = state({
      runs: [run('r1')], tasks: [task('t1', 'r1')],
      gates: [{ ...gate('g1', 't1'), status: 'resolved', resolution: '계속한다', resolvedAt: T(5) }]
    })
    const evts = timelineFor(resolved, 'r1', anySession)
    expect(evts.filter((e) => e.kind.startsWith('gate')).map((e) => e.kind))
      .toEqual(['gate-opened', 'gate-resolved'])
    expect(evts.find((e) => e.kind === 'gate-resolved')?.body).toBe('계속한다')
  })

  it('Gate 의 요약은 질문의 첫 줄이다', () => {
    const s = state({ runs: [run('r1')], tasks: [task('t1', 'r1')], gates: [gate('g1', 't1')] })
    const e = timelineFor(s, 'r1', anySession).find((x) => x.kind === 'gate-opened')
    expect(e?.summary).toBe('first line')
    expect(e?.body).toBe('first line\nsecond line')
  })

  it('시각 오름차순으로 정렬한다', () => {
    const s = state({
      runs: [run('r1')], tasks: [task('t1', 'r1', T(3))],
      messages: [message('m1', 'r1', 'status', T(1))]
    })
    expect(timelineFor(s, 'r1', anySession).map((e) => e.at)).toEqual([T(0), T(1), T(3)])
  })

  // 한 번의 쓰기가 여러 레코드에 같은 now 를 찍는다 — 시각만으로는 순서가 정해지지 않는다
  it('같은 시각이면 종류 순서가 결정적이다', () => {
    const s = state({
      runs: [run('r1')], tasks: [task('t1', 'r1', T(0))],
      dispatches: [dispatch('d1', 't1', T(0))],
      messages: [message('m1', 'r1', 'status', T(0))],
      gates: [gate('g1', 't1', T(0))]
    })
    expect(timelineFor(s, 'r1', anySession).map((e) => e.kind)).toEqual([
      'run-created', 'task-created', 'dispatch-started', 'message', 'gate-opened'
    ])
  })

  it('isKnownSession 이 거부하면 sessionId 가 없다', () => {
    const s = state({
      runs: [run('r1')], tasks: [task('t1', 'r1')], dispatches: [dispatch('d1', 't1')]
    })
    expect(timelineFor(s, 'r1', anySession).find((e) => e.kind === 'dispatch-started')?.sessionId)
      .toBe('ses-d1')
    expect(timelineFor(s, 'r1', noSession).find((e) => e.kind === 'dispatch-started')?.sessionId)
      .toBeUndefined()
  })

  it('dispatchId 가 있는 메시지는 그 세션을 물려받는다', () => {
    const s = state({
      runs: [run('r1')], tasks: [task('t1', 'r1')], dispatches: [dispatch('d1', 't1')],
      messages: [{ ...message('m1', 'r1', 'question'), dispatchId: 'd1', taskId: 't1' }]
    })
    expect(timelineFor(s, 'r1', anySession).find((e) => e.kind === 'message')?.sessionId)
      .toBe('ses-d1')
  })

  it('다른 Run 의 메시지는 섞이지 않는다', () => {
    const s = state({
      runs: [run('r1'), run('r2')],
      messages: [message('m1', 'r1', 'status'), message('m2', 'r2', 'status')]
    })
    expect(timelineFor(s, 'r1', anySession).filter((e) => e.kind === 'message').map((e) => e.sourceId))
      .toEqual(['m1'])
  })

  // Gate 는 runId 를 직접 들고 있어 Task 를 통하지 않고 걸러진다 — 그 필터에도 자기 테스트가 있어야
  // 한다. 새면 다른 Run 의 질문이 이 Run 의 기록에 나타난다
  it('다른 Run 의 Gate 는 섞이지 않는다', () => {
    const s = state({
      runs: [run('r1'), run('r2')],
      tasks: [task('t1', 'r1'), task('t2', 'r2')],
      gates: [gate('g1', 't1'), { ...gate('g2', 't2'), runId: 'r2' }]
    })
    expect(timelineFor(s, 'r1', anySession).filter((e) => e.kind === 'gate-opened').map((e) => e.sourceId))
      .toEqual(['g1'])
  })
})

describe('eventCountFor', () => {
  it('timelineFor 와 같은 수를 센다', () => {
    const s = state({
      runs: [run('r1')], tasks: [task('t1', 'r1')], dispatches: [dispatch('d1', 't1')],
      messages: [message('m1', 'r1', 'status'), message('m2', 'r1', 'heartbeat')],
      gates: [gate('g1', 't1')]
    })
    expect(eventCountFor(s, 'r1')).toBe(timelineFor(s, 'r1', anySession).length)
  })

  it('없는 Run 은 0 이다', () => {
    expect(eventCountFor(emptyState(), 'nope')).toBe(0)
  })
})
