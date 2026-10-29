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
import { CHECK_TIMEOUT_MS, type CheckResult } from '../types'
import type { StartOpts } from '../../run/runManager'
import type { RunConfig } from '../../run/config'
import type { CompletionCheckInput, PluginCheckAnswer } from '../pluginChecks'

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
  /** The journal's answer for the first checkpoint head; null (no baseline) when left out. */
  checkpointHead?: () => string | null | 'unknown' | Promise<string | null | 'unknown'>
  /** The Task's check list; `['seed:npm:test']` when left out. */
  checks?: string[]
  /** The Task's skipped round (plugin Phase 5 C9), of the rig's attempt unless it names another */
  checkResume?: { dispatchId?: string; done: CheckResult[]; rest: string[] }
  /** How a plugin check is asked (plugin Phase 5 C8); answers passed when left out. */
  pluginCheck?: (plugin: string, input: CompletionCheckInput) => Promise<PluginCheckAnswer>
  /** The Host command a round reaching github:ci calls (GitHub lifecycle G3a); absent when left out. */
  lifecycleCiBegin?: ValidationContext['lifecycleCiBegin']
  /** The kind the rig's attempt ran in (Task K), and its CLI ('claude' when left out) */
  sandboxKind?: 'sandbox' | 'deny-only'
  provider?: 'claude' | 'codex'
  /** The saved configurations of the project; none when left out */
  stored?: RunConfig[]
  /** ValidationContext's checkEnv and sandboxedCheck (Task K); absent when left out */
  checkEnv?: ValidationContext['checkEnv']
  sandboxedCheck?: ValidationContext['sandboxedCheck']
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
        validateConfigIds: o.checks ?? ['seed:npm:test'],
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
  if (o.sandboxKind || o.provider) {
    const kind = o.sandboxKind ? { sandboxKind: o.sandboxKind } : {}
    state = { ...state, dispatches: state.dispatches.map((x) => (x.id === d.value.id ? { ...x, ...kind, provider: o.provider ?? x.provider } : x)) }
  }
  if (o.checkResume) {
    const checkResume = { ...o.checkResume, dispatchId: o.checkResume.dispatchId ?? d.value.id }
    state = { ...state, tasks: state.tasks.map((x) => (x.id === taskId ? { ...x, checkResume } : x)) }
  }
  const pluginAsks: Array<{ plugin: string; input: CompletionCheckInput }> = []

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
    storedConfigs: () => o.stored ?? [],
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
    firstCheckpointHead: o.checkpointHead ?? (() => null),
    diffNames,
    pluginCheck: async (plugin, input) => {
      pluginAsks.push({ plugin, input })
      return o.pluginCheck ? o.pluginCheck(plugin, input) : { name: plugin.toUpperCase(), status: 'passed', summary: 'passed' }
    },
    ...(o.lifecycleCiBegin ? { lifecycleCiBegin: o.lifecycleCiBegin } : {}),
    ...(o.checkEnv ? { checkEnv: o.checkEnv } : {}),
    ...(o.sandboxedCheck ? { sandboxedCheck: o.sandboxedCheck } : {})
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
    pluginAsks,
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

