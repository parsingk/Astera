// createTaskValidation(validation.ts) — 앱(ipc.ts 의 bootOrch)과 Host 가 같은 것을 짓는 검증 배선.
// 순수 층으로 validating 상태를 세우고, 가짜는 ValidationContext 의 바깥 자리(runs·startReview·
// startRepair·diffNames·경로 가드)뿐이다. 실행의 끝은 validator.onRunExit 으로 손수 배달한다.
//
// 속성 5(convergence 가 없는 Run 에는 suspiciousFiles 를 쓰지 않는다)는 예전에는
// ipcConvergenceWiring.test.ts 의 글자 가드였다 — 이제 여기서 동작으로 지킨다(R28).
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTaskValidation, type ValidationContext } from './validation'
import { applyWorkerDone, createJob, createTask, emptyState, openDispatch, startJobRun, type OrchState } from '../state'
import { CHECK_TIMEOUT_MS } from '../types'
import type { StartOpts } from '../../run/runManager'

const NOW = '2026-09-24T00:00:00.000Z'
const unwrap = <T>(r: { ok: boolean } & Record<string, unknown>): { state: OrchState; value: T } => {
  if (!r.ok) throw new Error(`expected ok, got ${String(r.error)}`)
  return { state: r.state as OrchState, value: r.value as T }
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

interface RigOpts {
  review?: boolean
  convergence?: boolean
  filesModified?: string[]
  guard?: (p: string) => Promise<string>
  stopThrows?: boolean
  /** runs.start 가 돌아오기 **전에** 마이크로태스크로 이 exit 코드를 배달한다 — 앱의 Host pty 팩토리가
   *  소켓이 끊긴 채 spawn 할 때(src/main/host/ptyFactory.ts 의 startDead) 하는 그대로다(review I1). */
  exitInMicrotask?: number
}

function rig(o: RigOpts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astera-validation-'))
  dirs.push(dir)
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } })
  )
  const cwd = dir

  // validating 에 닿은 Task — createJob → startJobRun → createTask → openDispatch → applyWorkerDone
  const planned = unwrap<{ id: string }>(
    createJob(emptyState(), { objective: 'o', cwd, ...(o.convergence ? { convergence: {} } : {}) }, NOW) as never
  )
  const started0 = unwrap<{ id: string }>(startJobRun(planned.state, planned.value.id, NOW) as never)
  const t = unwrap<{ id: string }>(
    createTask(
      started0.state,
      {
        runId: started0.value.id,
        title: 'T',
        spec: 'do it',
        deps: [],
        // 실재하는 구성이다(package.json 의 test 스크립트) — startValidation 이 큐에 넣는 check 가 진짜로
        // 떠서, finish() 가 그 run 을 끝내 치울 수 있다(review m3).
        validateConfigIds: ['seed:npm:test'],
        ...(o.review ? { reviewRequested: true } : {})
      },
      NOW
    ) as never
  )
  const d = unwrap<{ id: string }>(
    openDispatch(
      t.state,
      { taskId: t.value.id, provider: 'claude', accountId: 'accA', sessionId: 'sess1', cwd, specPath: path.join(dir, 'spec.md') },
      NOW
    ) as never
  )
  let state = unwrap(
    applyWorkerDone(
      d.state,
      {
        taskId: t.value.id,
        dispatchId: d.value.id,
        outcome: 'succeeded',
        subject: 's',
        body: 'b',
        ...(o.filesModified ? { filesModified: o.filesModified } : {})
      },
      NOW
    ) as never
  ).state
  const taskId = t.value.id
  if (state.tasks.find((x) => x.id === taskId)?.status !== 'validating') throw new Error('rig: not validating')

  const logs: string[] = []
  const startedOpts: StartOpts[] = []
  let stops = 0
  const startReview = vi.fn(async (_a: { taskId: string }) => {})
  const startRepair = vi.fn(async (_a: { dispatchId: string }) => undefined as unknown)
  const diffNames = vi.fn(async (_cwd: string, _head: string) => null as string[] | null)

  const ctx: ValidationContext = {
    getState: () => state,
    setState: async (next) => {
      state = next
    },
    now: () => NOW,
    lang: () => 'en',
    log: (m) => logs.push(m),
    assertAllowedPath: o.guard ?? (async (p) => p),
    storedConfigs: () => [],
    runs: {
      start: (opts) => {
        startedOpts.push(opts)
        const runId = `r${startedOpts.length}`
        const code = o.exitInMicrotask
        if (code !== undefined) queueMicrotask(() => validation.validator.onRunExit({ runId, exitCode: code }))
        return { runId }
      },
      recentOutput: () => '',
      stop: () => {
        stops++
        if (o.stopThrows) throw new Error('pty already gone')
      }
    },
    isAlive: () => true,
    startReview,
    startRepair,
    firstCheckpointHead: () => null,
    diffNames
  }
  const validation = createTaskValidation(ctx)

  return {
    validation,
    taskId,
    cwd,
    logs,
    startReview,
    startRepair,
    diffNames,
    // 다음 runs.start 가 본 StartOpts. **start 가 돌아온 뒤에야 풀린다**, 그리고 이 모형은 exit 가
    // **이벤트 루프에서** 온다고 가정한다(node-pty 가 그렇다) — 그래서 테스트가 배달하는 exit 는 언제나
    // validator 가 head.runId 를 적은 뒤에 닿는다. start 와 같은 틱(마이크로태스크)에 오는 exit 는 다른
    // 경로다: 앱의 Host pty 팩토리가 소켓이 끊긴 채 spawn 하면 그렇게 온다. 그 경우는 `exitInMicrotask`
    // 로 따로 시험하고, validator.ts 가 그런 exit 를 잃지 않는다(review I1 의 수정, TaskValidator.early).
    started: async (): Promise<StartOpts> => {
      const n = startedOpts.length
      await vi.waitFor(() => {
        if (startedOpts.length <= n) throw new Error('runs.start not called yet')
      })
      await new Promise((r) => setTimeout(r, 0))
      return startedOpts[n]
    },
    lastRunId: () => `r${startedOpts.length}`,
    task: () => state.tasks.find((x) => x.id === taskId)!,
    state: () => state,
    runsStarted: () => startedOpts.length,
    stopCalls: () => stops,
    /** 떠 있는 검증 실행을 끝낸다 — 마지막으로 뜬 run 에 exit 를 배달하고 Task 가 validating 을
     *  떠날 때까지 기다린다. 테스트가 끝나 afterEach 가 임시 폴더를 지우기 전에 validator 의 head 와
     *  그 타이머를 치운다(review m3). 가짜 타이머 아래에서도 돈다(vi.waitFor 만 쓴다). runs.start 가
     *  불린 직후, validator 가 runId 를 적기 전에 배달될 수 있지만 그래도 잃지 않는다 — start 가 도는
     *  동안 온 exit 는 TaskValidator.earlyExits 가 붙잡는다(review I1). */
    finish: async (exitCode = 0) => {
      await vi.waitFor(() => {
        if (startedOpts.length === 0) throw new Error('runs.start not called yet')
      })
      validation.validator.onRunExit({ runId: `r${startedOpts.length}`, exitCode })
      await vi.waitFor(() => expect(state.tasks.find((x) => x.id === taskId)!.status).not.toBe('validating'))
    },
    settle: async () => {
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
    }
  }
}

