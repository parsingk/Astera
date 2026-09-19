// repair Dispatch 의 부수 효과(설계 §6.2). 순수 층(state.ts)이 "판정과 repair Dispatch 열기" 를 한 번의 쓰기로
// 끝내면, 여기가 spec 파일을 쓰고 세션에 넣거나 새 워커를 띄우고 자리표시자를 채운다 — worker-start 의
// 서버 분기가 하는 것과 같은 순서(커밋 → 부수 효과 → 패치 → 실패면 롤백)다. ipc.ts 에는 테스트가 닿지
// 않으므로 그 순서가 여기 있다.
import { isSamePath } from '../../core/files/tree'
import { t, type Lang } from '../../core/i18n'
import { latestImplDispatch, policyOf, repairCountOf } from '../../core/orchestration/convergence'
import { createGate, openDispatch, type OrchState, type RepairTarget } from '../../core/orchestration/state'
import { isPlaceholderSessionId, placeholderSessionId, type Dispatch, type Task } from '../../core/orchestration/types'
import type { KnowledgeFiles } from '../../core/knowledge/detect'
import { buildSpecFile, repairWorkerPrompt } from './coordinator'
import type { OrchServerDeps } from './server'

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

function repairSpec(s: OrchState, task: Task, d: Dispatch, run: { cwd: string }, knowledge: KnowledgeFiles | undefined): string {
  const policy = policyOf(s, task)
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
      repair: repairCountOf(s, task.id),
      maxFixAttempts: policy?.maxFixAttempts ?? 3,
      checks: task.checks,
      issues: task.reviewIssues
    }
  })
}

/** 이미 열린 repair Dispatch 의 부수 효과. 실패하면 Dispatch 를 지우고 Gate 를 연다 — 판정은 끝났고 워커만
 *  못 띄운 것이므로 되돌릴 상태가 없다: 사람에게 간다. */
export async function performRepair(deps: RepairDeps, a: { dispatchId: string }): Promise<void> {
  const s = deps.getState()
  const d = s.dispatches.find((x) => x.id === a.dispatchId)
  if (!d || !d.repair || d.endedAt) return
  const task = s.tasks.find((x) => x.id === d.taskId)
  const run = task && s.runs.find((r) => r.id === task.runId)
  if (!task || !run) return
  const knowledge = await deps.knowledge(d.cwd).catch(() => undefined)
  const specFileContent = repairSpec(deps.getState(), task, d, run, knowledge)
  const same = !isPlaceholderSessionId(d.sessionId)
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
    const latest = deps.getState()
    await deps.setState({
      ...latest,
      dispatches: latest.dispatches.map((x) =>
        x.id === d.id ? { ...x, sessionId: started.sessionId, cwd: started.cwd, specPath: started.specPath } : x
      )
    })
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
    await deps.setState(g.ok ? g.state : without)
    if (!g.ok) deps.log(`repair: could not gate task=${task.id}: ${g.error}`)
  }
}

/** 소진 Gate 의 retry-once(설계 §5.2): ready 로 풀린 Task 에 예산 밖의 repair 를 **정확히 하나** 연다. */
export async function repairOnce(deps: RepairDeps, a: { taskId: string }): Promise<void> {
  const s = deps.getState()
  const task = s.tasks.find((x) => x.id === a.taskId)
  if (!task) return
  const prior = latestImplDispatch(s, a.taskId)
  const target = repairTargetFor(s, a.taskId, deps.isAlive)
  if (!prior || !target) {
    deps.log(`repair: retry-once has no implementation dispatch to repair for task=${a.taskId}`)
    return
  }
  const reason = prior.repair ?? (task.reviewIssues?.some((i) => i.blocking) ? 'review-failure' : 'check-failure')
  const opened = openDispatch(
    s,
    {
      taskId: a.taskId,
      provider: target.provider,
      accountId: target.accountId,
      sessionId: target.kind === 'same-session' ? target.sessionId : placeholderSessionId(),
      cwd: target.cwd,
      specPath: '',
      retryOf: prior.id,
      repair: reason,
      ignoreCircuit: true
    },
    deps.now()
  )
  if (!opened.ok) {
    deps.log(`repair: retry-once could not open a dispatch for task=${a.taskId}: ${opened.error}`)
    return
  }
  await deps.setState(opened.state)
  await performRepair(deps, { dispatchId: opened.value.id })
}
