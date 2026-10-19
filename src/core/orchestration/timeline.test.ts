import { describe, it, expect } from 'vitest'
import { timelineFor, eventCountFor, eventCountsOf, timelineWith } from './timeline'
import { GITHUB_LINE_KINDS } from '../github/lifecycle'
import type { JobEvent } from '../types'
import { emptyState } from './state'
import type { OrchState } from './state'
import type { Dispatch, Gate, Message, ResumeEntry, Task } from './types'
import { stateFromLegacy } from './legacyState'
import type { LegacyRun } from './legacy'
import { absPath } from '../testPaths'

const T = (n: number): string => `2026-08-18T00:0${n}:00.000Z`
const run = (id: string): LegacyRun => ({
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
const state = (p: Parameters<typeof stateFromLegacy>[0]): OrchState => stateFromLegacy(p)
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

  // 설계 §3(V2). 구별하지 않으면 자동 수정이 도는 Task 의 타임라인은 같은 줄의 반복이 된다
  it('수리 Dispatch 는 왜 수리인지까지 싣는다', () => {
    const s = state({
      runs: [run('r1')], tasks: [task('t1', 'r1')],
      dispatches: [{ ...dispatch('d1', 't1'), repair: 'check-failure' as const }]
    })
    const e = timelineFor(s, 'r1', anySession).find((x) => x.kind === 'dispatch-started')
    expect(e?.repair).toBe('check-failure')
  })

  it('검토 지적을 고치는 수리는 review-failure 로 온다', () => {
    const s = state({
      runs: [run('r1')], tasks: [task('t1', 'r1')],
      dispatches: [{ ...dispatch('d1', 't1'), repair: 'review-failure' as const }]
    })
    const e = timelineFor(s, 'r1', anySession).find((x) => x.kind === 'dispatch-started')
    expect(e?.repair).toBe('review-failure')
  })

  // 없는 칸은 없어야 한다 — 구현 Dispatch 에 repair 가 달리면 모든 줄이 수리로 읽힌다
  it('구현 Dispatch 에는 repair 칸 자체가 없다', () => {
    const s = state({ runs: [run('r1')], tasks: [task('t1', 'r1')], dispatches: [dispatch('d1', 't1')] })
    const e = timelineFor(s, 'r1', anySession).find((x) => x.kind === 'dispatch-started')
    expect(e).not.toHaveProperty('repair')
  })

  // Dispatch.resumes 의 한 항목(정지+재개)이 이벤트 둘로 펼쳐진다
  it('정지와 재개가 타임라인에 각각 한 줄이 된다', () => {
    const resumes: ResumeEntry[] = [
      { stoppedAt: T(2), reason: 'waiting', fromAccountId: 'acc-1', resumedAt: T(3), toAccountId: 'acc-1' }
    ]
    const s = state({
      runs: [run('r1')], tasks: [task('t1', 'r1')],
      dispatches: [{ ...dispatch('d1', 't1'), resumes }]
    })
    const evts = timelineFor(s, 'r1', anySession).filter((e) => e.kind === 'limit-hit' || e.kind === 'resumed')
    expect(evts.map((e) => e.kind)).toEqual(['limit-hit', 'resumed'])
    // sourceId 는 종류 안에서만 유일하면 되므로 정지·재개가 같은 이력 색인을 나눠 쓴다
    expect(evts.map((e) => e.sourceId)).toEqual(['d1:0', 'd1:0'])
  })

  // 아직 resumedAt 이 없는 이력 — 재개 줄은 아직 없다
  it('아직 기다리는 항목은 정지 줄만 만든다', () => {
    const resumes: ResumeEntry[] = [{ stoppedAt: T(2), reason: 'waiting', fromAccountId: 'acc-1' }]
    const s = state({
      runs: [run('r1')], tasks: [task('t1', 'r1')],
      dispatches: [{ ...dispatch('d1', 't1'), resumes }]
    })
    const evts = timelineFor(s, 'r1', anySession).filter((e) => e.kind === 'limit-hit' || e.kind === 'resumed')
    expect(evts.map((e) => e.kind)).toEqual(['limit-hit'])
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

// G7b (design §5.5): a lifecycle Run's GitHub log as timeline lines, with the lifecycle Task they belong to
describe('the GitHub lines', () => {
  const A = 'a'.repeat(40)
  const withLog = (log: NonNullable<OrchState['runs'][number]['githubState']>['log'], lifecycle = true): OrchState => {
    const s = state({ runs: [run('r1')] })
    const lt: Task = { ...task('tsk_l', 'r1', T(5)), title: 'GitHub 전달', kind: 'lifecycle' } as Task
    return {
      ...s,
      tasks: lifecycle ? [lt] : [],
      runs: s.runs.map((r) => ({ ...r, githubState: { log, seq: log.length } }))
    }
  }
  const log = [
    { seq: 1, at: T(6), kind: 'pr-created' as const, pr: 12 },
    { seq: 2, at: T(6), kind: 'pushed' as const, sha: A },
    { seq: 3, at: T(7), kind: 'head-changed' as const, sha: A },
    { seq: 4, at: T(7), kind: 'ci-started' as const, sha: A },
    { seq: 5, at: T(8), kind: 'ci-failed' as const, sha: A, check: 'build', class: 'test' as const },
    { seq: 6, at: T(8), kind: 'ci-rerun' as const, sha: A, check: 'build' },
    { seq: 7, at: T(9), kind: 'ci-passed' as const, sha: A },
    { seq: 8, at: T(9), kind: 'merge-ready' as const, sha: A, pr: 12 },
    { seq: 9, at: T(9), kind: 'invalidated' as const, reason: 'head-changed' as const },
    { seq: 10, at: T(9), kind: 'source-changed' as const },
    { seq: 11, at: T(9), kind: 'pr-bound' as const, pr: 13 }
  ]

  it('turns each entry into its line, in order, with the lifecycle Task, and leaves the head moving off', () => {
    const evts = timelineFor(withLog(log), 'r1', anySession).filter((e) => e.kind.startsWith('github-'))
    expect(evts.map((e) => e.kind)).toEqual([
      'github-pr-created', 'github-pushed', 'github-ci-started', 'github-ci-failed', 'github-ci-rerun', 'github-ci-passed',
      'github-merge-ready', 'github-invalidated', 'github-source-changed', 'github-pr-bound'
    ])
    expect(evts[0]).toMatchObject({ sourceId: 'r1:github:000001', taskId: 'tsk_l', taskTitle: 'GitHub 전달', summary: '#12', github: { pr: 12 } })
    expect(evts[1]).toMatchObject({ summary: 'aaaaaaa', github: { sha: A } })
    expect(evts[3]).toMatchObject({ summary: 'build', github: { sha: A, check: 'build', class: 'test' } })
    expect(evts[7]).toMatchObject({ summary: 'head-changed', github: { reason: 'head-changed' } })
  })

  it('a Run with no lifecycle Task yet has its lines without a Task, and a Run with no record has none', () => {
    const evts = timelineFor(withLog(log.slice(0, 1), false), 'r1', anySession)
    expect(evts.find((e) => e.kind === 'github-pr-created')).not.toHaveProperty('taskId')
    expect(timelineFor(state({ runs: [run('r1')] }), 'r1', anySession).map((e) => e.kind)).toEqual(['run-created'])
  })

  it('counts what it shows', () => {
    const s = withLog(log)
    expect(eventCountsOf(s).get('r1')).toBe(timelineFor(s, 'r1', anySession).length)
  })

  // Final review M9: after a reconverge each line belongs to the lifecycle Task of its round, and a line from before any
  // lifecycle Task (a pull request found while the ordinary Tasks ran) to none
  it('ties each line to the lifecycle Task made at or before it', () => {
    const s = withLog([
      { seq: 1, at: T(4), kind: 'pr-bound' as const, pr: 12 },
      { seq: 2, at: T(6), kind: 'ci-failed' as const, sha: A, check: 'build' },
      { seq: 3, at: T(9), kind: 'ci-passed' as const, sha: A }
    ])
    const second: Task = { ...task('tsk_l2', 'r1', T(8)), title: 'GitHub 전달', kind: 'lifecycle' } as Task
    const two = { ...s, tasks: [...s.tasks, second] }
    const lines = timelineFor(two, 'r1', anySession).filter((e) => e.kind.startsWith('github-'))
    expect(lines.map((e) => e.taskId ?? null)).toEqual([null, 'tsk_l', 'tsk_l2'])
  })

  // The log's own rule for what is a line (it counts the dropped ones) and the timeline's are the same rule
  it('shows a line for exactly the kinds the log counts as lines', () => {
    const evts = timelineFor(withLog(log), 'r1', anySession).filter((e) => e.kind.startsWith('github-'))
    expect(evts).toHaveLength(log.filter((e) => GITHUB_LINE_KINDS.has(e.kind)).length)
    expect(GITHUB_LINE_KINDS.size).toBe(10)
  })

  // Final review I3: runs follow waits for the count to pass what it printed, so the lines the full log dropped count too
  it('counts the lines the full log dropped, past what it shows', () => {
    const s = withLog(log)
    const dropped = { ...s, runs: s.runs.map((r) => ({ ...r, githubState: { ...r.githubState!, droppedLines: 3 } })) }
    expect(eventCountsOf(dropped).get('r1')).toBe(timelineFor(dropped, 'r1', anySession).length + 3)
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

describe('timelineWith', () => {
  it('sorts rows from elsewhere into the timeline by the same order', () => {
    // the file's one-run fixture; `extra` at the run's own createdAt sorts after run-created by KIND_RANK
    const s = state({ runs: [run('r1')], tasks: [task('t1', 'r1')] })
    const extra: JobEvent[] = [{ at: s.runs[0].createdAt, kind: 'recovery', sourceId: 'evt_r', summary: 'redispatch' }]
    const merged = timelineWith(s, s.runs[0].id, () => false, extra)
    expect(merged.map((e) => e.kind).indexOf('recovery')).toBeGreaterThan(merged.map((e) => e.kind).indexOf('run-created'))
    expect(timelineWith(s, s.runs[0].id, () => false, [])).toEqual(timelineFor(s, s.runs[0].id, () => false))
  })
})

// Performance audit M1: the Jobs sidebar fold counts every Run's events on every commit. Counting them all in one pass
// must give exactly what each Run's timeline holds, or the push that a new event should let through never comes.
describe('eventCountsOf', () => {
  it('gives every Run the length of its own timeline, in one pass', () => {
    const resumes: ResumeEntry[] = [
      { stoppedAt: T(5), fromAccountId: 'a', reason: 'waiting', resumedAt: T(6), toAccountId: 'b' },
      { stoppedAt: T(7), fromAccountId: 'b', reason: 'waiting' }
    ]
    const s = state({
      runs: [run('r1'), run('r2'), run('r3')],
      tasks: [task('t1', 'r1'), task('t2', 'r1'), task('t3', 'r2')],
      dispatches: [{ ...dispatch('d1', 't1'), resumes }, dispatch('d2', 't3'), dispatch('d3', 'gone')],
      messages: [
        { ...message('m1', 'r1', 'status'), dispatchId: 'd1' },
        message('m2', 'r1', 'heartbeat'),
        message('m3', 'r2', 'decision_gate'),
        message('m4', 'r2', 'question'),
        message('m5', 'nope', 'status')
      ],
      gates: [
        { ...gate('g1', 't1'), resolvedAt: T(8), resolution: 'yes' },
        { ...gate('g2', 't3'), runId: 'r2' }
      ]
    })
    const counts = eventCountsOf(s)
    for (const r of s.runs) expect(counts.get(r.id) ?? 0).toBe(timelineFor(s, r.id, anySession).length)
    expect(counts.get('nope') ?? 0).toBe(0)
    expect(eventCountFor(s, 'r1')).toBe(timelineFor(s, 'r1', anySession).length)
  })
})