describe('createTaskValidation — a plugin check (plugin Phase 5 C3, C8, C9, C11)', () => {
  it('asks the plugin with the Task’s input, and a pass completes the Task', async () => {
    const h = rig({ checks: ['plugin:d'] })
    h.validation.startValidation({ taskId: h.taskId, cwd: h.cwd })
    await vi.waitFor(() => expect(h.task().status).toBe('completed'))
    expect(h.pluginAsks).toHaveLength(1)
    expect(h.pluginAsks[0].plugin).toBe('d')
    expect(h.pluginAsks[0].input).toMatchObject({ taskId: h.taskId, task: { title: 'T' }, workspace: { root: h.cwd } })
    expect(h.task().checks).toEqual([expect.objectContaining({ configId: 'plugin:d', name: 'D', status: 'passed' })])
  })

  it('a failure in a convergence Job records the findings and opens a repair', async () => {
    const h = rig({
      checks: ['plugin:d'],
      convergence: true,
      pluginCheck: async () => ({ name: 'D', status: 'failed', summary: '1 leftover', diagnostics: [{ file: 'a.ts', line: 3, message: 'adds console.log' }] })
    })
    h.validation.startValidation({ taskId: h.taskId, cwd: h.cwd })
    await vi.waitFor(() => expect(h.startRepair).toHaveBeenCalled())
    expect(h.task().checks?.[0].diagnostics).toEqual([{ file: 'a.ts', line: 3, message: 'adds console.log' }])
  })

  // 5d: the count of findings the Host did not keep reaches the Task's record
  it('records how many findings the check gave beside the ones kept', async () => {
    const h = rig({
      checks: ['plugin:d'],
      convergence: true,
      pluginCheck: async () => ({ name: 'D', status: 'failed', summary: 'many', diagnostics: [{ message: 'm' }], diagnosticsTotal: 150 })
    })
    h.validation.startValidation({ taskId: h.taskId, cwd: h.cwd })
    await vi.waitFor(() => expect(h.startRepair).toHaveBeenCalled())
    expect(h.task().checks?.[0].diagnosticsTotal).toBe(150)
  })

  it('goes on from a skipped round: runs the rest alone, the carried results first, and clears the bookkeeping', async () => {
    const done: CheckResult[] = [
      { configId: 'plugin:a', name: 'A', status: 'passed', summary: 'ok' },
      { configId: 'plugin:b', name: 'B', status: 'not-run', skipped: true, summary: 'Skipped by a person: down' }
    ]
    const h = rig({ checks: ['plugin:a', 'plugin:b', 'plugin:c'], checkResume: { done, rest: ['plugin:c'] } })
    h.validation.startValidation({ taskId: h.taskId, cwd: h.cwd })
    await vi.waitFor(() => expect(h.task().status).toBe('completed'))
    expect(h.pluginAsks.map((x) => x.plugin)).toEqual(['c'])
    expect(h.task().checks?.map((c) => c.configId)).toEqual(['plugin:a', 'plugin:b', 'plugin:c'])
    expect(h.task()).not.toHaveProperty('checkResume')
  })

  // 5a final review C1: a skipped round of another attempt checked other work
  it('runs every check when the skipped round is another attempt’s', async () => {
    const done: CheckResult[] = [{ configId: 'plugin:a', name: 'A', status: 'passed', summary: 'ok' }]
    const h = rig({ checks: ['plugin:a', 'plugin:b'], checkResume: { dispatchId: 'dsp_earlier', done, rest: ['plugin:b'] } })
    h.validation.startValidation({ taskId: h.taskId, cwd: h.cwd })
    await vi.waitFor(() => expect(h.task().status).toBe('completed'))
    expect(h.pluginAsks.map((x) => x.plugin)).toEqual(['a', 'b'])
    expect(h.task()).not.toHaveProperty('checkResume')
  })

  it('does not ask a plugin for a folder the guard refuses: the Task waits on a plain question', async () => {
    const h = rig({
      checks: ['plugin:d'],
      guard: async () => {
        throw new Error('not an allowed path')
      }
    })
    h.validation.startValidation({ taskId: h.taskId, cwd: h.cwd })
    await vi.waitFor(() => expect(h.task().status).toBe('blocked'))
    expect(h.pluginAsks).toEqual([])
    expect(h.state().gates.find((g) => g.taskId === h.taskId)?.kind).toBeUndefined()
  })

  it('does not ask for a Task that left validating while it waited', async () => {
    const h = rig({ checks: ['plugin:d'] })
    const s = h.state()
    await (async () => {
      const moved = { ...s, tasks: s.tasks.map((x) => (x.id === h.taskId ? { ...x, status: 'failed' as const } : x)) }
      // The rig's state box is written through the validation's own setState
      Object.assign(s, moved)
    })()
    h.validation.validator.enqueue({ taskId: h.taskId, cwd: h.cwd, configIds: ['plugin:d'] })
    await h.settle()
    await h.settle()
    expect(h.pluginAsks).toEqual([])
  })

  it('names a plugin check in the completion policy’s fingerprint', async () => {
    const h = rig({ checks: ['plugin:d'], convergence: true })
    h.validation.startValidation({ taskId: h.taskId, cwd: h.cwd })
    await vi.waitFor(() => expect(h.task().policySnapshot).toBeDefined())
    expect(h.task().policySnapshot!.key.endsWith('|plugin:d=plugin')).toBe(true)
  })
})

