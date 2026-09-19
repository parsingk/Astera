// 완료 수렴 루프의 통합 테스트(명세 §51 A–E) — server.ts(handleCommand)·validator.ts(TaskValidator)·
// repair.ts(performRepair/repairOnce)·state.ts(applyValidationResult/openReviewDispatch/rekeyDispatch)·
// store.ts(OrchestrationStore) 를 실제로 이어서 돈다. 가짜는 딱 세 자리뿐이다 — 세션 생존 여부
// (`alive`), check 러너(`runner`), 그리고 워커를 실제로 띄우는 `startWorker` — 그 나머지는 전부
// production 코드 그대로다.
//
// **rig() 는 src/main/ipc.ts 의 실제 배선(bootOrch)을 그대로 흉내 낸다** — task-14-brief.md 의 초안이
// 아니라, 그 초안이 쓰인 뒤 아홉 개의 Task 가 인터페이스를 바꾼 지금의 ipc.ts 를 읽고 다시 짰다:
//   - onSettled: repairTargetFor → applyValidationResult → **커밋** → (reviewing 이면 startReview,
//     아니면 새 repair Dispatch 를 찾아 performRepair) — 커밋이 부수 효과보다 먼저다(ipc.ts 2516행 대).
//   - startReview: 검토 Dispatch 를 **커밋한 뒤에만** startWorker 를 부르고, 그 뒤에 sessionId·cwd·
//     specPath 를 되읽어 patch 한다(ipc.ts 의 startReview, 2576행 대) — performRepair 와 같은 규율.
//   - readReviewFile: 완성된 경로(`${specPath}.review.json`)를 받는다. suffix 를 붙이는 자리는
//     server.ts 의 send worker_done(검토 분기) 하나뿐이다 — 여기서 또 붙이면 조용히 죽는다.
//   - startWorker: ipc.ts 의 진짜 래퍼가 하는 일 중 이 테스트가 붙잡는 하나 — Task.accountIds 에서
//     rollAccountIds(그 워커의 롤링 체인)를 계산해 붙인다(ipc.ts ~3815행대, core/accounts의
//     rollChainFor). 검토 Dispatch 는 구현자와 다른 provider 이므로 이 계산을 건너뛰고 요청된 계정
//     하나로 저하한다 — ipc.ts 의 그 가드 그대로.
//   - store.load 가 낸 revalidate·rereview 목록은 이 배선이 스스로 소비한다(부팅 로직은 ipc.ts
//     ~4325행대에 있고 store.load 자신은 아무것도 시작하지 않는다).
import { describe, it, expect, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { handleCommand, type OrchServerDeps } from './server'
import { TaskValidator, type ValidatorRunner } from './validator'
import { performRepair, repairOnce, repairTargetFor, type RepairDeps } from './repair'
import { OrchestrationStore } from './store'
import {
  applyValidationResult,
  blockForValidation,
  emptyState,
  openReviewDispatch,
  rekeyDispatch,
  type OrchState
} from '../../core/orchestration/state'
import { policyOf } from '../../core/orchestration/convergence'
import { rollChainFor } from '../../core/accounts/dispatchAccount'
import type { Account } from '../../core/types'
import type { Provider } from '../../core/providers/meta'

// 세 계정, 두 provider. accA·accA2 는 구현자의 롤링 체인(계정을 갈아탈 순서, property 4) 이고,
// accC 는 유일한 codex 계정이라 검토자로 뽑힌다 — ipc.ts 의 startReview 가 구현자와 다른 provider
// 에서만 검토자를 고르는 것과 같은 모양이다.
const fullAccounts: Account[] = [
  { id: 'accA', label: 'A', provider: 'claude', configDir: 'C:/accA', color: '#111111', createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'accA2', label: 'A2', provider: 'claude', configDir: 'C:/accA2', color: '#222222', createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'accC', label: 'C', provider: 'codex', configDir: 'C:/accC', color: '#333333', createdAt: '2026-01-01T00:00:00.000Z' }
]
const accounts: { id: string; label: string; provider: Provider }[] = fullAccounts.map((a) => ({
  id: a.id,
  label: a.label,
  provider: a.provider as Provider
}))
const loggedInIds = new Set(fullAccounts.map((a) => a.id))

/** ipc.ts 의 실제 배선과 같은 모양의 가짜 한 벌. 세션 생존 여부는 `alive` 로 테스트가 조종한다. */
function rig(initial: OrchState = emptyState()) {
  const box = { state: initial }
  const alive = new Set<string>()
  let seq = 0

  // 모든 커밋이 지나는 한 자리 — property 1(커밋이 부수 효과보다 먼저다)을 순서로 확인하는 데 쓴다.
  const commits: OrchState[] = []
  const setState = async (n: OrchState): Promise<void> => {
    box.state = n
    commits.push(n)
  }

  const started: Array<
    Parameters<OrchServerDeps['startWorker']>[0] & { rollAccountIds: string[]; commitsAtCall: number }
  > = []
  const reviewFiles = new Map<string, string>()
  const readReviewFileCalls: string[] = []
  const suspiciousFilesFor = new Map<string, string[]>()

  // ipc.ts 의 startWorker 래퍼(~3815행대) — 워커를 띄우는 모든 길(worker-start, repair 의 같은
  // 세션 재사용·새 워커, 검토 Dispatch)이 이 한 곳을 지나고, 여기서 Task.accountIds 로부터
  // rollAccountIds 를 계산해 붙인다(property 4). 띄우려는 provider 가 이 Task 의 provider 와
  // 다르면(검토 Dispatch) 그 계산을 건너뛰고 요청된 계정 하나로 저하한다 — ipc.ts 의 그 가드 그대로.
  const startWorker: OrchServerDeps['startWorker'] = async (a) => {
    const task = box.state.tasks.find((t) => t.id === a.taskId)
    const taskAccountIds = task?.accountIds
    const taskProvider = taskAccountIds?.length
      ? fullAccounts.find((x) => x.id === taskAccountIds[0])?.provider
      : undefined
    const rollAccountIds =
      taskAccountIds?.length && (taskProvider === undefined || taskProvider === a.provider)
        ? rollChainFor({
            requested: a.accountId,
            taskAccountIds,
            provider: a.provider,
            accounts: fullAccounts,
            loggedInIds
          }).chain
        : [a.accountId]
    started.push({ ...a, rollAccountIds, commitsAtCall: commits.length })
    const specPath = `C:/specs/${a.taskId}-${a.dispatchId}.md`
    if (a.terminal) return { sessionId: a.terminal, cwd: a.terminalCwd!, specPath }
    const sessionId = `sess-${++seq}`
    alive.add(sessionId)
    return { sessionId, cwd: 'D:/wt', specPath }
  }

  // repair.ts 가 그대로 받는 의존 묶음 — performRepair/repairOnce 는 production 코드다.
  const repairDeps: RepairDeps = {
    getState: () => box.state,
    setState,
    startWorker,
    isAlive: (id) => alive.has(id),
    knowledge: async () => undefined,
    lang: () => 'en',
    log: () => {},
    now: () => new Date().toISOString()
  }

  // ipc.ts 의 startReview(~2576행대) — 검토 Dispatch 를 **커밋한 뒤에만** startWorker 를 부르고,
  // 그 뒤에 sessionId·cwd·specPath 를 되읽어 patch 한다. performRepair 와 같은 규율(property 1).
  const startReview = async ({ taskId }: { taskId: string }): Promise<void> => {
    const task = box.state.tasks.find((t) => t.id === taskId)
    if (task?.status !== 'reviewing') return
    const impl = box.state.dispatches
      .filter((d) => d.taskId === taskId && !d.review)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .at(-1)
    if (!impl) return
    const picked = accounts.find((a) => a.provider !== impl.provider)
    if (!picked) return
    const opened = openReviewDispatch(
      box.state,
      {
        taskId,
        provider: picked.provider,
        accountId: picked.id,
        sessionId: `pending:rev-${++seq}`,
        cwd: impl.cwd,
        specPath: ''
      },
      new Date().toISOString()
    )
    if (!opened.ok) return
    await setState(opened.state)
    let result: { sessionId: string; cwd: string; specPath: string }
    try {
      result = await startWorker({
        dispatchId: opened.value.id,
        taskId,
        title: `Review: ${task.title}`,
        spec: task.spec,
        specFileContent: 'REVIEW SPEC',
        provider: picked.provider,
        accountId: picked.id,
        runCwd: impl.cwd,
        worktree: 'current'
      })
    } catch {
      return
    }
    const latest = box.state
    await setState({
      ...latest,
      dispatches: latest.dispatches.map((d) =>
        d.id === opened.value.id
          ? { ...d, sessionId: result.sessionId, cwd: result.cwd, specPath: result.specPath }
          : d
      )
    })
  }

  const runnerCalls: { configId: string; runId: string; taskId: string }[] = []
  const exits = new Map<string, number>() // configId -> exit code the test wants
  const runner: ValidatorRunner = {
    start: async ({ configId, taskId }) => {
      const task = box.state.tasks.find((t) => t.id === taskId)
      if (task?.status !== 'validating') return 'skip'
      const runId = `run-${runnerCalls.length + 1}`
      runnerCalls.push({ configId, runId, taskId })
      return { runId, name: configId.toUpperCase() }
    },
    output: () => 'tail',
    stop: () => {}
  }

  let validator!: TaskValidator
  const deps: OrchServerDeps = {
    getState: () => box.state,
    setState,
    startWorker,
    releaseWorker: async () => {},
    listAccounts: (provider) => (provider ? accounts.filter((a) => a.provider === provider) : accounts),
    readWorker: async () => '',
    enabled: () => true,
    startValidation: ({ taskId, cwd }) => {
      const task = box.state.tasks.find((t) => t.id === taskId)
      validator.enqueue({ taskId, cwd, configIds: task?.validateConfigIds ?? [] })
      // ipc.ts 는 convergence Run 에서만 suspiciousFiles 를 계산한다(policyOf === null 이면
      // 건너뛴다) — 진짜 계산은 git diff 를 훑지만(changedFilesSince), 이 가짜는 그 결과를
      // suspiciousFilesFor 로 대신하고 **같은 가드**를 지킨다. property 5 가 확인하는 것이 그 가드다.
      if (!task || policyOf(box.state, task) === null) return
      const suspicious = suspiciousFilesFor.get(taskId)
      if (!suspicious?.length) return
      void setState({
        ...box.state,
        tasks: box.state.tasks.map((t) => (t.id === taskId ? { ...t, suspiciousFiles: suspicious } : t))
      })
    },
    startReview: ({ taskId }) => {
      void startReview({ taskId }).catch(() => {})
    },
    readReviewFile: async (p) => {
      readReviewFileCalls.push(p)
      return reviewFiles.get(p) ?? null
    },
    repairTargetFor: (taskId) => repairTargetFor(box.state, taskId, (id) => alive.has(id)),
    startRepair: ({ dispatchId }) => void performRepair(repairDeps, { dispatchId }).catch(() => {}),
    // ipc.ts 는 repairOnce 자신의 Promise 를 그대로 돌려준다 — gate-resolve 가 그것을 기다려
    // "Dispatch 가 이미 커밋됐다"까지만 기다린다(repair.ts 의 repairOnce 주석). void 로 끊으면 그
    // await 가 곧바로 풀려 커밋 전에 응답이 나간다.
    repairOnce: ({ taskId }) => repairOnce(repairDeps, { taskId }),
    lang: () => 'en'
  } as OrchServerDeps

  // ipc.ts 의 validator(2457행대) — onSettled 는 repairTargetFor → applyValidationResult → 커밋 →
  // (reviewing 이면 startReview, 아니면 새 repair Dispatch 를 찾아 performRepair) 순서다. 커밋이
  // 부수 효과보다 먼저인 것이 property 1 이다.
  validator = new TaskValidator({
    runner,
    onSettled: async ({ taskId, results }) => {
      const before = box.state
      const repair = repairTargetFor(before, taskId, (id) => alive.has(id))
      const r = applyValidationResult(
        before,
        { taskId, results, canReview: true, ...(repair ? { repair } : {}), lang: 'en' },
        new Date().toISOString()
      )
      if (!r.ok) throw new Error(r.error)
      await setState(r.state)
      if (r.value.status === 'reviewing') void startReview({ taskId }).catch(() => {})
      const opened = box.state.dispatches.find(
        (d) => d.taskId === taskId && d.repair !== undefined && !d.endedAt && !d.specPath
      )
      if (opened) void performRepair(repairDeps, { dispatchId: opened.id }).catch(() => {})
    },
    onCannotRun: async ({ taskId, reason }) => {
      const r = blockForValidation(box.state, { taskId, reason }, new Date().toISOString())
      if (r.ok) await setState(r.state)
    }
  })

  const call = (cmd: string, args: Record<string, unknown> = {}, sessionId = 'coordinator') =>
    handleCommand(deps, { sessionId }, cmd, args)

  // 큐에 들어간 check 들을 순서대로 끝낸다 — exits 에 적힌 코드로, 없으면 0. 러너의 start 는
  // 비동기이므로(validator.ts 의 startCheck), 다음 호출이 나타나기를 vi.waitFor 로 기다린다 —
  // 아무것도 나타나지 않으면(그 라운드가 repair 를 열지 않고 다른 상태로 끝났다는 뜻) 그대로 끝낸다.
  //
  // **onRunExit 을 호출한 자리와 validator.ts 가 그 head 의 runId 를 실제로 적어 두는 자리 사이에는
  // 정확히 한 microtask 틱이 있다**(startCheck 의 `await this.deps.runner.start(...)` — 이미 풀린
  // Promise 라도 await 는 항상 한 틱을 쉰다). runnerCalls 에 새 항목이 보이는 시점과 그 틱이 지나는
  // 시점이 갈리므로, 보이는 즉시 한 번만 부르면 이 exit 를 못 찾은 채(headFor 가 아직 옛 runId 를
  // 보는 채) 조용한 no-op 이 된다 — 그래서 그 효과(다음 check 가 뜨거나 이 Task 가 validating 을
  // 떠남)가 보일 때까지 **다시 부르는 것 자체를 재시도**한다: onRunExit 은 자기 head 가 아닌 exit 에
  // 아무 일도 하지 않으므로(멱등) 이르게 걸린 재시도는 무해하다.
  let handled = 0
  const drainChecks = async (): Promise<void> => {
    for (;;) {
      if (handled >= runnerCalls.length) {
        const before = runnerCalls.length
        try {
          await vi.waitFor(() => expect(runnerCalls.length).toBeGreaterThan(before), { timeout: 200, interval: 5 })
        } catch {
          return
        }
      }
      const c = runnerCalls[handled]
      handled += 1
      const beforeLen = runnerCalls.length
      try {
        await vi.waitFor(
          () => {
            validator.onRunExit({ runId: c.runId, exitCode: exits.get(c.configId) ?? 0 })
            const task = box.state.tasks.find((t) => t.id === c.taskId)
            expect(runnerCalls.length > beforeLen || task?.status !== 'validating').toBe(true)
          },
          { timeout: 200, interval: 5 }
        )
      } catch {
        return
      }
    }
  }

  const setup = async (
    opts: { validate?: string; review?: boolean; account?: string; run?: Record<string, unknown> } = {}
  ) => {
    await call('run-create', { objective: 'o', cwd: 'D:/p', convergence: true, ...(opts.run ?? {}) })
    await call('task-create', {
      spec: 'do auth',
      account: opts.account ?? 'accA,accA2',
      ...(opts.validate ? { validate: opts.validate } : {}),
      ...(opts.review ? { review: true } : {})
    })
    const taskId = box.state.tasks[0].id
    const ws = await call('worker-start', { task: taskId, agent: 'claude', account: 'accA', worktree: 'D:/wt' })
    const dispatchId = (ws.body as { dispatchId: string }).dispatchId
    return { taskId, dispatchId, sessionId: box.state.dispatches[0].sessionId }
  }

  const done = (
    taskId: string,
    dispatchId: string,
    sessionId: string,
    outcome: 'succeeded' | 'failed' = 'succeeded'
  ) => call('send', { type: 'worker_done', taskId, dispatchId, outcome, subject: 's', body: 'b' }, sessionId)

  /** performRepair 의 부수 효과(spec 파일·세션)가 끝나기를 기다린 뒤 그 repair Dispatch 를 낸다 —
   *  fresh 워커일 때 sessionId 가 placeholder 에서 진짜 값으로 바뀌는 지점이 바로 그 부수 효과다. */
  const awaitOpenRepair = async (taskId: string) => {
    await vi.waitFor(() =>
      expect(
        box.state.dispatches.some((d) => d.taskId === taskId && d.repair && !d.endedAt && d.specPath !== '')
      ).toBe(true)
    )
    return box.state.dispatches.find((d) => d.taskId === taskId && d.repair && !d.endedAt && d.specPath !== '')!
  }
  const awaitOpenReview = async (taskId: string) => {
    await vi.waitFor(() =>
      expect(
        box.state.dispatches.some((d) => d.taskId === taskId && d.review && !d.endedAt && d.specPath !== '')
      ).toBe(true)
    )
    return box.state.dispatches.find((d) => d.taskId === taskId && d.review && !d.endedAt && d.specPath !== '')!
  }

  return {
    box,
    alive,
    started,
    commits,
    exits,
    reviewFiles,
    readReviewFileCalls,
    suspiciousFilesFor,
    deps,
    call,
    setup,
    done,
    drainChecks,
    validator,
    runnerCalls,
    awaitOpenRepair,
    awaitOpenReview
  }
}

describe('convergence — §51', () => {
  it('A: a failing check repairs the same worker; once fixed, checks re-run, the reviewer approves, and the Task completes', async () => {
    const r = rig()
    const { taskId, dispatchId, sessionId } = await r.setup({ validate: 'typecheck,tests', review: true })
    r.suspiciousFilesFor.set(taskId, ['package.json'])
    r.exits.set('tests', 1)
    await r.done(taskId, dispatchId, sessionId)
    expect(r.box.state.tasks[0].status).toBe('validating')
    // property 5 (positive half): a convergence Run's suspiciousFiles is written when the wiring has
    // something to flag — the regression test below is the negative half (never written).
    expect(r.box.state.tasks[0].suspiciousFiles).toEqual(['package.json'])
    await r.drainChecks()

    // round 1: typecheck passes, tests fails -> repair goes to the same session
    const task1 = r.box.state.tasks[0]
    expect(task1.status).toBe('dispatched')
    expect(task1.checks?.map((c) => c.status)).toEqual(['passed', 'failed'])
    const repair = await r.awaitOpenRepair(taskId)
    expect(repair.sessionId).toBe(sessionId)
    expect(repair.accountId).toBe('accA')
    const repairCall = r.started.find((s) => s.dispatchId === repair.id)!
    expect(repairCall.terminal).toBe(sessionId)
    expect(repairCall.specFileContent).toContain('## Repair request')
    // property 4: the repair worker carries the Task's full rolling chain, not just the account it
    // happens to be dispatched on right now — this is what lets scenario C's mid-repair roll switch
    // accounts without opening a second repair.
    expect(repairCall.rollAccountIds).toEqual(['accA', 'accA2'])
    // property 1: the repair Dispatch's commit (opened, specPath still '') happened strictly before
    // the side effect that starts a worker for it.
    const openedAt = r.commits.findIndex((s) => s.dispatches.some((d) => d.id === repair.id && d.specPath === ''))
    expect(openedAt).toBeGreaterThanOrEqual(0)
    expect(repairCall.commitsAtCall).toBeGreaterThan(openedAt)

    // the worker fixes it and reports again
    r.exits.delete('tests')
    await r.done(taskId, repair.id, sessionId)
    expect(r.box.state.tasks[0].status).toBe('validating')
    await r.drainChecks()
    expect(r.box.state.tasks[0].status).toBe('reviewing')
    const review = await r.awaitOpenReview(taskId)
    r.reviewFiles.set(`${review.specPath}.review.json`, '{"issues":[]}')
    await r.call(
      'send',
      { type: 'worker_done', taskId, dispatchId: review.id, outcome: 'succeeded', subject: 'ok', body: 'fine' },
      review.sessionId
    )
    expect(r.box.state.tasks[0].status).toBe('completed')
    expect(r.box.state.tasks[0].consecutiveFailures).toBe(0)
    // two check rounds (2 checks each), one repair only
    expect(r.runnerCalls.map((c) => c.configId)).toEqual(['typecheck', 'tests', 'typecheck', 'tests'])
    expect(r.box.state.dispatches.filter((d) => d.repair)).toHaveLength(1)
    // property 2: the `.review.json` suffix was appended exactly once, end to end.
    expect(r.readReviewFileCalls).toEqual([`${review.specPath}.review.json`])
  })

  it('B: a blocking review issue repairs the worker, and the checks re-run before the reviewer sees it again', async () => {
    const r = rig()
    const { taskId, dispatchId, sessionId } = await r.setup({ validate: 'tests', review: true })
    await r.done(taskId, dispatchId, sessionId)
    await r.drainChecks()
    expect(r.box.state.tasks[0].status).toBe('reviewing')
    const review1 = await r.awaitOpenReview(taskId)
    r.reviewFiles.set(
      `${review1.specPath}.review.json`,
      '{"issues":[{"severity":"high","title":"race","file":"a.ts","line":1}]}'
    )
    await r.call(
      'send',
      { type: 'worker_done', taskId, dispatchId: review1.id, outcome: 'failed', subject: 'race', body: 'b' },
      review1.sessionId
    )
    const repair = await r.awaitOpenRepair(taskId)
    expect(repair.repair).toBe('review-failure')
    expect(repair.sessionId).toBe(sessionId)
    const repairCall = r.started.find((s) => s.dispatchId === repair.id)!
    expect(repairCall.specFileContent).toContain('HIGH — race')

    await r.done(taskId, repair.id, sessionId)
    // the checks run again before the reviewer does — a repaired change is never reviewed unchecked
    expect(r.box.state.tasks[0].status).toBe('validating')
    await r.drainChecks()
    expect(r.box.state.tasks[0].status).toBe('reviewing')
    const review2 = await r.awaitOpenReview(taskId)
    expect(review2.id).not.toBe(review1.id)
    expect(review2.specPath).not.toBe(review1.specPath)
    r.reviewFiles.set(`${review2.specPath}.review.json`, '{"issues":[{"severity":"low","title":"nit"}]}')
    await r.call(
      'send',
      { type: 'worker_done', taskId, dispatchId: review2.id, outcome: 'succeeded', subject: 'ok', body: 'b' },
      review2.sessionId
    )
    expect(r.box.state.tasks[0].status).toBe('completed')
    expect(r.box.state.tasks[0].reviewIssues?.[0].blocking).toBe(false)
    // property 2 again, across two separate review rounds: each specPath was read with the suffix
    // appended exactly once — never `.review.json.review.json`.
    expect(r.readReviewFileCalls).toEqual([`${review1.specPath}.review.json`, `${review2.specPath}.review.json`])
  })

  it('C: a usage limit rolls the open repair Dispatch to a new session and account; the same attempt finishes passing', async () => {
    const r = rig()
    const { taskId, dispatchId, sessionId } = await r.setup({ validate: 'tests' })
    r.exits.set('tests', 1)
    await r.done(taskId, dispatchId, sessionId)
    await r.drainChecks()
    const repair = await r.awaitOpenRepair(taskId)
    expect(repair.accountId).toBe('accA')

    // what a roll does: the open Dispatch moves to a new session and the next account in the chain
    // (rollTap.ts's rekeyDispatch call, at the moment a limit lands mid-attempt).
    const rolled = rekeyDispatch(
      r.box.state,
      { oldSessionId: sessionId, newSessionId: 'sess-rolled', accountId: 'accA2' },
      new Date().toISOString()
    )
    if (!rolled.ok) throw new Error(rolled.error)
    r.box.state = rolled.state
    r.commits.push(rolled.state)
    r.alive.add('sess-rolled')
    // property 4 (mid-attempt half): it is still the same repair Dispatch — no second repair opened
    // for the roll, and the account actually changed.
    expect(r.box.state.dispatches.find((d) => d.repair)?.id).toBe(repair.id)
    expect(r.box.state.dispatches.find((d) => d.repair)?.accountId).toBe('accA2')

    r.exits.delete('tests')
    await r.done(taskId, repair.id, 'sess-rolled')
    await r.drainChecks()
    expect(r.box.state.tasks[0].status).toBe('completed')
    expect(r.box.state.dispatches.filter((d) => d.repair)).toHaveLength(1)
  })

  it('D: an app crash mid-check restarts the same check at boot, with no duplicate repair', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-conv-'))
    try {
      const r = rig()
      const { taskId, dispatchId, sessionId } = await r.setup({ validate: 'tests' })
      await r.done(taskId, dispatchId, sessionId)
      expect(r.box.state.tasks[0].status).toBe('validating')
      // the app died: the state is left on disk and read back with a fresh store
      const file = path.join(dir, 'orchestration.json')
      await fs.writeFile(file, JSON.stringify(r.box.state))
      const store = new OrchestrationStore(file)
      const loaded = await store.load({ aliveSessionIds: new Set() })
      // property 3 (validation half): the crash-boot list names this Task and where to re-check it.
      expect(loaded.revalidate).toEqual([{ taskId, cwd: 'D:/wt' }])
      expect(store.get().gates).toHaveLength(0)
      expect(store.get().tasks[0].status).toBe('validating')

      // restart: the same wiring ipc.ts uses at boot consumes the list (deps.startValidation per entry)
      const r2 = rig(store.get())
      r2.exits.set('tests', 1)
      for (const rv of loaded.revalidate) r2.deps.startValidation?.({ taskId: rv.taskId, cwd: rv.cwd })
      await r2.drainChecks()
      const repair2 = await r2.awaitOpenRepair(taskId)
      expect(r2.box.state.dispatches.filter((d) => d.repair)).toHaveLength(1)
      // the old session died with the app, so this is a fresh worker
      expect(repair2.sessionId).toBe('sess-1')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('D2 (property 3, review half): an app crash mid-review restarts the review at boot, with no duplicate review', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-conv-rev-'))
    try {
      const r = rig()
      const { taskId, dispatchId, sessionId } = await r.setup({ review: true })
      await r.done(taskId, dispatchId, sessionId)
      expect(r.box.state.tasks[0].status).toBe('reviewing')
      const review1 = await r.awaitOpenReview(taskId)

      const file = path.join(dir, 'orchestration.json')
      await fs.writeFile(file, JSON.stringify(r.box.state))
      const store = new OrchestrationStore(file)
      const loaded = await store.load({ aliveSessionIds: new Set() })
      expect(loaded.rereview).toEqual([taskId])
      expect(store.get().gates).toHaveLength(0)
      expect(store.get().tasks[0].status).toBe('reviewing')
      // the crashed review Dispatch is written off (endedAt, no outcome) — not left open
      const writtenOff = store.get().dispatches.find((d) => d.id === review1.id)
      expect(writtenOff?.endedAt).toBeTruthy()
      expect(writtenOff?.outcome).toBeUndefined()

      const r2 = rig(store.get())
      for (const t of loaded.rereview) r2.deps.startReview?.({ taskId: t })
      const review2 = await r2.awaitOpenReview(taskId)
      expect(review2.id).not.toBe(review1.id)
      // exactly one live review Dispatch — the restart did not fire the review twice
      expect(r2.box.state.dispatches.filter((d) => d.review && !d.endedAt)).toHaveLength(1)
      r2.reviewFiles.set(`${review2.specPath}.review.json`, '{"issues":[]}')
      await r2.call(
        'send',
        { type: 'worker_done', taskId, dispatchId: review2.id, outcome: 'succeeded', subject: 'ok', body: 'b' },
        review2.sessionId
      )
      expect(r2.box.state.tasks[0].status).toBe('completed')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('E: a persisting failure exhausts the budget into a Gate; retry-once grants exactly one more repair, then a further failure gates again', async () => {
    const r = rig()
    const { taskId, dispatchId, sessionId } = await r.setup({ validate: 'tests', run: { maxFixAttempts: 2 } })
    r.exits.set('tests', 1)
    await r.done(taskId, dispatchId, sessionId)
    await r.drainChecks()
    let repair = await r.awaitOpenRepair(taskId)
    await r.done(taskId, repair.id, sessionId) // repair 1 reports -> re-check -> failure 2
    await r.drainChecks()
    repair = r.box.state.dispatches.filter((d) => d.repair).at(-1)!
    expect(r.box.state.dispatches.filter((d) => d.repair)).toHaveLength(2)
    await r.done(taskId, repair.id, sessionId) // repair 2 reports -> re-check -> failure 3 > 2 -> exhausted
    await r.drainChecks()
    const task = r.box.state.tasks[0]
    expect(task.status).toBe('blocked')
    const gate = r.box.state.gates.at(-1)!
    expect(gate.kind).toBe('convergence-exhausted')
    expect(gate.question).toContain('2 repair')
    expect(gate.question).toContain('TESTS')
    expect(r.box.state.dispatches.filter((d) => d.repair)).toHaveLength(2)
    expect(r.box.state.dispatches.every((d) => d.endedAt)).toBe(true)

    // a person grants one more
    await r.call('gate-resolve', { id: gate.id, resolution: 'retry-once' })
    await vi.waitFor(() => expect(r.box.state.dispatches.filter((d) => d.repair)).toHaveLength(3))
    expect(r.box.state.tasks[0].status).toBe('dispatched')

    // another failure -> gated again, with no automatic repeat
    repair = r.box.state.dispatches.filter((d) => d.repair).at(-1)!
    await r.done(taskId, repair.id, sessionId)
    await r.drainChecks()
    expect(r.box.state.tasks[0].status).toBe('blocked')
    expect(r.box.state.dispatches.filter((d) => d.repair)).toHaveLength(3)
  })

  it('regression: a Run without convergence still fails its Task and tells the coordinator --retry-of', async () => {
    const r = rig()
    await r.call('run-create', { objective: 'o', cwd: 'D:/p' })
    await r.call('task-create', { spec: 'do', account: 'accA', validate: 'tests' })
    const taskId = r.box.state.tasks[0].id
    // even if the wiring had a value ready to flag, this Run must never record it — see the
    // assertion below (property 5, negative half).
    r.suspiciousFilesFor.set(taskId, ['package.json'])
    const ws = await r.call('worker-start', { task: taskId, agent: 'claude', account: 'accA', worktree: 'D:/wt' })
    const dispatchId = (ws.body as { dispatchId: string }).dispatchId
    r.exits.set('tests', 1)
    await r.done(taskId, dispatchId, r.box.state.dispatches[0].sessionId)
    await r.drainChecks()
    expect(r.box.state.tasks[0].status).toBe('failed')
    expect(r.box.state.messages.at(-1)?.body).toContain('Retry with worker-start --retry-of')
    expect(r.box.state.dispatches.some((d) => d.repair)).toBe(false)
    // property 5: no convergence policy on this Run — suspiciousFiles is never written, because the
    // guard in startValidation (policyOf(...) === null) returns before it is ever reached, the same
    // guard ipc.ts's own startValidation uses.
    expect(r.box.state.tasks[0].suspiciousFiles).toBeUndefined()
    // and checks/checkHistory never grow either — this Run's file has to stay byte-for-byte what it
    // always was (state.ts's own compatibility rule for a non-convergence Run).
    expect(r.box.state.tasks[0].checks).toBeUndefined()
  })
})
