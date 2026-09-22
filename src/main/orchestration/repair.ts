// repair Dispatch 의 부수 효과(설계 §6.2). 순수 층(state.ts)이 "판정과 repair Dispatch 열기" 를 한 번의 쓰기로
// 끝내면, 여기가 spec 파일을 쓰고 세션에 넣거나 새 워커를 띄우고 자리표시자를 채운다 — worker-start 의
// 서버 분기가 하는 것과 같은 순서(커밋 → 부수 효과 → 패치 → 실패면 롤백)다. ipc.ts 에는 테스트가 닿지
// 않으므로 그 순서가 여기 있다.
import { isSamePath } from '../../core/files/tree'
import { t, type Lang } from '../../core/i18n'
import { latestImplDispatch, policyOf, repairCountOf } from '../../core/orchestration/convergence'
import { createGate, jobOf, openDispatch, type OrchState, type RepairTarget } from '../../core/orchestration/state'
import {
  canTransition,
  FAILURE_LIMIT,
  isPlaceholderSessionId,
  placeholderSessionId,
  type Dispatch,
  type Task
} from '../../core/orchestration/types'
import type { KnowledgeFiles } from '../../core/knowledge/detect'
import { buildSpecFile, repairWorkerPrompt } from './coordinator'
import type { OrchServerDeps } from '../../core/orchestration/command'

export interface RepairDeps {
  getState(): OrchState
  setState(next: OrchState): Promise<void>
  /** ipc.ts 의 래퍼 — 롤링 체인과 출력 tail 을 붙인다. coordinator.startWorker 를 직접 부르지 않는다
   *  (startReview 의 주석과 같은 이유) */
  startWorker: OrchServerDeps['startWorker']
  isAlive(sessionId: string): boolean
  knowledge(cwd: string): Promise<KnowledgeFiles | undefined>
  lang(): Lang
  log(m: string): void
  now(): string
}

/** 판정 직전에 배선이 부른다: 마지막 구현·수리 세션이 살아 있으면 그 세션, 아니면 새 워커(설계 D3). */
export function repairTargetFor(s: OrchState, taskId: string, isAlive: (id: string) => boolean): RepairTarget | null {
  const prior = latestImplDispatch(s, taskId)
  if (!prior) return null
  const base = { cwd: prior.cwd, provider: prior.provider, accountId: prior.accountId }
  return !isPlaceholderSessionId(prior.sessionId) && isAlive(prior.sessionId)
    ? { kind: 'same-session', sessionId: prior.sessionId, ...base }
    : { kind: 'fresh', ...base }
}

/** spec 의 "## Repair request" 절 재료. **인자 넷 모두 같은 state 조각에서 읽어야 한다** — repairCountOf 와
 *  policyOf 가 그 state 기준으로 세고, task.checks·task.reviewIssues 가 다른 스냅샷의 것이면 숫자와 본문이
 *  서로 다른 시점을 말하게 된다(리뷰 fix 1차, Important 3 인접). */