// GitHub lifecycle G3a (design §4): the round reaching github:ci goes to the Host command lifecycle-ci-begin
describe('createTaskValidation — github:ci', () => {
  it('asks the Host to keep the round and leaves the Task validating', async () => {
    const asked: unknown[] = []
    const h = rig({ checks: ['github:ci'], convergence: true, lifecycleCiBegin: async (a) => (asked.push(a), { status: 200, body: {} }) })
    h.validation.startValidation({ taskId: h.taskId, cwd: h.cwd })
    await vi.waitFor(() => expect(asked).toEqual([{ taskId: h.taskId, done: [] }]))
    await h.settle()
    expect(h.task().status).toBe('validating')
  })

  it('a refusal from the Host asks a person, in the Host’s words', async () => {
    const h = rig({ checks: ['github:ci'], convergence: true, lifecycleCiBegin: async () => ({ status: 409, body: { error: 'task tsk_x is not a lifecycle Task' } }) })
    h.validation.startValidation({ taskId: h.taskId, cwd: h.cwd })
    await vi.waitFor(() => expect(h.task().status).toBe('blocked'))
    expect(h.state().gates.find((g) => g.taskId === h.taskId)?.question).toContain('task tsk_x is not a lifecycle Task')
  })

  it('names github:ci in the completion policy’s fingerprint', async () => {
    const h = rig({ checks: ['github:ci'], convergence: true, lifecycleCiBegin: async () => ({ status: 200, body: {} }) })
    h.validation.startValidation({ taskId: h.taskId, cwd: h.cwd })
    await vi.waitFor(() => expect(h.task().policySnapshot).toBeDefined())
    expect(h.task().policySnapshot!.key.endsWith('|github:ci=github')).toBe(true)
  })
})

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

  // Stage 3 T1 review: a journal too busy to answer is not "no baseline". The diff cannot run without the
  // head, so the Task's filesModified still stands in (skipping would drop the warning), and the log says
  // the baseline was unreadable rather than absent.
  it('a checkpoint head the journal could not read falls back to filesModified, logged as unreadable', async () => {
    const conv = rig({ convergence: true, filesModified: ['vitest.config.ts'], checkpointHead: async () => 'unknown' })
    conv.validation.startValidation({ taskId: conv.taskId, cwd: conv.cwd })
    await vi.waitFor(() => expect(conv.task().suspiciousFiles).toEqual(['vitest.config.ts']))
    expect(conv.diffNames).not.toHaveBeenCalled()
    expect(conv.logs.some((l) => /baseline .*could not be read/.test(l))).toBe(true)
    await conv.finish()
  })

  it('an asynchronous checkpoint head is awaited and diffed from', async () => {
    const conv = rig({ convergence: true, filesModified: ['x.ts'], checkpointHead: async () => 'abc123' })
    conv.diffNames.mockResolvedValue(['vitest.config.ts'])
    conv.validation.startValidation({ taskId: conv.taskId, cwd: conv.cwd })
    await vi.waitFor(() => expect(conv.task().suspiciousFiles).toEqual(['vitest.config.ts']))
    expect(conv.diffNames).toHaveBeenCalledWith(conv.cwd, 'abc123')
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

// GitHub lifecycle G3a (design §4): the Host settles a handed-off round with the CI result, then starts what it opened
describe('createTaskValidation — settleHandedOff', () => {
  const policy = { ci: { mode: 'required' as const }, autoRerunInfrastructureFailures: true, maxInfrastructureReruns: 2, ciWaitMinutes: 90 }
  const handedOver = (): OrchState => ({
    ...emptyState(),
    jobs: [{ id: 'job_1', objective: 'o', cwd: '/p', createdAt: NOW, github: policy, convergence: {} }],
    runs: [{ id: 'run_1', jobId: 'job_1', ordinal: 1, createdAt: NOW, worktree: '/wt-run' }],
    tasks: [
      { id: 'tsk_a', runId: 'run_1', title: 'a', spec: 's', deps: [], status: 'completed', consecutiveFailures: 0, createdAt: NOW, updatedAt: NOW },
      {
        id: 'tsk_l', runId: 'run_1', kind: 'lifecycle', title: 'GitHub 전달', spec: 's', deps: ['tsk_a'], status: 'validating', validateConfigIds: ['lint', 'github:ci'],
        reviewRequested: true, consecutiveFailures: 0, createdAt: NOW, updatedAt: NOW, convergenceStartedAt: NOW,
        ciWait: { since: NOW, done: [{ configId: 'lint', name: 'lint', status: 'passed' }] }
      }
    ]
  })
  const wired = () => {
    let state = handedOver()
    const startReview = vi.fn(async (_a: { taskId: string }) => {})
    const startRepair = vi.fn(async (_a: { dispatchId: string }) => undefined as unknown)
    const validation = createTaskValidation({
      getState: () => state,
      setState: async (next) => { state = next },
      now: () => NOW,
      lang: () => 'en',
      log: () => {},
      assertAllowedPath: async (p) => p,
      storedConfigs: () => [],
      runs: { start: () => ({ runId: 'r' }), recentOutput: () => '', stop: () => {} },
      isAlive: () => true,
      startReview,
      startRepair,
      firstCheckpointHead: () => null,
      diffNames: async () => null,
      pluginCheck: async (plugin) => ({ name: plugin, status: 'passed', summary: 'passed' })
    })
    return { validation, startReview, startRepair, task: () => state.tasks.find((t) => t.id === 'tsk_l')! }
  }

  it('a passing CI result settles the round and starts the review once', async () => {
    const w = wired()
    await w.validation.settleHandedOff({ taskId: 'tsk_l', result: { configId: 'github:ci', name: 'GitHub CI', status: 'passed' } })
    expect(w.task()).toMatchObject({ status: 'reviewing' })
    expect(w.task().ciWait).toBeUndefined()
    await vi.waitFor(() => expect(w.startReview).toHaveBeenCalledWith({ taskId: 'tsk_l' }))
    expect(w.startReview).toHaveBeenCalledTimes(1)
  })

  // G3c1: the class the Host read reaches the count
  it('carries the class of a failed CI to the lifecycle Task’s count', async () => {
    const w = wired()
    await w.validation.settleHandedOff({ taskId: 'tsk_l', ciClass: 'unknown', result: { configId: 'github:ci', name: 'GitHub CI', status: 'failed', summary: 'deploy (unknown): exit 1' } })
    expect(w.task().ciUnknowns).toBe(1)
  })

  it('a second settle changes nothing', async () => {
    const w = wired()
    await w.validation.settleHandedOff({ taskId: 'tsk_l', result: { configId: 'github:ci', name: 'GitHub CI', status: 'passed' } })
    const after = w.task()
    await w.validation.settleHandedOff({ taskId: 'tsk_l', result: { configId: 'github:ci', name: 'GitHub CI', status: 'failed' } })
    expect(w.task()).toBe(after)
  })

  // G3b1 final review I1: a verdict read for a round before is not this round's
  it('a verdict for another round changes nothing', async () => {
    const w = wired()
    const before = w.task()
    await w.validation.settleHandedOff({ taskId: 'tsk_l', since: '2026-01-01T00:00:00.000Z', result: { configId: 'github:ci', name: 'GitHub CI', status: 'passed' } })
    expect(w.task()).toBe(before)
    expect(w.startReview).not.toHaveBeenCalled()
  })
})

// GitHub lifecycle G3c1 (design §3.4 S7): a lifecycle Task's work is the Run's whole branch, so its suspicious files are
// measured from the Run's base, with or without a repair of its own
describe('createTaskValidation — suspicious files of a lifecycle Task', () => {
  const policy = { ci: { mode: 'required' as const }, autoRerunInfrastructureFailures: true, maxInfrastructureReruns: 2, ciWaitMinutes: 90 }
  const BASE = 'b'.repeat(40)
  const lifecycle = (o: { base?: boolean; filesModified?: string[] } = {}): OrchState => ({
    ...emptyState(),
    jobs: [{ id: 'job_1', objective: 'o', cwd: '/p', createdAt: NOW, github: policy, convergence: {} }],
    runs: [{ id: 'run_1', jobId: 'job_1', ordinal: 1, createdAt: NOW, worktree: '/wt-run', ...(o.base !== false ? { git: { base: BASE } } : {}) }],
    tasks: [
      { id: 'tsk_a', runId: 'run_1', title: 'a', spec: 's', deps: [], status: 'completed', consecutiveFailures: 0, createdAt: NOW, updatedAt: NOW },
      {
        id: 'tsk_l', runId: 'run_1', kind: 'lifecycle', title: 'GitHub 전달', spec: 's', deps: ['tsk_a'], status: 'validating', validateConfigIds: ['github:ci'],
        reviewRequested: true, consecutiveFailures: 0, createdAt: NOW, updatedAt: NOW, convergenceStartedAt: NOW,
        ...(o.filesModified ? { filesModified: o.filesModified } : {})
      }
    ]
  })
  const wired = (start: OrchState, diffNames: (cwd: string, head: string) => Promise<string[] | null>) => {
    let state = start
    const validation = createTaskValidation({
      getState: () => state,
      setState: async (next) => { state = next },
      now: () => NOW,
      lang: () => 'en',
      log: () => {},
      assertAllowedPath: async (p) => p,
      storedConfigs: () => [],
      runs: { start: () => ({ runId: 'r1' }), recentOutput: () => '', stop: () => {} },
      isAlive: () => true,
      startReview: async () => {},
      startRepair: async () => undefined,
      firstCheckpointHead: () => null,
      diffNames,
      pluginCheck: async (plugin) => ({ name: plugin, status: 'passed', summary: 'passed' }),
      lifecycleCiBegin: async () => ({ status: 200, body: {} })
    })
    return { validation, task: () => state.tasks.find((t) => t.id === 'tsk_l')! }
  }

  it('measures them from the Run’s base in the Run root, before any repair of its own', async () => {
    const diffNames = vi.fn(async () => ['package.json', 'src/a.ts'])
    const w = wired(lifecycle(), diffNames)
    w.validation.startValidation({ taskId: 'tsk_l', cwd: '/wt-run' })
    await vi.waitFor(() => expect(w.task().suspiciousFiles).toEqual(['package.json']))
    expect(diffNames).toHaveBeenCalledWith('/wt-run', BASE)
  })

  it('falls back to what the Task reported when the Run has no base', async () => {
    const diffNames = vi.fn(async () => ['package.json'])
    const w = wired(lifecycle({ base: false, filesModified: ['vitest.config.ts'] }), diffNames)
    w.validation.startValidation({ taskId: 'tsk_l', cwd: '/wt-run' })
    await vi.waitFor(() => expect(w.task().suspiciousFiles).toEqual(['vitest.config.ts']))
    expect(diffNames).not.toHaveBeenCalled()
  })
})

// GitHub lifecycle G3c1: the loop end to end — a CI failure opens a repair in the Run root, its done report starts the
// round again in the Run root, and that round hands over to GitHub again
describe('the lifecycle repair loop, end to end', () => {
  const policy = { ci: { mode: 'required' as const }, autoRerunInfrastructureFailures: true, maxInfrastructureReruns: 2, ciWaitMinutes: 90 }
  const LATER = '2026-09-24T01:00:00.000Z'
  it('goes from a CI failure through a Run-root repair and a new hand-over', async () => {
    let state: OrchState = {
      ...emptyState(),
      jobs: [{ id: 'job_1', objective: 'o', cwd: '/p', createdAt: NOW, github: policy, convergence: {} }],
      runs: [{ id: 'run_1', jobId: 'job_1', ordinal: 1, createdAt: NOW, worktree: '/wt-run' }],
      tasks: [
        { id: 'tsk_a', runId: 'run_1', title: 'a', spec: 's', deps: [], status: 'completed', consecutiveFailures: 0, createdAt: NOW, updatedAt: NOW },
        {
          id: 'tsk_l', runId: 'run_1', kind: 'lifecycle', title: 'GitHub 전달', spec: 's', deps: ['tsk_a'], status: 'validating', validateConfigIds: ['github:ci'],
          reviewRequested: true, consecutiveFailures: 0, createdAt: NOW, updatedAt: NOW, convergenceStartedAt: NOW, ciWait: { since: NOW, done: [] }
        }
      ],
      dispatches: [{
        id: 'dsp_a', taskId: 'tsk_a', provider: 'codex', accountId: 'accX', sessionId: 'sessA', cwd: '/wt/a', specPath: '/s/a.md',
        startedAt: NOW, endedAt: NOW, outcome: 'succeeded', workerState: 'ready', retained: false
      }]
    }
    const begun: unknown[] = []
    const startRepair = vi.fn(async (_a: { dispatchId: string }) => undefined as unknown)
    const v = createTaskValidation({
      getState: () => state,
      setState: async (next) => { state = next },
      now: () => NOW,
      lang: () => 'en',
      log: () => {},
      assertAllowedPath: async (p) => p,
      storedConfigs: () => [],
      runs: { start: () => ({ runId: 'r1' }), recentOutput: () => '', stop: () => {} },
      isAlive: () => false,
      startReview: async () => {},
      startRepair,
      firstCheckpointHead: () => null,
      diffNames: async () => null,
      pluginCheck: async (plugin) => ({ name: plugin, status: 'passed', summary: 'passed' }),
      lifecycleCiBegin: async (a) => (begun.push(a), { status: 200, body: {} })
    })
    const lifecycle = () => state.tasks.find((t) => t.id === 'tsk_l')!

    await v.settleHandedOff({ taskId: 'tsk_l', since: NOW, ciClass: 'test', result: { configId: 'github:ci', name: 'GitHub CI', status: 'failed', summary: 'test (test): not ok 1' } })
    const repair = state.dispatches.find((d) => d.taskId === 'tsk_l' && d.repair)!
    expect(repair).toMatchObject({ cwd: '/wt-run', provider: 'codex', accountId: 'accX', repair: 'check-failure' })
    expect(lifecycle().status).toBe('dispatched')
    await vi.waitFor(() => expect(startRepair).toHaveBeenCalledWith({ dispatchId: repair.id }))

    // The repair worker reports done; the round starts again where it worked, the Run root
    state = { ...state, dispatches: state.dispatches.map((d) => (d.id === repair.id ? { ...d, sessionId: 'sessFix', specPath: '/s/fix.md' } : d)) }
    const done = applyWorkerDone(state, { taskId: 'tsk_l', dispatchId: repair.id, outcome: 'succeeded', subject: 's', body: 'fixed' }, LATER)
    if (!done.ok) throw new Error(done.error)
    state = done.state
    expect(lifecycle().status).toBe('validating')
    v.startValidation({ taskId: 'tsk_l', cwd: repair.cwd })
    await vi.waitFor(() => expect(begun).toEqual([{ taskId: 'tsk_l', done: [] }]))
  })
})

// G3a final review I1 and M1: a round whose Task already handed one over, or left validating, is not run or handed again
describe('createTaskValidation — a lifecycle round that is no longer needed', () => {
  const policy = { ci: { mode: 'required' as const }, autoRerunInfrastructureFailures: true, maxInfrastructureReruns: 2, ciWaitMinutes: 90 }
  const lifecycle = (over: Record<string, unknown>): OrchState => ({
    ...emptyState(),
    jobs: [{ id: 'job_1', objective: 'o', cwd: '/p', createdAt: NOW, github: policy, convergence: {} }],
    runs: [{ id: 'run_1', jobId: 'job_1', ordinal: 1, createdAt: NOW, worktree: '/wt-run' }],
    tasks: [
      { id: 'tsk_a', runId: 'run_1', title: 'a', spec: 's', deps: [], status: 'completed', consecutiveFailures: 0, createdAt: NOW, updatedAt: NOW },
      {
        id: 'tsk_l', runId: 'run_1', kind: 'lifecycle', title: 'GitHub 전달', spec: 's', deps: ['tsk_a'], status: 'validating', validateConfigIds: ['lint', 'github:ci'],
        reviewRequested: true, consecutiveFailures: 0, createdAt: NOW, updatedAt: NOW, convergenceStartedAt: NOW, ...over
      }
    ]
  })
  const wired = (start: OrchState) => {
    let state = start
    const begun: unknown[] = []
    const started: unknown[] = []
    const validation = createTaskValidation({
      getState: () => state,
      setState: async (next) => { state = next },
      now: () => NOW,
      lang: () => 'en',
      log: () => {},
      assertAllowedPath: async (p) => p,
      storedConfigs: () => [],
      runs: { start: (o) => (started.push(o), { runId: 'r1' }), recentOutput: () => '', stop: () => {} },
      isAlive: () => true,
      startReview: async () => {},
      startRepair: async () => undefined,
      firstCheckpointHead: () => null,
      diffNames: async () => null,
      pluginCheck: async (plugin) => ({ name: plugin, status: 'passed', summary: 'passed' }),
      lifecycleCiBegin: async (a) => (begun.push(a), { status: 200, body: {} })
    })
    return { validation, begun, started, state: () => state }
  }

  it('runs no check again for a round already handed over', async () => {
    const w = wired(lifecycle({ ciWait: { since: NOW, done: [] } }))
    w.validation.validator.enqueue({ taskId: 'tsk_l', cwd: '/wt-run', configIds: ['lint', 'github:ci'] })
    await new Promise((r) => setTimeout(r, 20))
    expect(w.started).toEqual([])
    expect(w.begun).toEqual([])
    expect(w.state().gates).toEqual([])
  })

  it('hands nothing over for a Task that left validating, and asks nobody', async () => {
    const w = wired(lifecycle({ status: 'ready' }))
    w.validation.validator.enqueue({ taskId: 'tsk_l', cwd: '/wt-run', configIds: ['github:ci'] })
    await new Promise((r) => setTimeout(r, 20))
    expect(w.begun).toEqual([])
    expect(w.state().gates).toEqual([])
    expect(w.validation.validator.holds('tsk_l')).toBe(false)
  })
})

// Task K: the checks of a Task whose workers ran sandboxed run inside the same kind of sandbox, under the worker's CLI and
// account (the wiring builds the launch from the session manager's own builders); every check starts from the environment
// the Credentials list's hiding leaves (Q5); a sandbox that cannot be put around a check is a question to a person, never a
// silent run outside it nor the code's failure (E5); a Docker check of a sandboxed Task is refused (Q4); and Claude Code
// on Windows, which has no sandbox, runs its checks as today and says so (Q1).
describe('createTaskValidation — the sandbox of a sandboxed Task (Task K)', () => {
  const hidden = (cwd: string): NodeJS.ProcessEnv => ({ PATH: '/bin', HIDDEN_FOR: cwd })

  it('starts the check of a sandboxed attempt in its sandbox, as its CLI and account, from the hidden environment', async () => {
    const asked: Parameters<NonNullable<ValidationContext['sandboxedCheck']>>[0][] = []
    const h = rig({
      sandboxKind: 'sandbox',
      provider: 'codex',
      checkEnv: hidden,
      sandboxedCheck: async (a) => (asked.push(a), { launch: { file: 'codex', args: ['sandbox', '--', 'sh', '-c', a.command] }, env: { ...a.env, BOXED: '1' } })
    })
    h.validation.startValidation({ taskId: h.taskId, cwd: h.cwd })
    const opts = await h.started()
    expect(asked).toEqual([{ provider: 'codex', accountId: 'accA', cwd: h.cwd, command: opts.command, env: hidden(h.cwd) }])
    expect(opts.launch).toEqual({ file: 'codex', args: ['sandbox', '--', 'sh', '-c', opts.command] })
    expect(opts.env).toEqual({ ...hidden(h.cwd), BOXED: '1' })
    expect(opts.validation).toBe(true)
    await h.finish(0)
    expect(h.task().status).toBe('completed')
    expect(h.task().checks?.[0]).not.toHaveProperty('outsideSandbox')
  })

  it('a sandbox that cannot be put around the check asks a person and runs nothing (E5)', async () => {
    const why = 'the Windows sandbox of account accA is not set up'
    const answers: NonNullable<ValidationContext['sandboxedCheck']>[] = [async () => ({ unavailable: why }), async () => Promise.reject(new Error(why))]
    for (const sandboxedCheck of answers) {
      const h = rig({ sandboxKind: 'sandbox', provider: 'codex', checkEnv: hidden, sandboxedCheck })
      h.validation.startValidation({ taskId: h.taskId, cwd: h.cwd })
      await vi.waitFor(() => expect(h.task().status).toBe('blocked'))
      expect(h.runsStarted()).toBe(0)
      const gate = h.state().gates.find((g) => g.taskId === h.taskId && g.status === 'open')
      expect(gate?.kind).toBe('check-unavailable')
      expect(gate?.question).toContain(why)
      expect(h.task().checks?.[0]).toMatchObject({ status: 'error', summary: why })
    }
  })

  it("a sandbox refusal reads in the app's words, and points the person at the setup", async () => {
    const h = rig({ sandboxKind: 'sandbox', provider: 'codex', sandboxedCheck: async () => Promise.reject(new Error('SANDBOX_UNAVAILABLE: windows-setup codex accA')) })
    h.validation.startValidation({ taskId: h.taskId, cwd: h.cwd })
    await vi.waitFor(() => expect(h.task().status).toBe('blocked'))
    expect(h.task().checks?.[0]?.summary).toBe("This Codex account has no Windows sandbox set up yet. Set up shows Windows' administrator prompt once. Codex records the elevated sandbox as this account's default.")
  })

  it('a process that cannot put checks in a sandbox does not run a sandboxed Task check outside it', async () => {
    const h = rig({ sandboxKind: 'sandbox', provider: 'codex' })
    h.validation.startValidation({ taskId: h.taskId, cwd: h.cwd })
    await vi.waitFor(() => expect(h.task().status).toBe('blocked'))
    expect(h.runsStarted()).toBe(0)
    expect(h.task().checks?.[0]?.status).toBe('error')
  })

  it('refuses a Docker check of a sandboxed Task with a plain reason (Q4)', async () => {
    const docker = [
      { id: 'up', name: 'compose up', type: 'compose', action: 'up' },
      { id: 'img', name: 'image', type: 'dockerfile', imageTag: 'x' }
    ] as unknown as RunConfig[]
    for (const id of ['up', 'img']) {
      const sandboxedCheck = vi.fn(async () => ({ launch: { file: 'codex', args: [] as string[] }, env: {} }))
      const h = rig({ sandboxKind: 'sandbox', provider: 'codex', stored: docker, checks: [id], sandboxedCheck })
      h.validation.startValidation({ taskId: h.taskId, cwd: h.cwd })
      await vi.waitFor(() => expect(h.task().status).toBe('blocked'))
      expect(h.runsStarted()).toBe(0)
      expect(sandboxedCheck).not.toHaveBeenCalled()
      expect(h.task().checks?.[0]?.summary).toMatch(/Docker/)
    }
    // An unsandboxed Task runs it as before
    const plain = rig({ stored: docker, checks: ['up'] })
    plain.validation.startValidation({ taskId: plain.taskId, cwd: plain.cwd })
    expect((await plain.started()).command).toContain('docker compose')
    await plain.finish(0)
  })

  it('Claude Code on Windows: runs the check as today, from the hidden environment, and says it ran outside the sandbox (Q1)', async () => {
    const sandboxedCheck = vi.fn(async () => ({ unavailable: 'never asked' }))
    const h = rig({ sandboxKind: 'deny-only', checkEnv: hidden, sandboxedCheck })
    h.validation.startValidation({ taskId: h.taskId, cwd: h.cwd })
    const opts = await h.started()
    expect(opts.launch).toBeUndefined()
    expect(opts.env).toEqual(hidden(h.cwd))
    await h.finish(0)
    expect(sandboxedCheck).not.toHaveBeenCalled()
    expect(h.task().status).toBe('completed')
    expect(h.task().checks?.[0]).toMatchObject({ status: 'passed', outsideSandbox: true })
  })

  it('an unsandboxed Task check starts from the hidden environment too (Q5), and is not marked', async () => {
    const h = rig({ checkEnv: hidden })
    h.validation.startValidation({ taskId: h.taskId, cwd: h.cwd })
    const opts = await h.started()
    expect(opts.launch).toBeUndefined()
    expect(opts.env).toEqual(hidden(h.cwd))
    await h.finish(0)
    expect(h.task().checks?.[0]).not.toHaveProperty('outsideSandbox')
  })
})
