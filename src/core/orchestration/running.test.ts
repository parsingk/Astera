import { describe, it, expect } from 'vitest'
import { runningCount, isStoppedWorker } from './running'
import { snapshotFor } from './view'
import { emptyState } from './state'
import type { OrchState } from './state'
import type { Dispatch, Run, Task } from './types'
import { absPath } from '../testPaths'

// 이 테스트는 JobTask 를 손으로 짓지 않고 **실제 투영(snapshotFor)을 거쳐** 만든다. 세는 규칙이
// 틀렸던 원인이 바로 "상태와 열린 Dispatch 가 어긋난다"는 것이었으므로, 그 어긋남을 만드는 유일한
// 자리(OrchState)에서 출발해야 재현이 된다. JobTask 를 직접 지으면 그 어긋남 자체를 테스트가
// 가정해 버려서, 투영이 바뀌는 날 조용히 통과한다.
const PROJ = absPath('proj')
const run = (id: string): Run => ({
  id,
  objective: `objective ${id}`,
  cwd: PROJ,
  createdAt: '2026-08-20T00:00:00.000Z'
})
const task = (id: string, status: Task['status']): Task => ({
  id,
  runId: 'r1',
  title: `task ${id}`,
  spec: '',
  deps: [],
  status,
  consecutiveFailures: 0,
  createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z'
})
/** 열린 Dispatch — outcome 도 endedAt 도 없다. 이것만이 "지금 워커가 붙어 있다"를 말한다 */
const open = (id: string, taskId: string): Dispatch => ({
  id,
  taskId,
  sessionId: `sess-${id}`,
  startedAt: '2026-08-20T01:00:00.000Z',
  provider: 'claude',
  accountId: 'acc',
  cwd: PROJ,
  specPath: '',
  workerState: 'ready',
  retained: false
})
/** worker-stop 이 남기는 모양 — 세션을 닫고 workerState·endedAt 만 적는다. **outcome 은 없다**:
 *  Task 를 일부러 건드리지 않으므로(server.ts 의 worker-stop) 결과도 정해지지 않았다 */
const stopped = (d: Dispatch): Dispatch => ({
  ...d,
  workerState: 'stopped',
  endedAt: '2026-08-20T02:00:00.000Z'
})

/** 상태를 투영까지 돌려 그 Run 의 JobTask 들을 얻는다 */
const countOf = (tasks: Task[], dispatches: Dispatch[]): number => {
  const s: OrchState = { ...emptyState(), runs: [run('r1')], tasks, dispatches }
  return runningCount(snapshotFor(s, PROJ, () => true, []).runs[0].tasks)
}

/** 상태를 투영까지 돌려 그 Run 의 JobTask 하나를 얻는다 */
const taskOf = (tasks: Task[], dispatches: Dispatch[], id: string) => {
  const s: OrchState = { ...emptyState(), runs: [run('r1')], tasks, dispatches }
  const t = snapshotFor(s, PROJ, () => true, []).runs[0].tasks.find((x) => x.id === id)
  if (!t) throw new Error(`no such task in snapshot: ${id}`)
  return t
}

