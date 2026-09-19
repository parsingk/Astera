import { describe, it, expect } from 'vitest'
import { performRepair, repairOnce, repairTargetFor, type RepairDeps } from './repair'
import {
  applyValidationResult, applyWorkerDone, createRun, createTask, emptyState, openDispatch, resolveGate, type OrchState
} from '../../core/orchestration/state'
import type { CheckResult, Task } from '../../core/orchestration/types'

const NOW = '2026-09-19T00:00:00.000Z'
const unwrap = <T>(r: { ok: boolean } & Record<string, unknown>): { state: OrchState; value: T } => {
  if (!r.ok) throw new Error(`expected ok, got ${String(r.error)}`)
  return { state: r.state as OrchState, value: r.value as T }
}
const failing: CheckResult[] = [
  { configId: 'c1', name: 'Typecheck', status: 'failed', exitCode: 1, outputTail: 'TS2322' },
  { configId: 'c2', name: 'Tests', status: 'not-run' }
]

/** convergence Run, check 걸린 Task, sess1 에서 구현이 끝나 validating 인 상태 */
const validating = (): { s: OrchState; taskId: string; implId: string } => {
  let { state: s, value: run } = unwrap<{ id: string }>(createRun(emptyState(), { objective: 'o', cwd: 'D:/p', convergence: {} }, NOW) as never)
  const t = unwrap<{ id: string }>(createTask(s, { runId: run.id, title: 'Auth', spec: 'do auth', deps: [], validateConfigIds: ['c1', 'c2'] }, NOW) as never)
  s = t.state
  const d = unwrap<{ id: string }>(openDispatch(s, { taskId: t.value.id, provider: 'claude', accountId: 'accA', sessionId: 'sess1', cwd: 'D:/wt', specPath: 'C:/specs/a.md' }, NOW) as never)
  s = unwrap(applyWorkerDone(d.state, { taskId: t.value.id, dispatchId: d.value.id, outcome: 'succeeded', subject: 's', body: 'b' }, NOW) as never).state
  return { s, taskId: t.value.id, implId: d.value.id }
}

const makeDeps = (initial: OrchState, over: Partial<RepairDeps> = {}): RepairDeps & { box: { state: OrchState }; started: Parameters<RepairDeps['startWorker']>[0][] } => {
  const box = { state: initial }
  const started: Parameters<RepairDeps['startWorker']>[0][] = []
  return {
    box,
    started,
    getState: () => box.state,
    setState: async (n) => void (box.state = n),
    startWorker: async (a) => {
      started.push(a)
      return { sessionId: a.terminal ?? 'sess-new', cwd: a.terminalCwd ?? 'D:/wt', specPath: `C:/specs/${a.taskId}-${a.dispatchId}.md` }
    },
    isAlive: () => true,
    knowledge: async () => undefined,
    lang: () => 'en',
    log: () => {},
    now: () => NOW,
    ...over
  }
}

describe('repairTargetFor', () => {
  it('마지막 구현 세션이 살아 있으면 same-session, 아니면 fresh 다', () => {
    const { s, taskId } = validating()
    expect(repairTargetFor(s, taskId, () => true)).toEqual({ kind: 'same-session', sessionId: 'sess1', cwd: 'D:/wt', provider: 'claude', accountId: 'accA' })
    expect(repairTargetFor(s, taskId, () => false)).toEqual({ kind: 'fresh', cwd: 'D:/wt', provider: 'claude', accountId: 'accA' })
  })
  it('구현 Dispatch 가 없으면 null 이다', () => {
    expect(repairTargetFor(emptyState(), 'tsk_x', () => true)).toBeNull()
  })
})