function repairSpec(s: OrchState, task: Task, d: Dispatch, run: { cwd: string }, knowledge: KnowledgeFiles | undefined): string {
  const policy = policyOf(s, task)
  const maxFixAttempts = policy?.maxFixAttempts ?? FAILURE_LIMIT
  const repairs = repairCountOf(s, task.id)
  return buildSpecFile({
    title: task.title,
    spec: task.spec,
    taskId: task.id,
    dispatchId: d.id,
    // startWorker 가 cwd !== runCwd 로 같은 판정을 한다 — 여기서는 파일을 통째로 넘기므로 직접 정한다
    committing: !isSamePath(d.cwd, run.cwd),
    knowledge,
    repair: {
      reason: d.repair!,
      repair: repairs,
      maxFixAttempts,
      checks: task.checks,
      issues: task.reviewIssues,
      // **repairs > maxFixAttempts 로 판정하지 않는다(전체 브랜치 리뷰, Finding 3 — 두 번째 자리).**
      // repairCountOf 는 크래시로 잃은 repair Dispatch 와 그것을 잇는 recovery 의 replacement 를
      // 둘 다 센다(둘 다 `.repair` 가 있다) — 그 유령들은 이전 라운드에서 와서 영영 남으므로, 세
      // 번 중 두 번만 실제로 열렸어도 네 번째 Dispatch 를 열 때는 count 가 4 로, 진짜 예산
      // 소진(§5.1의 exhausted Gate) 없이도 우연히 maxFixAttempts 를 넘을 수 있다 — 아무도 허락하지
      // 않았는데 "사람이 허락했다" 고 말하게 된다(execute.ts 에서 고친 것과 같은 거짓말). 대신 이
      // Dispatch 자신이 열릴 때 이미 적어 둔 사실(Dispatch.grantedExtra — repairOnce 가 ignoreCircuit
      // 으로 열 때만 참이다)을 읽는다.
      ...(d.grantedExtra ? { extra: true } : {})
    }
  })
}

/** 주어진 state 조각에서 이 repair Dispatch 를 다시 찾는다. **부수 효과 앞뒤로 두 번 부른다** — 한 번은
 *  knowledge 스캔이 끝난 뒤(그 사이 값이 바뀌었을 수 있다), 한 번은 이미 수행됐는지 보려고. 두 자리 모두
 *  같은 조건이라 함수로 뽑았다: Dispatch 가 없거나, repair 가 아니거나, 이미 끝났거나, specPath 가 이미
 *  채워져 있으면(=이미 한 번 수행됐다, Important 3) 더 할 일이 없다. */
function liveRepairDispatch(s: OrchState, dispatchId: string): { task: Task; d: Dispatch; run: { cwd: string } } | null {
  const d = s.dispatches.find((x) => x.id === dispatchId)
  if (!d || !d.repair || d.endedAt || d.specPath) return null
  const task = s.tasks.find((x) => x.id === d.taskId)
  // 프로젝트 폴더는 계획의 것이다 — 회차에서 Job 으로 한 번 더 건너간다
  const run = task && s.runs.find((r) => r.id === task.runId)
  const job = run && jobOf(s, run)
  if (!task || !job) return null
  return { task, d, run: job }
}

/** 이미 열린 repair Dispatch 의 부수 효과. 실패하면 Dispatch 를 지우고 Gate 를 연다 — 판정은 끝났고 워커만
 *  못 띄운 것이므로 되돌릴 상태가 없다: 사람에게 간다.
 *
 *  **결과를 돌려준다.** void 였을 때는 startWorker 도 createGate 도 실패한 자리를 아무도 알 방법이
 *  없었다 — 부르는 쪽(repairOnce, 그리고 앞으로의 배선)이 실패를 보고 에스컬레이션할 수 있어야 한다. */
