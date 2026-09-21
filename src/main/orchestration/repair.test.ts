import { describe, it, expect, vi } from 'vitest'
import { performRepair, repairOnce, repairTargetFor, type RepairDeps } from './repair'
import {
  applyValidationResult, applyWorkerDone, createGate, createJob,
  startJobRun, createTask, emptyState, openDispatch, resolveGate, type OrchState
} from '../../core/orchestration/state'
import type { CheckResult, Dispatch, Task } from '../../core/orchestration/types'

/** 예전의 createRun 한 번 — 이제 계획을 만들고 그 1회차를 시작하는 두 걸음이다. */
const seedRun = (over: Parameters<typeof createJob>[1], now: string) => {
  const planned = unwrap<{ id: string }>(createJob(emptyState(), over, now) as never)
  return unwrap<{ id: string }>(startJobRun(planned.state, planned.value.id, now) as never)
}



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
  let { state: s, value: run } = seedRun({ objective: 'o', cwd: 'D:/p', convergence: {} }, NOW)
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
  it('성공한 repair 를 두 번 부르면 두 번째는 아무 일도 하지 않는다 (specPath 가 이미 채워졌다)', async () => {
    const { s, taskId } = validating()
    const judged = unwrap<Task>(applyValidationResult(s, { taskId, results: failing, repair: repairTargetFor(s, taskId, () => true)! }, NOW) as never)
    const deps = makeDeps(judged.state)
    const repair = judged.state.dispatches.find((d) => d.repair)!
    const first = await performRepair(deps, { dispatchId: repair.id })
    expect(first).toEqual({ ok: true })
    expect(deps.started).toHaveLength(1)
    const second = await performRepair(deps, { dispatchId: repair.id })
    expect(second).toEqual({ ok: true })
    expect(deps.started).toHaveLength(1) // startWorker 를 다시 부르지 않았다 — 재주입도, 재스폰도 없다
  })
  it('판정 시점엔 세션이 살아 있었지만 수행 시점엔 죽어 있으면 fresh 로 내려간다', async () => {
    const { s, taskId } = validating()
    // repairTargetFor(..., () => true) 로 same-session 을 판정했다(판정 시점엔 살아 있었다) — 하지만
    // performRepair 를 수행하는 deps 는 isAlive: () => false 다(그 사이 세션이 죽었다: 재시도·재시작·
    // 복구 스윕이 모두 이 창을 낸다).
    const judged = unwrap<Task>(applyValidationResult(s, { taskId, results: failing, repair: repairTargetFor(s, taskId, () => true)! }, NOW) as never)
    const deps = makeDeps(judged.state, { isAlive: () => false })
    const repair = judged.state.dispatches.find((d) => d.repair)!
    await performRepair(deps, { dispatchId: repair.id })
    const a = deps.started[0]
    expect(a.terminal).toBeUndefined()
    expect(a.terminalCwd).toBeUndefined()
    expect(a.launchPhrase).toBeUndefined()
    expect(a.worktree).toBe('D:/wt')
    expect(deps.box.state.dispatches.find((d) => d.id === repair.id)?.sessionId).toBe('sess-new')
  })
  it('워커가 프로젝트 폴더에 그대로 있으면(committing:false) 커밋 의무 절이 붙지 않는다', async () => {
    let { state: s, value: run } = seedRun({ objective: 'o', cwd: 'D:/p', convergence: {} }, NOW)
    const t = unwrap<{ id: string }>(createTask(s, { runId: run.id, title: 'Auth', spec: 'do auth', deps: [], validateConfigIds: ['c1', 'c2'] }, NOW) as never)
    s = t.state
    // cwd 를 run.cwd 와 같게 둔다 — 워커가 워크트리가 아니라 프로젝트 폴더에서 곧바로 돈 경우다.
    const d = unwrap<{ id: string }>(openDispatch(s, { taskId: t.value.id, provider: 'claude', accountId: 'accA', sessionId: 'sess1', cwd: 'D:/p', specPath: 'C:/specs/a.md' }, NOW) as never)
    s = unwrap(applyWorkerDone(d.state, { taskId: t.value.id, dispatchId: d.value.id, outcome: 'succeeded', subject: 's', body: 'b' }, NOW) as never).state
    const judged = unwrap<Task>(applyValidationResult(s, { taskId: t.value.id, results: failing, repair: repairTargetFor(s, t.value.id, () => true)! }, NOW) as never)
    const deps = makeDeps(judged.state)
    const repair = judged.state.dispatches.find((dd) => dd.repair)!
    await performRepair(deps, { dispatchId: repair.id })
    expect(deps.started).toHaveLength(1)
    expect(deps.started[0].specFileContent).not.toContain('Commit obligation')
    expect(deps.started[0].specFileContent).toContain('## Repair request')
  })
  it('createGate 마저 거절하면(다른 Dispatch 가 이미 열려 있어) Dispatch 를 지우고 Task 를 failed 로 옮긴다', async () => {
    const { s, taskId } = validating()
    const judged = unwrap<Task>(applyValidationResult(s, { taskId, results: failing, repair: repairTargetFor(s, taskId, () => true)! }, NOW) as never)
    const repair = judged.state.dispatches.find((d) => d.repair)!
    // createGate 를 거절시키려고, 정상 경로로는 나올 수 없는 상태를 끼워 넣는다: 같은 Task 에 이미
    // 열린(끝나지 않은) 다른 Dispatch 가 하나 더 있다. repair Dispatch 를 지운 뒤에도 createGate 의
    // "열린 Dispatch" 검사가 그 두 번째 것에 걸려 거절한다 — Gate 자체가 못 열리는 경로를 확인한다.
    const stray: Dispatch = {
      id: 'dsp_stray', taskId, provider: 'claude', accountId: 'accA', sessionId: 'sess-stray',
      cwd: 'D:/wt', specPath: 'x', startedAt: NOW, workerState: 'ready', retained: false
    }
    const rigged: OrchState = { ...judged.state, dispatches: [...judged.state.dispatches, stray] }
    const deps = makeDeps(rigged, { startWorker: async () => { throw new Error('boom') } })
    const res = await performRepair(deps, { dispatchId: repair.id })
    expect(res).toEqual({ ok: false, error: 'boom' })
    expect(deps.box.state.dispatches.some((d) => d.id === repair.id)).toBe(false)
    expect(deps.box.state.dispatches.some((d) => d.id === 'dsp_stray')).toBe(true) // 손대지 않았다
    expect(deps.box.state.gates.length).toBe(0) // Gate 는 못 열렸다
    const task = deps.box.state.tasks.find((t) => t.id === taskId)!
    expect(task.status).toBe('failed') // dispatched 로 남지 않는다 — 그건 아무도 다시 보지 않는다
    expect(task.result).toContain('boom')
  })
  it('startWorker 를 기다리는 동안 동시에 worker_done 이 도착해도 patch 가 그 결과를 덮어쓰지 않는다', async () => {
    const { s, taskId } = validating()
    const judged = unwrap<Task>(applyValidationResult(s, { taskId, results: failing, repair: repairTargetFor(s, taskId, () => true)! }, NOW) as never)
    const repair = judged.state.dispatches.find((d) => d.repair)!
    const deps = makeDeps(judged.state, {
      startWorker: async (a) => {
        // startWorker 가 끝나기 **전에** 다른 흐름이 이 Dispatch 에 worker_done 을 적용한다 —
        // 워커가 그새 빨리 보고를 낸 경우를 흉내낸다. performRepair 의 patch 는 이 결과를 덮어써서는
        // 안 된다(설계: 재확인 후 세 자리만 patch).
        const applied = unwrap(applyWorkerDone(deps.getState(), { taskId, dispatchId: repair.id, outcome: 'succeeded', subject: 'fast', body: 'b' }, NOW) as never)
        await deps.setState(applied.state)
        return { sessionId: a.terminal ?? 'sess-new', cwd: a.terminalCwd ?? 'D:/wt', specPath: `C:/specs/${a.taskId}-${a.dispatchId}.md` }
      }
    })
    await performRepair(deps, { dispatchId: repair.id })
    const patched = deps.box.state.dispatches.find((d) => d.id === repair.id)!
    expect(patched.outcome).toBe('succeeded') // 동시 worker_done 의 결과가 살아 있다
    expect(patched.endedAt).toBeTruthy()
    expect(patched.sessionId).toBe('sess1') // same-session 경로 — 실제 세션 id 그대로
    expect(patched.specPath).toBe(`C:/specs/${taskId}-${repair.id}.md`) // 세 자리는 그래도 patch 된다
  })

  // 전체 브랜치 리뷰, Finding 3 — 두 번째 자리. repairCountOf 는 크래시로 잃은 repair Dispatch 와
  // 그것을 recovery 가 다시 연 replacement 를 둘 다 센다(둘 다 `.repair` 를 지닌다). 그 유령들은
  // 이전 라운드에서 와서 영영 남으므로, 실제로 열린 repair 가 예산 안에서 정상적으로(퇴근·재시도
  // 없이) 이어져도 count 는 우연히 예산을 넘을 수 있다 — 그때도 "사람이 허락했다" 고 말하면 안
  // 된다. grantedExtra 가 없는 한(=repairOnce 로 열리지 않은 한) extra 문구는 절대 붙지 않아야 한다.
  it('repairCountOf 가 유령 Dispatch 때문에 예산을 넘어도, 사람이 허락하지 않았으면 그렇게 말하지 않는다', async () => {
    const { s, taskId } = validating()
    const judged = unwrap<Task>(applyValidationResult(s, { taskId, results: failing, repair: repairTargetFor(s, taskId, () => true)! }, NOW) as never)
    const live = judged.state.dispatches.find((d) => d.repair && !d.endedAt)!
    // 이전 라운드에서 잃고 recovery 가 다시 연 repair Dispatch 셋을 흉내 낸다 — 전부 끝났고, 전부
    // grantedExtra 가 없다(사람이 연 것이 아니다). 이 셋만으로도 repairCountOf(=4, live 포함)가
    // maxFixAttempts(3)를 넘는다.
    const ghost = (n: number): Dispatch => ({
      id: `dsp_ghost_${n}`, taskId, provider: 'claude', accountId: 'accA', sessionId: `sess-ghost-${n}`,
      cwd: 'D:/wt', specPath: 'x', startedAt: NOW, endedAt: NOW, outcome: 'failed', workerState: 'failed',
      retained: false, repair: 'check-failure'
    })
    const rigged: OrchState = { ...judged.state, dispatches: [...judged.state.dispatches, ghost(1), ghost(2), ghost(3)] }
    expect(rigged.dispatches.filter((d) => d.repair)).toHaveLength(4) // count 가 예산 3 을 넘는다
    expect(live.grantedExtra).toBeUndefined() // 이 repair 는 사람이 연 것이 아니다
    const deps = makeDeps(rigged)
    await performRepair(deps, { dispatchId: live.id })
    expect(deps.started).toHaveLength(1)
    expect(deps.started[0].specFileContent).not.toContain('granted by a person')
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
    // repairOnce 는 이제 Dispatch 커밋까지만 기다리고 곧바로 resolve 한다 — performRepair 의 실제
    // 부수 효과(startWorker 호출)는 백그라운드에서 돈다(설계: gate-resolve 가 그 창을 닫으려고
    // 필요한 것은 커밋뿐이다). 그래서 커밋은 await 뒤에 바로 보이지만 deps.started 는 vi.waitFor
    // 로 기다려야 한다.
    const result = await repairOnce(deps, { taskId })
    expect(result).toEqual({ ok: true })
    const repair = deps.box.state.dispatches.find((d) => d.repair)!
    expect(repair).toMatchObject({ repair: 'check-failure', retryOf: implId, sessionId: 'sess1' })
    // repairOnce 는 ignoreCircuit 으로 열므로 이 Dispatch 는 grantedExtra 를 durable 하게 지닌다
    // (전체 브랜치 리뷰, Finding 3 — 두 번째 자리) — repairSpec 이 이것을 읽어야 한다, count 를
    // 다시 세지 않는다.
    expect(repair.grantedExtra).toBe(true)
    expect(deps.box.state.tasks.find((t) => t.id === taskId)?.status).toBe('dispatched')
    await vi.waitFor(() => expect(deps.started).toHaveLength(1))
    // 이 시나리오는 repair 를 한 번도 열지 못한 채(카운터만 3이었다) 소진 Gate 로 갔고, 사람이
    // retry-once 로 그 Gate 를 풀어 예산 밖에 이 repair 를 열었다 — repairCountOf 로는 "1 of 3"
    // 처럼 예산 안으로 보이더라도, 이것은 진짜로 사람이 자동 예산을 넘어 허락한 repair 다. 그래서
    // count 비교가 아니라 grantedExtra 로 판정해야 이 경우를 "extra" 로 정확히 부른다.
    expect(deps.started[0].specFileContent).toContain(
      'This is an extra repair, granted by a person after the budget of 3 was already spent.'
    )
  })
  it('이미 열린 Dispatch 가 있으면 새 Dispatch 를 열지 않는다', async () => {
    const { s, taskId } = validating()
    const tripped: OrchState = { ...s, tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, consecutiveFailures: 3 } : t)) }
    const judged = unwrap<Task>(applyValidationResult(tripped, { taskId, results: failing, repair: repairTargetFor(s, taskId, () => true)! }, NOW) as never)
    const gate = judged.state.gates.at(-1)!
    const resolved = unwrap(resolveGate(judged.state, { gateId: gate.id, resolution: 'retry-once' }, NOW) as never)
    // 다른 흐름이 이미 이 Task 에 Dispatch 를 열어 둔 상태를 흉내낸다(ignoreCircuit 은 그 다른
    // 흐름이 어떻게 열었는지와는 무관하다 — 여기서는 그저 "이미 열려 있다"만 필요하다).
    const already = unwrap<{ id: string }>(openDispatch(resolved.state, { taskId, provider: 'claude', accountId: 'accA', sessionId: 'sess2', cwd: 'D:/wt', specPath: '', ignoreCircuit: true }, NOW) as never)
    const deps = makeDeps(already.state)
    // 전체 브랜치 리뷰, Finding 5 — repairOnce 는 이제 이 거절을 돌려준다. void 였을 때는 부르는 쪽이
    // "아무것도 안 열렸다" 는 사실을 알 방법이 없었다.
    const result = await repairOnce(deps, { taskId })
    expect(result.ok).toBe(false)
    expect(deps.started).toHaveLength(0)
    const open = deps.box.state.dispatches.filter((d) => d.taskId === taskId && !d.outcome && !d.endedAt)
    expect(open).toHaveLength(1)
    expect(open[0].id).toBe(already.value.id) // openDispatch 가 거절했다 — 새 Dispatch 는 없다
  })

  // 전체 브랜치 리뷰, Finding 5 — 이 Task 를 막는 두 번째 Gate 가 아직 열려 있으면 resolveGate 는
  // blocked 를 그대로 둔다(stillBlocked). 그 상태로 repairOnce 가 openDispatch 를 부르면 "task is
  // blocked by an open gate" 로 거절되고, 사람의 retry-once 는 아무것도 열지 못한다 — 그 사실이
  // 반환값에 남아야 한다.
  it('두 번째 열린 Gate 가 여전히 막으면 openDispatch 가 거절하고, 그 거절이 반환값에 남는다', async () => {
    const { s, taskId } = validating()
    const tripped: OrchState = { ...s, tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, consecutiveFailures: 3 } : t)) }
    const judged = unwrap<Task>(applyValidationResult(tripped, { taskId, results: failing, repair: repairTargetFor(s, taskId, () => true)! }, NOW) as never)
    const gate = judged.state.gates.at(-1)!
    // 같은 Task 에 두 번째 Gate 를 하나 더 연다 — createGate 는 이미 blocked 인 Task 도 받아 준다
    // (moveTask 의 자기 자신으로의 전이는 그대로 통과한다).
    const second = unwrap(createGate(judged.state, { taskId, question: 'another question' }, NOW) as never)
    const resolved = unwrap(resolveGate(second.state, { gateId: gate.id, resolution: 'retry-once' }, NOW) as never)
    // 두 번째 Gate 가 아직 열려 있으므로 Task 는 여전히 blocked 다.
    expect(resolved.state.tasks.find((t) => t.id === taskId)?.status).toBe('blocked')
    const deps = makeDeps(resolved.state)
    const result = await repairOnce(deps, { taskId })
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.error).toContain('blocked by an open gate')
    expect(deps.started).toHaveLength(0)
  })
})
