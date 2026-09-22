// 완료 수렴 루프의 통합 테스트(명세 §51 A–E) — server.ts(handleCommand)·validator.ts(TaskValidator)·
// repair.ts(performRepair/repairOnce)·state.ts(applyValidationResult/openReviewDispatch/rekeyDispatch)·
// store.ts(OrchestrationStore) 를 실제로 이어서 돈다. 가짜는 딱 세 자리뿐이다 — 세션 생존 여부
// (`alive`), check 러너(`runner`), 그리고 워커를 실제로 띄우는 `startWorker` — 그 나머지는 전부
// production 코드 그대로다.
//
// **rig() 는 src/main/ipc.ts 의 실제 배선(bootOrch)을 그대로 흉내 낸다** — task-14-brief.md 의 초안이
// 아니라, 그 초안이 쓰인 뒤 아홉 개의 Task 가 인터페이스를 바꾼 지금의 ipc.ts 를 읽고 다시 짰다:
//   - onSettled: repairTargetFor → applyValidationResult → **커밋** → (reviewing 이면 startReview,
//     아니면 새 repair Dispatch 를 찾아 performRepair) — 커밋이 부수 효과보다 먼저다(ipc.ts 의 onSettled).
//   - startReview: 검토 Dispatch 를 **커밋한 뒤에만** startWorker 를 부르고, 그 뒤에 sessionId·cwd·
//     specPath 를 되읽어 patch 한다(ipc.ts 의 startReview) — performRepair 와 같은 규율. spec 본문은
//     production 의 buildReviewSpecFile·specFileName 을 그대로 불러 쓴다(review.json 경로가 앞뒤로
//     일치하는지 확인하려면 손으로 흉내 낸 문자열이 아니라 진짜 조립기가 필요하다).
//   - readReviewFile: 완성된 경로(`${specPath}.review.json`)를 받는다. suffix 를 붙이는 자리는
//     server.ts 의 send worker_done(검토 분기) 하나뿐이다 — 여기서 또 붙이면 조용히 죽는다.
//   - startWorker: ipc.ts 의 진짜 래퍼가 하는 일 중 이 테스트가 붙잡는 하나 — Task.accountIds 에서
//     rollAccountIds(그 워커의 롤링 체인)를 계산해 붙인다(ipc.ts 의 startWorker 래퍼, core/accounts 의
//     rollChainFor). 검토 Dispatch 는 구현자와 다른 provider 이므로 이 계산을 건너뛰고 요청된 계정
//     하나로 저하한다 — ipc.ts 의 그 가드 그대로. **이 재구현이 ipc.ts 자신의 코드를 실행하는 것은
//     아니다** — 그 격차는 옆의 ipcConvergenceWiring.test.ts(텍스트 가드)가 메운다.
//   - store.load 가 낸 revalidate·rereview 목록은 이 배선이 스스로 소비한다(부팅 로직은 ipc.ts 에
//     있고 store.load 자신은 아무것도 시작하지 않는다).
//
// 실패를 조용히 삼키지 않는다 — TaskValidator 의 log 와 모든 fire-and-forget `.catch` 가 `logs` 배열에
// 적는다. 통과하는 시나리오라면 이 배열은 끝까지 비어 있어야 한다: 비어 있지 않다면 그 자체가 "이
// 흐름 어딘가에서 조용히 실패했다"는 신호이고, 그것을 나중에 알 수 없는 타임아웃으로 발견하는 대신
// 여기서 바로 보게 하려는 것이다.
import { describe, it, expect, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { handleCommand, type OrchServerDeps } from '../../core/orchestration/command'
import { TaskValidator, type ValidatorRunner } from './validator'
import { performRepair, repairOnce, repairTargetFor, type RepairDeps } from './repair'
import { OrchestrationStore } from './store'
import { buildReviewSpecFile, specFileName } from './coordinator'
import {
  applyValidationResult,
  blockForValidation,
  emptyState,
  openReviewDispatch,
  rekeyDispatch,
  type OrchState
} from '../../core/orchestration/state'
import { checkConfigIdsOf, policyOf } from '../../core/orchestration/convergence'
import { pickReviewer } from '../../core/orchestration/reviewer'
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
const SPECS_DIR = 'C:/specs'

/** ipc.ts 의 실제 배선과 같은 모양의 가짜 한 벌. 세션 생존 여부는 `alive` 로 테스트가 조종한다. */
function rig(initial: OrchState = emptyState()) {
  const box = { state: initial }
  const alive = new Set<string>()
  let sessionSeq = 0
  // 검토 자리표시자만의 카운터 — 세션 id 채번과 갈라 둔다. 두 카운터가 하나였으면 시나리오 D 가
  // "다음 세션은 sess-1 이다" 를 그 우연한 채번 순서에 기대야 했다(그 시나리오 자체가 확인하려는
  // 것은 "그것이 fresh 워커다" 이지 "몇 번째로 채번됐다" 가 아니다).
  let reviewSeq = 0
  // 조용히 삼킨 실패가 없는지 — 모든 fire-and-forget `.catch` 와 TaskValidator 의 log 가 여기 적는다.
  const logs: string[] = []

  // 모든 커밋이 지나는 한 자리 — property 1(커밋이 부수 효과보다 먼저다)을 순서로 확인하는 데 쓴다.
  const commits: OrchState[] = []
  // ipc.ts 의 진짜 setState 는 실제 디스크 쓰기(OrchestrationStore.save, libuv 스레드풀의 fs 콜백)를
  // 기다린다 — 완전히 동기인 가짜는 그 틈을 지운다. 틈이 없으면 Promise 를 돌려주는 훅을(fix-1
  // 라운드가 고친 바로 그 결함처럼) `void` 로 끊어도 같은 호출 안에서 이미 커밋돼 있어, 끊었는지
  // 기다렸는지를 어떤 동기 단언도 가르지 못한다.
  //
  // **microtask 하나로는 부족하다** — `await Promise.resolve()` 만 넣으면 fire-and-forget 쪽이
  // 그 microtask 를 먼저 큐에 얹어 두고(넘기는 호출 자체가 그 지점까지는 동기다), 부르는 쪽이
  // `void` 로 끊어도 자신의 반환값이 풀리는 시점보다 그 microtask 가 먼저 돈다 — 직접 격리된
  // 재현으로 확인했다(둘 다 mutated=true). 실제 디스크 쓰기처럼 **macrotask** 경계를 하나 두어야
  // "기다린 쪽만 그 경계를 실제로 건넌다"가 성립한다.
  const setState = async (n: OrchState): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve))
    box.state = n
    commits.push(n)
  }

  const started: Array<
    Parameters<OrchServerDeps['startWorker']>[0] & { rollAccountIds: string[]; commitsAtCall: number }
  > = []
  const reviewFiles = new Map<string, string>()
  const readReviewFileCalls: string[] = []
  const suspiciousFilesFor = new Map<string, string[]>()

  // ipc.ts 의 startWorker 래퍼 — 워커를 띄우는 모든 길(worker-start, repair 의 같은 세션 재사용·새
  // 워커, 검토 Dispatch)이 이 한 곳을 지나고, 여기서 Task.accountIds 로부터 rollAccountIds 를 계산해
  // 붙인다(property 4). 띄우려는 provider 가 이 Task 의 provider 와 다르면(검토 Dispatch) 그 계산을
  // 건너뛰고 요청된 계정 하나로 저하한다 — ipc.ts 의 그 가드 그대로. **이것은 그 계약을 이 층에서
  // 재구현한 것이지 ipc.ts 자신의 코드가 아니다** — ipc.ts 가 실제로 그 계약을 지키는지는
  // ipcConvergenceWiring.test.ts(텍스트 가드)가 별도로 확인한다.
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
    const specPath = `${SPECS_DIR}/${specFileName(a.taskId, a.dispatchId)}`
    if (a.terminal) return { sessionId: a.terminal, cwd: a.terminalCwd!, specPath }
    const sessionId = `sess-${++sessionSeq}`
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
    log: (m) => logs.push(m),
    now: () => new Date().toISOString()
  }

  // ipc.ts 의 startReview — 검토 Dispatch 를 **커밋한 뒤에만** startWorker 를 부르고, 그 뒤에
  // sessionId·cwd·specPath 를 되읽어 patch 한다(property 1). spec 본문은 production 의
  // buildReviewSpecFile 을 그대로 부른다 — resultPath 를 그 함수가 실제로 문서에 박아 넣는 문자열
  // 그대로 얻어야, "그 문서가 말하는 자리" 와 "server.ts 가 실제로 읽는 자리" 가 같은지(property 2,
  // 쓰기 half) 손으로 흉내 낸 두 문자열이 우연히 같은 것이 아니라 진짜로 확인할 수 있다.
  const startReview = async ({ taskId }: { taskId: string }): Promise<void> => {
    const task = box.state.tasks.find((t) => t.id === taskId)
    if (task?.status !== 'reviewing') return
    const impl = box.state.dispatches
      .filter((d) => d.taskId === taskId && !d.review)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .at(-1)
    if (!impl) return
    const picked = pickReviewer({ implProvider: impl.provider, accounts: fullAccounts, loggedInIds })
    if (!picked) return
    const opened = openReviewDispatch(
      box.state,
      {
        taskId,
        provider: picked.provider,
        accountId: picked.accountId,
        sessionId: `pending:rev-${++reviewSeq}`,
        cwd: impl.cwd,
        specPath: ''
      },
      new Date().toISOString()
    )
    if (!opened.ok) return
    await setState(opened.state)
    // ipc.ts 는 `<specsDir>/<specFileName(taskId, dispatchId)>.review.json` 을 짓는다 — 아래
    // startWorker 가 이 Dispatch 의 specPath 로 내는 값과 같은 함수·같은 인자를 쓴다.
    const resultPath = `${SPECS_DIR}/${specFileName(taskId, opened.value.id)}.review.json`
    const specFileContent = buildReviewSpecFile({
      title: task.title,
      spec: task.spec,
      taskId,
      dispatchId: opened.value.id,
      implReport: task.result,
      filesModified: task.filesModified,
      validated: checkConfigIdsOf(task).length > 0,
      checks: task.checks,
      previousIssues: task.reviewIssues,
      suspiciousFiles: task.suspiciousFiles,
      resultPath
    })
    let result: { sessionId: string; cwd: string; specPath: string }
    try {
      result = await startWorker({
        dispatchId: opened.value.id,
        taskId,
        title: `Review: ${task.title}`,
        spec: task.spec,
        specFileContent,
        provider: picked.provider,
        accountId: picked.accountId,
        runCwd: impl.cwd,
        worktree: 'current'
      })
    } catch (e) {
      logs.push(`startReview: failed to start the reviewer: ${String(e)}`)
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

  // 아래 다섯 훅을 OrchServerDeps 의 실제 시그니처에 각각 맞춰 둔다 — `as OrchServerDeps` 로 객체
  // 전체를 한 번에 눌러 버리면, 이 파일이 확인하려는 바로 그 훅들(readReviewFile·repairOnce 등)의
  // 시그니처가 바뀌어도 여기는 조용히 컴파일된다. 개별로 타입을 주면 그 변경이 여기서 타입 오류로
  // 먼저 걸린다.
  const startValidation: NonNullable<OrchServerDeps['startValidation']> = ({ taskId, cwd }) => {
    const task = box.state.tasks.find((t) => t.id === taskId)
    validator.enqueue({ taskId, cwd, configIds: task ? checkConfigIdsOf(task) : [] })
    // ipc.ts 는 convergence Run 에서만 suspiciousFiles 를 계산한다(policyOf === null 이면
    // 건너뛴다) — 진짜 계산은 git diff 를 훑지만(changedFilesSince), 이 가짜는 그 결과를
    // suspiciousFilesFor 로 대신하고 **같은 가드**를 지킨다. property 5 가 확인하는 것이 그 가드다.
    //
    // **공유 setState 를 거치지 않고 바로 적는다.** setState 는 이제(finding 2) 진짜 디스크 쓰기처럼
    // macrotask 하나만큼 늦게 풀린다 — repairOnce 경로의 구분을 살리는 데 필요한 지연이다. 이 자리는
    // 그 지연이 필요 없을 뿐 아니라, 걸면 해를 끼친다: 이 fire-and-forget 쓰기가 늦게 풀리는 동안
    // onSettled 가 (그때는 아직 이 값이 없는) 낡은 스냅숏으로 커밋하면, 그 커밋이 tasks 배열을
    // 통째로 새로 써서 이 값을 영영 덮어써 버린다 — 실제로 겪은 결함이다(vi.waitFor 로 몇 초를 더
    // 기다려도 나타나지 않았다). 실제 git diff 는 보통 이 경합이 드러나지 않을 만큼 빠르지만, 이
    // 가짜의 check 는 사실상 순간이라 오히려 경합이 거의 매번 일어난다 — 이 가짜가 만든 인공물이지
    // property 5 가 확인하려는 것(그 가드 자체)과는 무관하다.
    if (!task || policyOf(box.state, task) === null) return
    const suspicious = suspiciousFilesFor.get(taskId)
    if (!suspicious?.length) return
    box.state = {
      ...box.state,
      tasks: box.state.tasks.map((t) => (t.id === taskId ? { ...t, suspiciousFiles: suspicious } : t))
    }
  }
  const startReviewHook: NonNullable<OrchServerDeps['startReview']> = ({ taskId }) => {
    void startReview({ taskId }).catch((e) => logs.push(`deps.startReview: ${String(e)}`))
  }
  const readReviewFile: NonNullable<OrchServerDeps['readReviewFile']> = async (p) => {
    readReviewFileCalls.push(p)
    return reviewFiles.get(p) ?? null
  }
  const repairTargetForHook: NonNullable<OrchServerDeps['repairTargetFor']> = (taskId) =>
    repairTargetFor(box.state, taskId, (id) => alive.has(id))
  const startRepairHook: NonNullable<OrchServerDeps['startRepair']> = ({ dispatchId }) =>
    void performRepair(repairDeps, { dispatchId }).catch((e) => logs.push(`deps.startRepair: ${String(e)}`))
  // ipc.ts 는 repairOnce 자신의 Promise 를 그대로 돌려준다 — gate-resolve 가 그것을 기다려 "Dispatch
  // 가 이미 커밋됐다"까지만 기다린다(repair.ts 의 repairOnce 주석). void 로 끊으면 그 await 가 곧바로
  // 풀려 커밋 전에 응답이 나간다.
  const repairOnceHook: NonNullable<OrchServerDeps['repairOnce']> = ({ taskId }) => repairOnce(repairDeps, { taskId })

  const deps: OrchServerDeps = {
    getState: () => box.state,
    setState,
    startWorker,
    releaseWorker: async () => {},
    listAccounts: (provider) => (provider ? accounts.filter((a) => a.provider === provider) : accounts),
    readWorker: async () => '',
    enabled: () => true,
    startValidation,
    startReview: startReviewHook,
    readReviewFile,
    repairTargetFor: repairTargetForHook,
    startRepair: startRepairHook,
    repairOnce: repairOnceHook,
    lang: () => 'en',
    // server.ts 자신이 이 훅으로 남기는 것들(검토 판정 분기의 "review.json malformed"·"could not be
    // read" 등) — 빠뜨리면 property 2 가 잡아야 할 바로 그 부류의 실패가 로그 없이 사라진다.
    log: (m) => logs.push(m)
  }

  // ipc.ts 의 validator — onSettled 는 repairTargetFor → applyValidationResult → 커밋 → (reviewing
  // 이면 startReview, 아니면 새 repair Dispatch 를 찾아 performRepair) 순서다. 이 순서 자체는 property
  // 1 이 맞지만, **여기서는 그 순서를 단언하지 않는다** — 이 onSettled 는 이 파일의 가짜이지 production
  // 코드가 아니다. 그 단언은 real server.ts(시나리오 B, 검토 분기)와 real repair.ts(시나리오 E,
  // repairOnce)가 같은 규율을 지키는 자리에 있다.
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
      if (r.value.status === 'reviewing')
        void startReview({ taskId }).catch((e) => logs.push(`onSettled startReview: ${String(e)}`))
      const opened = box.state.dispatches.find(
        (d) => d.taskId === taskId && d.repair !== undefined && !d.endedAt && !d.specPath
      )
      if (opened)
        void performRepair(repairDeps, { dispatchId: opened.id }).catch((e) =>
          logs.push(`onSettled performRepair: ${String(e)}`)
        )
    },
    onCannotRun: async ({ taskId, reason }) => {
      const r = blockForValidation(box.state, { taskId, reason }, new Date().toISOString())
      if (r.ok) await setState(r.state)
    },
    log: (m) => logs.push(m)
  })

  const call = (cmd: string, args: Record<string, unknown> = {}, sessionId = 'coordinator') =>
    handleCommand(deps, { sessionId }, cmd, args)

  // 큐에 들어간 check 들을 순서대로 끝낸다 — exits 에 적힌 코드로, 없으면 0.
  //
  // **onRunExit 을 호출한 자리와 validator.ts 가 그 head 의 runId 를 실제로 적어 두는 자리 사이에는
  // 정확히 한 microtask 틱이 있다**(startCheck 의 `await this.deps.runner.start(...)` — 이미 풀린
  // Promise 라도 await 는 항상 한 틱을 쉰다). runnerCalls 에 새 항목이 보이는 시점과 그 틱이 지나는
  // 시점이 갈리므로, 보이는 즉시 한 번만 부르면 이 exit 를 못 찾은 채(headFor 가 아직 옛 runId 를
  // 보는 채) 조용한 no-op 이 된다 — 그래서 그 효과(다음 check 가 뜨거나 이 Task 가 validating 을
  // 떠남)가 보일 때까지 **다시 부르는 것 자체를 재시도**한다: onRunExit 은 자기 head 가 아닌 exit 에
  // 아무 일도 하지 않으므로(멱등) 이르게 걸린 재시도는 무해하다. 이 재시도는 이 하네스 자신의
  // 산물(가짜 runner 가 await 없이 동기로 끝나는 것)을 메우는 것이지 production 결함이 아니다.
  //
  // **끝을 정하는 규칙은 "이 Task 가 아직 validating 인가" 뿐이다.** 고정된 타임아웃을 "더 이상 올
  // 것이 없다" 는 신호로 읽지 않는다 — 부하가 걸린 CI 에서 다음 check 가 그 타임아웃보다 늦게 뜨면
  // 조용히 일찍 끝나 버리고, 실패는 훨씬 뒤 상관없어 보이는 자리에서 터진다. 남은 타임아웃(아래)은
  // 전부 "정말로 문제가 있다" 를 위한 안전판일 뿐, 종료 판정 자체가 아니다.
  let handled = 0
  const drainChecks = async (): Promise<void> => {
    for (;;) {
      if (handled >= runnerCalls.length) {
        const before = runnerCalls.length
        await vi.waitFor(() => expect(runnerCalls.length).toBeGreaterThan(before), { timeout: 2000, interval: 5 })
      }
      const c = runnerCalls[handled]
      handled += 1
      const beforeLen = runnerCalls.length
      await vi.waitFor(
        () => {
          validator.onRunExit({ runId: c.runId, exitCode: exits.get(c.configId) ?? 0 })
          const task = box.state.tasks.find((t) => t.id === c.taskId)
          expect(runnerCalls.length > beforeLen || task?.status !== 'validating').toBe(true)
        },
        { timeout: 2000, interval: 5 }
      )
      if (box.state.tasks.find((t) => t.id === c.taskId)?.status !== 'validating') return
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
    logs,
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
    await r.drainChecks()

    // round 1: typecheck passes, tests fails -> repair goes to the same session
    const task1 = r.box.state.tasks[0]
    // property 5 (positive half): a convergence Run's suspiciousFiles is written when the wiring has
    // something to flag — the regression test below is the negative half (never written).
    expect(task1.suspiciousFiles).toEqual(['package.json'])
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
    // accounts without opening a second repair. (This pins the fake's contract; whether ipc.ts's own
    // wrapper honours it is what ipcConvergenceWiring.test.ts's source guard checks separately.)
    expect(repairCall.rollAccountIds).toEqual(['accA', 'accA2'])

    // the worker fixes it and reports again
    r.exits.delete('tests')
    await r.done(taskId, repair.id, sessionId)
    expect(r.box.state.tasks[0].status).toBe('validating')
    await r.drainChecks()
    expect(r.box.state.tasks[0].status).toBe('reviewing')
    const review = await r.awaitOpenReview(taskId)
    // property 2 (write half, real production code): the resultPath buildReviewSpecFile actually
    // wrote into the reviewer's own spec is exactly the path server.ts will later read — both built
    // from the same specFileName call, not two independently hand-rolled strings.
    const reviewCall = r.started.find((s) => s.dispatchId === review.id)!
    expect(reviewCall.specFileContent).toContain(`${review.specPath}.review.json`)
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
    // property 2 (read half): the `.review.json` suffix was appended exactly once, end to end.
    expect(r.readReviewFileCalls).toEqual([`${review.specPath}.review.json`])
    expect(r.logs).toEqual([])
  })

  it('B: a blocking review issue repairs the worker, and the checks re-run before the reviewer sees it again', async () => {
    const r = rig()
    const { taskId, dispatchId, sessionId } = await r.setup({ validate: 'typecheck,tests', review: true })
    await r.done(taskId, dispatchId, sessionId)
    await r.drainChecks()
    expect(r.box.state.tasks[0].status).toBe('reviewing')
    const review1 = await r.awaitOpenReview(taskId)
    const review1Call = r.started.find((s) => s.dispatchId === review1.id)!
    expect(review1Call.specFileContent).toContain(`${review1.specPath}.review.json`)
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
    // property 1, against real server.ts (not this file's fake): the `send` handler's review branch
    // commits the repair Dispatch (state.ts's routeFailure, inside applyReviewResult) and only *after*
    // that commit calls deps.startRepair. The commit that introduces this Dispatch (specPath still
    // '') must have a lower index in the commit log than the startWorker call server.ts triggered for it.
    const openedAt = r.commits.findIndex((s) => s.dispatches.some((d) => d.id === repair.id && d.specPath === ''))
    expect(openedAt).toBeGreaterThanOrEqual(0)
    expect(repairCall.commitsAtCall).toBeGreaterThan(openedAt)

    await r.done(taskId, repair.id, sessionId)
    // the checks run again before the reviewer does — a repaired change is never reviewed unchecked
    expect(r.box.state.tasks[0].status).toBe('validating')
    await r.drainChecks()
    // both checks re-ran after the review-triggered repair, not just one
    expect(r.runnerCalls.map((c) => c.configId)).toEqual(['typecheck', 'tests', 'typecheck', 'tests'])
    expect(r.box.state.tasks[0].status).toBe('reviewing')
    const review2 = await r.awaitOpenReview(taskId)
    expect(review2.id).not.toBe(review1.id)
    expect(review2.specPath).not.toBe(review1.specPath)
    const review2Call = r.started.find((s) => s.dispatchId === review2.id)!
    expect(review2Call.specFileContent).toContain(`${review2.specPath}.review.json`)
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
    expect(r.logs).toEqual([])
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
    expect(r.logs).toEqual([])
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
      // the old session died with the app, so this is a fresh worker — not a --terminal reuse of a
      // session number that happens to fall out of the fake's counters.
      const repair2Call = r2.started.find((s) => s.dispatchId === repair2.id)!
      expect(repair2Call.terminal).toBeUndefined()
      expect(repair2.sessionId.startsWith('sess-')).toBe(true)
      expect(r.logs).toEqual([])
      expect(r2.logs).toEqual([])
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
      const review2Call = r2.started.find((s) => s.dispatchId === review2.id)!
      expect(review2Call.specFileContent).toContain(`${review2.specPath}.review.json`)
      r2.reviewFiles.set(`${review2.specPath}.review.json`, '{"issues":[]}')
      await r2.call(
        'send',
        { type: 'worker_done', taskId, dispatchId: review2.id, outcome: 'succeeded', subject: 'ok', body: 'b' },
        review2.sessionId
      )
      expect(r2.box.state.tasks[0].status).toBe('completed')
      expect(r.logs).toEqual([])
      expect(r2.logs).toEqual([])
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

    // a person grants one more. repairOnce (repair.ts, real production code) resolves only once the
    // new Dispatch is committed — its own commit contract, not a race the test has to poll for — so
    // the count is asserted synchronously, right after the await, with no vi.waitFor in between.
    await r.call('gate-resolve', { id: gate.id, resolution: 'retry-once' })
    expect(r.box.state.dispatches.filter((d) => d.repair)).toHaveLength(3)
    expect(r.box.state.tasks[0].status).toBe('dispatched')
    const repair3 = r.box.state.dispatches.filter((d) => d.repair).at(-1)!
    // property 1, against real repair.ts (not this file's fake): the commit that opened this Dispatch
    // (specPath still '') must precede the side effect that starts a worker for it — repairOnce's own
    // fire-and-forget performRepair call, which may still be in flight after the await above returns.
    const openedAt = r.commits.findIndex((s) => s.dispatches.some((d) => d.id === repair3.id && d.specPath === ''))
    expect(openedAt).toBeGreaterThanOrEqual(0)
    const repair3Call = await vi.waitFor(
      () => {
        const call = r.started.find((s) => s.dispatchId === repair3.id)
        expect(call).toBeTruthy()
        return call!
      },
      { timeout: 2000, interval: 5 }
    )
    expect(repair3Call.commitsAtCall).toBeGreaterThan(openedAt)

    // another failure -> gated again, with no automatic repeat
    repair = repair3
    await r.done(taskId, repair.id, sessionId)
    await r.drainChecks()
    expect(r.box.state.tasks[0].status).toBe('blocked')
    expect(r.box.state.dispatches.filter((d) => d.repair)).toHaveLength(3)
    expect(r.logs).toEqual([])
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
    // checks/checkHistory 는 이제 정책 없는 Run 에서도 자란다(state.ts, UI 설계 U2) — 얼마 전까지의
    // "정책 없는 Run 의 orchestration.json 은 커지지 않는다" 보장이 여기서 뒤집혔다. 화면이 어느 검사가
    // 깨졌는지 그리려면 이 Task 에도 checks 가 있어야 한다. outputTail 은 실패한 검사의 것이라 키가
    // 남는다 — 통과한 검사만 벗겨진다.
    expect(r.box.state.tasks[0].checks).toEqual([
      expect.objectContaining({ configId: 'tests', status: 'failed', exitCode: 1, outputTail: 'tail' })
    ])
    expect(r.box.state.tasks[0].checkHistory).toEqual({ tests: ['failed'] })
    expect(r.logs).toEqual([])
  })
})