export async function performRepair(deps: RepairDeps, a: { dispatchId: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const live0 = liveRepairDispatch(deps.getState(), a.dispatchId)
  if (!live0) return { ok: true } // 이미 수행됐거나, repair 가 아니거나, 이미 끝났다 — 할 일이 없다
  const knowledge = await deps.knowledge(live0.d.cwd).catch(() => undefined)

  // knowledge 스캔은 fs 를 훑는 await 하나다 — 그 사이 다른 흐름이 이 Dispatch 를 건드렸을 수
  // 있으므로(다른 요청의 performRepair 재호출, 혹은 이 Dispatch 를 닫은 무언가) 다시 읽는다.
  // task·d·run 을 이 최신 조각 하나에서 다시 뽑는다 — 이전 읽기에서 잡은 task·d 를 이 시점의 s 와
  // 섞어 쓰면 서로 다른 시점의 값이 한 spec 에 들어간다(리뷰 fix 1차, Important 3 인접 이슈).
  const s = deps.getState()
  const live = liveRepairDispatch(s, a.dispatchId)
  if (!live) return { ok: true }
  const { task, d, run } = live

  const specFileContent = repairSpec(s, task, d, run, knowledge)
  // 세션이 살아 있는지는 **지금** 본다, 판정 시점의 sessionId 만으로 정하지 않는다 — 판정과 이
  // 부수 효과 사이에 재시도·재시작·복구 스윕처럼 시간이 벌어질 수 있고, 그 사이 세션이 죽었으면
  // --terminal 주입이 코디네이터의 "terminal session is not alive" 로 실패해 Gate 로 가버린다.
  // 설계가 말하는 낙방(fresh 로 내려가는 것)은 여기서, 이 시점의 값으로 정해야 한다.
  const same = !isPlaceholderSessionId(d.sessionId) && deps.isAlive(d.sessionId)
  try {
    const started = await deps.startWorker({
      dispatchId: d.id,
      taskId: task.id,
      title: task.title,
      spec: task.spec,
      specFileContent,
      provider: d.provider,
      accountId: d.accountId,
      runCwd: run.cwd,
      worktree: d.cwd,
      ...(same
        ? { terminal: d.sessionId, terminalCwd: d.cwd, terminalProvider: d.provider, terminalAccountId: d.accountId, launchPhrase: repairWorkerPrompt('{specPath}') }
        : {})
    })
    // 다시 읽고, 세 자리(sessionId·cwd·specPath)만 patch 한다 — startWorker 를 기다리는 동안 다른
    // 흐름(예: 이례적으로 빨리 도착한 worker_done)이 이 Dispatch 를 이미 닫았을 수 있고, 그 결과를
    // 덮어써서는 안 된다. worker-start 의 서버 분기와 같은 규율이다.
    const latest = deps.getState()
    await deps.setState({
      ...latest,
      dispatches: latest.dispatches.map((x) =>
        x.id === d.id ? { ...x, sessionId: started.sessionId, cwd: started.cwd, specPath: started.specPath } : x
      )
    })
    return { ok: true }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    deps.log(`repair: could not start worker for task=${task.id} dispatch=${d.id}: ${reason}`)
    const latest = deps.getState()
    const without: OrchState = { ...latest, dispatches: latest.dispatches.filter((x) => x.id !== d.id) }
    const g = createGate(
      without,
      { taskId: task.id, question: t(deps.lang(), 'jobs.convergence.gate.repairFailed', { reason }), kind: 'convergence-blocked' },
      deps.now()
    )
    if (g.ok) {
      await deps.setState(g.state)
      return { ok: false, error: reason }
    }
    // createGate 마저 거절했다(다른 Dispatch 가 이미 열려 있는 등) — Dispatch 는 지웠지만 Task 는
    // 아직 openRepairDispatch 가 남긴 dispatched 다. task-list --ready 는 dispatched 를 보여주지
    // 않으므로, 여기서 멈추면 아무도 이 Task 를 다시 보러 오지 않는다 — worker-start(server.ts)가
    // previousStatus 로 되돌려 피하는 것과 같은 모양의 함정이다. dispatched -> failed 는 허용된
    // 전이이고(types.ts 의 ALLOWED) 사람이 보고 재시도할 수 있는 상태다 — 안 보이는 것보다는 낫다.
    // 제거와 이 전이를 한 번의 setState 로 묶는다 — Gate 가 성공했을 때와 같은 단일 쓰기 규율이다.
    deps.log(`repair: could not gate task=${task.id} (${g.error}) — marking it failed instead of leaving it stuck`)
    const failedTask = without.tasks.find((x) => x.id === task.id)
    const forced: OrchState =
      failedTask && canTransition(failedTask.status, 'failed')
        ? {
            ...without,
            tasks: without.tasks.map((x) =>
              x.id === task.id
                ? { ...x, status: 'failed', result: `repair could not be started: ${reason}`, updatedAt: deps.now() }
                : x
            )
          }
        : without
    await deps.setState(forced)
    return { ok: false, error: reason }
  }
}

/** 소진 Gate 의 retry-once(설계 §5.2): ready 로 풀린 Task 에 예산 밖의 repair 를 **정확히 하나** 연다.
 *
 *  **결과를 돌려준다(전체 브랜치 리뷰, Finding 5).** 사람이 이 Gate 를 "한 번 더" 로 풀었는데, 이
 *  Task 를 다시 막는 두 번째 Gate 가 이미 열려 있으면(예: 다른 이슈로 동시에 blocked 됐다면)
 *  openDispatch 가 "task is blocked by an open gate" 로 거절한다 — 그 답은 조용히 사라지고 서버는
 *  그래도 200 을 돌려준다. void 로는 부르는 쪽이 이것을 알 방법이 없었다. 지금은 코디네이터 재시도로
 *  자연히 저하하므로 급하지 않지만, 사람의 답이 말없이 사라지는 것은 이 브랜치가 스무 번 고쳐 없앤
 *  바로 그 실패 종류다. */
export async function repairOnce(
  deps: RepairDeps,
  a: { taskId: string }
): Promise<{ ok: true } | { ok: false; error: string }> {
  const s = deps.getState()
  const task = s.tasks.find((x) => x.id === a.taskId)
  if (!task) return { ok: false, error: `unknown task: ${a.taskId}` }
  const prior = latestImplDispatch(s, a.taskId)
  const target = repairTargetFor(s, a.taskId, deps.isAlive)
  // target 이 null 인 것은 정확히 prior 가 없을 때뿐이다(repairTargetFor 의 유일한 null 갈래) —
  // 같은 s·taskId 로 부른 같은 판정이라 prior 만 다시 확인하지 않는다.
  if (!target) {
    const error = `no implementation dispatch to repair for task=${a.taskId}`
    deps.log(`repair: retry-once has ${error}`)
    return { ok: false, error }
  }
  const reason = prior!.repair ?? (task.reviewIssues?.some((i) => i.blocking) ? 'review-failure' : 'check-failure')
  const opened = openDispatch(
    s,
    {
      taskId: a.taskId,
      provider: target.provider,
      accountId: target.accountId,
      sessionId: target.kind === 'same-session' ? target.sessionId : placeholderSessionId(),
      cwd: target.cwd,
      specPath: '',
      retryOf: prior!.id,
      repair: reason,
      ignoreCircuit: true
    },
    deps.now()
  )
  if (!opened.ok) {
    deps.log(`repair: retry-once could not open a dispatch for task=${a.taskId}: ${opened.error}`)
    return { ok: false, error: opened.error }
  }
  await deps.setState(opened.state)
  // **여기서 resolve 한다 — performRepair 를 기다리지 않는다.** Dispatch 는 이미 커밋됐고(Task 는
  // 이미 dispatched 다), 그것으로 이 함수의 호출자(server.ts 의 gate-resolve)가 필요로 하는 창은
  // 닫힌다: worker-release·worker-start 의 "수렴 중" 가드가 이제 이 Dispatch 를 본다. 실제 부수
  // 효과(spec 파일 쓰기, 세션 띄우기)는 startRepair 의 다른 모든 호출자(server.ts 의 검토 분기)와
  // 같은 자격으로 백그라운드에서 돈다 — performRepair 자신이 실패를 Gate 나 failed 로 이미 다
  // 처리하므로(그 함수의 주석) 여기서 기다려서 얻을 것이 없다. `.catch` 는 안전망이다: 두 함수 다
  // 오늘은 던지지 않지만, 던지는 코드로 바뀌어도 이 fire-and-forget 호출이 처리되지 않은 거부로
  // Electron 메인 프로세스를 죽이지는 않게 한다.
  void performRepair(deps, { dispatchId: opened.value.id }).catch((e) =>
    deps.log(`repair: retry-once's performRepair failed for task=${a.taskId}: ${String(e)}`)
  )
  return { ok: true }
}