describe('runningCount', () => {
  it('열린 Dispatch 가 붙은 dispatched Task 를 센다', () => {
    const ts = [task('t1', 'dispatched'), task('t2', 'dispatched')]
    expect(countOf(ts, [open('d1', 't1'), open('d2', 't2')])).toBe(2)
  })

  // 재현: F11 시나리오 A-1. 워커 넷을 띄우고 하나를 worker-stop 하면 셋이어야 한다.
  // worker-stop 은 Dispatch 만 닫고 Task 는 dispatched 로 남기므로, 상태로 세면 넷이 그대로 나온다
  it('worker-stop 으로 Dispatch 가 닫힌 Task 는 세지 않는다', () => {
    const ts = ['t1', 't2', 't3', 't4'].map((id) => task(id, 'dispatched'))
    const ds = ['t1', 't2', 't3', 't4'].map((id, i) => open(`d${i + 1}`, id))
    expect(countOf(ts, [...ds.slice(0, 3), stopped(ds[3])])).toBe(3)
  })

  // 재현: A-3. 넷을 다 끄면 0 이어야 한다 — 상태로 세면 줄 하나 없이 `+4` 가 선다
  it('워커를 다 끄면 0 이다 — 상태가 dispatched 로 남아 있어도', () => {
    const ts = ['t1', 't2', 't3', 't4'].map((id) => task(id, 'dispatched'))
    const ds = ['t1', 't2', 't3', 't4'].map((id, i) => stopped(open(`d${i + 1}`, id)))
    expect(countOf(ts, ds)).toBe(0)
  })

  // 검증은 앱이 돌린다(ipc.ts 의 validator) — 세션이 아예 없으므로 열린 Dispatch 로만 세면
  // 검증만 남은 Run 이 화면에서 사라진다. 이것이 이 규칙을 상태로 쓸 수밖에 없던 이유였다
  it('validating 은 열린 Dispatch 가 없어도 센다', () => {
    const ts = [task('t1', 'validating')]
    expect(countOf(ts, [{ ...open('d1', 't1'), outcome: 'succeeded', endedAt: '2026-08-20T02:00:00.000Z' }])).toBe(1)
  })

  // reviewing 은 상태가 먼저 바뀌고 검토 세션이 async 로 뒤따라 뜬다(ipc.ts 의 void startReview).
  // 그 틈에 0 으로 떨어지면 검토가 시작될 때마다 숫자가 깜빡인다
  it('reviewing 은 검토 세션이 아직 안 떴어도 센다', () => {
    const ts = [task('t1', 'reviewing')]
    expect(countOf(ts, [{ ...open('d1', 't1'), outcome: 'succeeded', endedAt: '2026-08-20T02:00:00.000Z' }])).toBe(1)
  })

  it('끝난 것·막힌 것·시작 전인 것은 세지 않는다', () => {
    const ts = [
      task('t1', 'completed'),
      task('t2', 'failed'),
      task('t3', 'blocked'),
      task('t4', 'ready'),
      task('t5', 'pending')
    ]
    expect(countOf(ts, [])).toBe(0)
  })
})


describe('isStoppedWorker', () => {
  // 글리프의 문구와 회전이 이것을 묻는다 — worker-stop 은 killSession 으로 세션을 정말 죽이므로
  // (coordinator.ts 의 releaseWorker) "워커가 일하는 중"도, 도는 모양도 그 뒤로는 거짓이다
  it('worker-stop 으로 Dispatch 가 닫힌 dispatched Task 가 그것이다', () => {
    const ts = [task('t1', 'dispatched')]
    expect(isStoppedWorker(taskOf(ts, [stopped(open('d1', 't1'))], 't1'))).toBe(true)
  })

  it('워커가 살아 있으면 아니다', () => {
    const ts = [task('t1', 'dispatched')]
    expect(isStoppedWorker(taskOf(ts, [open('d1', 't1')], 't1'))).toBe(false)
  })

  // 한 번도 뜬 적 없는 Task 도 dispatched 가 아니므로 여기 걸리지 않는다 — 걸리면 시작 전인 노드가
  // "워커가 멈췄다"를 달게 된다
  it('아직 뜬 적 없는 Task 는 아니다', () => {
    expect(isStoppedWorker(taskOf([task('t1', 'ready')], [], 't1'))).toBe(false)
  })

  // 끝난 Task 의 Dispatch 도 닫혀 있다. 상태로 먼저 걸러야 completed 노드가 멈춘 워커로 읽히지 않는다
  it('끝난 Task 는 Dispatch 가 닫혀 있어도 아니다', () => {
    const ts = [task('t1', 'completed')]
    const d = { ...open('d1', 't1'), outcome: 'succeeded' as const, endedAt: '2026-08-20T02:00:00.000Z' }
    expect(isStoppedWorker(taskOf(ts, [d], 't1'))).toBe(false)
  })
})