describe('createTaskValidation', () => {
  it('a passing check commits the Task completed and asks for nothing else (no review, no repair)', async () => {
    const h = rig({ review: false })
    h.validation.validator.enqueue({ taskId: h.taskId, cwd: h.cwd, configIds: ['seed:npm:test'] })
    const run = await h.started()
    expect(run.validation).toBe(true)
    expect(run.projectPath).toBe(h.cwd)
    h.validation.validator.onRunExit({ runId: h.lastRunId(), exitCode: 0 })
    await vi.waitFor(() => expect(h.task().status).toBe('completed'))
    expect(h.startReview).not.toHaveBeenCalled()
    expect(h.startRepair).not.toHaveBeenCalled()
  })

  it('a pass on a Task with review requested hands it to startReview after the commit', async () => {
    const h = rig({ review: true })
    h.validation.validator.enqueue({ taskId: h.taskId, cwd: h.cwd, configIds: ['seed:npm:test'] })
    await h.started()
    h.validation.validator.onRunExit({ runId: h.lastRunId(), exitCode: 0 })
    await vi.waitFor(() => expect(h.startReview).toHaveBeenCalledWith({ taskId: h.taskId }))
    expect(h.task().status).toBe('reviewing')
  })

  it('a failure on a convergence Run opens a repair Dispatch and starts it only after the commit', async () => {
    const h = rig({ convergence: true })
    h.validation.validator.enqueue({ taskId: h.taskId, cwd: h.cwd, configIds: ['seed:npm:test'] })
    await h.started()
    h.validation.validator.onRunExit({ runId: h.lastRunId(), exitCode: 1 })
    await vi.waitFor(() => expect(h.startRepair).toHaveBeenCalledTimes(1))
    const { dispatchId } = h.startRepair.mock.calls[0][0]
    expect(h.state().dispatches.find((d) => d.id === dispatchId)?.repair).toBeDefined()
  })

  it('a path the guard refuses becomes a Gate, never a run (onCannotRun)', async () => {
    const h = rig({
      guard: async () => {
        throw new Error('path not allowed')
      }
    })
    h.validation.validator.enqueue({ taskId: h.taskId, cwd: h.cwd, configIds: ['seed:npm:test'] })
    await vi.waitFor(() => expect(h.task().status).toBe('blocked'))
    expect(h.runsStarted()).toBe(0)
  })

  // Property 5, as behaviour (R28): no suspiciousFiles on a Run without a convergence policy.
  it('writes suspiciousFiles only on a convergence Run', async () => {
    const plain = rig({ filesModified: ['vitest.config.ts'] })
    plain.validation.startValidation({ taskId: plain.taskId, cwd: plain.cwd })
    await plain.finish()
    await plain.settle()
    expect(plain.task().suspiciousFiles).toBeUndefined()
    // 같은 조기 반환이 완료 정책 지문도 막는다(review m2) — 아래 convergence 쪽은 그것을 찍는다.
    expect(plain.task().policySnapshot).toBeUndefined()
    const conv = rig({ convergence: true, filesModified: ['vitest.config.ts'] })
    conv.validation.startValidation({ taskId: conv.taskId, cwd: conv.cwd })
    await vi.waitFor(() => expect(conv.task().suspiciousFiles).toEqual(['vitest.config.ts']))
    await vi.waitFor(() => expect(conv.task().policySnapshot).toBeDefined())
    await conv.finish()
  })

  it('with no checkpoint head it uses the Task’s filesModified and never runs git (R12)', async () => {
    const conv = rig({ convergence: true, filesModified: ['vitest.config.ts'] })
    conv.validation.startValidation({ taskId: conv.taskId, cwd: conv.cwd })
    await vi.waitFor(() => expect(conv.task().suspiciousFiles).toEqual(['vitest.config.ts']))
    expect(conv.diffNames).not.toHaveBeenCalled()
    await conv.finish()
  })

  // B7: the validator's own timeout calls runner.stop, which is the module's wrapper around ctx.runs.stop.
  it('a runs.stop that throws inside the validator’s timeout is logged, never thrown', async () => {
    vi.useFakeTimers()
    try {
      const h = rig({ stopThrows: true }) // ctx.runs.stop throws Error('pty already gone')
      h.validation.validator.enqueue({ taskId: h.taskId, cwd: h.cwd, configIds: ['seed:npm:test'] })
      await vi.waitFor(() => expect(h.runsStarted()).toBe(1))
      // Past the check deadline: TaskValidator's startCheck timer fires and calls runner.stop.
      expect(() => vi.advanceTimersByTime(CHECK_TIMEOUT_MS + 1)).not.toThrow()
      expect(h.stopCalls()).toBe(1)
      expect(h.logs.join('\n')).toMatch(/run.stop failed/)
      // 치운다(review m3): 멈춘 run 의 exit 가 첫 timeout 으로 읽혀 같은 check 가 다시 뜨고(r2),
      // 그 exit 로 Task 가 validating 을 떠난다 — head 와 그 타이머가 남지 않는다.
      h.validation.validator.onRunExit({ runId: 'r1', exitCode: 1 })
      await vi.waitFor(() => expect(h.runsStarted()).toBe(2))
      await h.finish()
      expect(h.task().status).toBe('completed')
    } finally {
      vi.useRealTimers()
    }
  })

  // Review I1: 앱의 Host pty 팩토리는 소켓이 끊긴 채 spawn 하면 exit 를 RunManager.start 안에서
  // 마이크로태스크로 줄 세운다 — runner.start 가 돌아오기 전에, 그래서 startCheck 가 head.runId 를 적기
  // 전에 onRunExit 에 닿는다. 그 exit 를 버리면 timeout 의 stop 은 이미 끝난 run 에 no-op 이고, 둘째
  // exit 는 오지 않으므로 그 폴더의 검증 큐가 앱을 다시 켤 때까지 멈춘다.
  it('an exit delivered in the same tick as the start still settles the check', async () => {
    const h = rig({ exitInMicrotask: 1 })
    h.validation.validator.enqueue({ taskId: h.taskId, cwd: h.cwd, configIds: ['seed:npm:test'] })
    await vi.waitFor(() => expect(h.task().status).not.toBe('validating'))
    expect(h.runsStarted()).toBe(1)
    expect(h.logs.join(' | ')).not.toMatch(/could not start|rejected/)
  })
})
