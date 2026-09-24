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
        validateConfigIds: ['c1'],
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
        return { runId: `r${startedOpts.length}` }
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
    // 다음 runs.start 가 본 StartOpts. **start 가 돌아온 뒤에야 풀린다** — 가짜 start 안에서 바로
    // 풀면 validator 가 head.runId 를 적기 전에 테스트가 onRunExit 을 배달해, 그 exit 가 남의 실행으로
    // 읽혀 버려진다(validator.ts 의 startCheck).
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
    await plain.settle()
    expect(plain.task().suspiciousFiles).toBeUndefined()
    const conv = rig({ convergence: true, filesModified: ['vitest.config.ts'] })
    conv.validation.startValidation({ taskId: conv.taskId, cwd: conv.cwd })
    await vi.waitFor(() => expect(conv.task().suspiciousFiles).toEqual(['vitest.config.ts']))
  })

  it('with no checkpoint head it uses the Task’s filesModified and never runs git (R12)', async () => {
    const conv = rig({ convergence: true, filesModified: ['vitest.config.ts'] })
    conv.validation.startValidation({ taskId: conv.taskId, cwd: conv.cwd })
    await vi.waitFor(() => expect(conv.task().suspiciousFiles).toEqual(['vitest.config.ts']))
    expect(conv.diffNames).not.toHaveBeenCalled()
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
    } finally {
      vi.useRealTimers()
    }
  })
})