describe('performRepair', () => {
  it('같은 세션이면 --terminal 로 repair spec 을 넣고 Dispatch 의 specPath 를 채운다', async () => {
    const { s, taskId } = validating()
    const judged = unwrap<Task>(applyValidationResult(s, { taskId, results: failing, repair: repairTargetFor(s, taskId, () => true)! }, NOW) as never)
    const deps = makeDeps(judged.state)
    const repair = judged.state.dispatches.find((d) => d.repair)!
    await performRepair(deps, { dispatchId: repair.id })
    expect(deps.started).toHaveLength(1)
    const a = deps.started[0]
    expect(a.terminal).toBe('sess1')
    expect(a.terminalCwd).toBe('D:/wt')
    expect(a.specFileContent).toContain('## Repair request')
    expect(a.specFileContent).toContain('"Typecheck" — exit 1')
    expect(a.specFileContent).toContain(`--dispatch-id ${repair.id}`)
    expect(a.launchPhrase).toContain('did not satisfy the completion checks')
    expect(a.launchPhrase).toContain('{specPath}')
    expect(deps.box.state.dispatches.find((d) => d.id === repair.id)?.specPath).toBe(`C:/specs/${taskId}-${repair.id}.md`)
  })
  it('placeholder 세션이면 새 워커를 띄우고 세션 id 를 채운다', async () => {
    const { s, taskId } = validating()
    const judged = unwrap<Task>(applyValidationResult(s, { taskId, results: failing, repair: repairTargetFor(s, taskId, () => false)! }, NOW) as never)
    const deps = makeDeps(judged.state)
    const repair = judged.state.dispatches.find((d) => d.repair)!
    await performRepair(deps, { dispatchId: repair.id })
    const a = deps.started[0]
    expect(a.terminal).toBeUndefined()
    expect(a.worktree).toBe('D:/wt')
    expect(a.launchPhrase).toBeUndefined()
    expect(deps.box.state.dispatches.find((d) => d.id === repair.id)?.sessionId).toBe('sess-new')
  })
  it('워커를 못 띄우면 Dispatch 를 지우고 Gate 다', async () => {
    const { s, taskId } = validating()
    const judged = unwrap<Task>(applyValidationResult(s, { taskId, results: failing, repair: repairTargetFor(s, taskId, () => true)! }, NOW) as never)
    const deps = makeDeps(judged.state, { startWorker: async () => { throw new Error('boom') } })
    const repair = judged.state.dispatches.find((d) => d.repair)!
    await performRepair(deps, { dispatchId: repair.id })
    expect(deps.box.state.dispatches.some((d) => d.id === repair.id)).toBe(false)
    const task = deps.box.state.tasks.find((t) => t.id === taskId)!
    expect(task.status).toBe('blocked')
    expect(deps.box.state.gates.at(-1)).toMatchObject({ kind: 'convergence-blocked' })
    expect(deps.box.state.gates.at(-1)?.question).toContain('boom')
  })
  it('repair 가 아닌 Dispatch 는 건드리지 않는다', async () => {
    const { s, implId } = validating()
    const deps = makeDeps(s)
    await performRepair(deps, { dispatchId: implId })
    expect(deps.started).toHaveLength(0)
  })
})

describe('repairOnce', () => {
  it('소진 Gate 를 retry-once 로 풀면 예산 밖의 repair 하나를 연다', async () => {
    const { s, taskId, implId } = validating()
    const tripped: OrchState = { ...s, tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, consecutiveFailures: 3 } : t)) }
    const judged = unwrap<Task>(applyValidationResult(tripped, { taskId, results: failing, repair: repairTargetFor(s, taskId, () => true)! }, NOW) as never)
    expect(judged.value.status).toBe('blocked')
    const gate = judged.state.gates.at(-1)!
    const resolved = unwrap(resolveGate(judged.state, { gateId: gate.id, resolution: 'retry-once' }, NOW) as never)
    const deps = makeDeps(resolved.state)
    await repairOnce(deps, { taskId })
    const repair = deps.box.state.dispatches.find((d) => d.repair)!
    expect(repair).toMatchObject({ repair: 'check-failure', retryOf: implId, sessionId: 'sess1' })
    expect(deps.box.state.tasks.find((t) => t.id === taskId)?.status).toBe('dispatched')
    expect(deps.started).toHaveLength(1)
    // 이 시나리오는 repair 를 한 번도 열지 못한 채 소진됐다(카운터만 3 이었다) — 그래서 첫 repair 다.
    // 번호는 repair Dispatch 수에서 오고 카운터에서 오지 않는다(convergence.ts 의 repairCountOf).
    expect(deps.started[0].specFileContent).toContain('This is repair 1 of 3')
  })
})
