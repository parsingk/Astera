// Run 하나의 이벤트 스트림. view.ts 와 같은 층이고 같은 이유로 여기 있다 — 렌더러에는 테스트가
// 없으므로(vitest 가 environment: 'node' 로 돈다) 화면이 필요한 판정은 전부 이 층에 있어야 한다.
//
// **저장하는 것이 없다.** Run·Task·Dispatch·Message·Gate 가 이미 자기 시각을 들고 있으므로
// 이벤트는 그것들의 파생이다. 명시적인 이벤트 로그를 두면 그것을 쓰는 규율에 기대게 되고, 빠뜨린
// 자리는 화면에서 조용히 사라진다.
//
// view.ts 와 달리 node: 모듈을 끌고 오지 않지만, 그래도 tsconfig.web.json 에 넣지 않는다 —
// 렌더러는 이미 접힌 값(JobEvent[])만 IPC 로 받는다.
import type { JobEvent, JobEventKind } from '../types'
import type { OrchState } from './state'
import type { MessageType } from './types'

/** 같은 시각을 가진 이벤트들의 두 번째 정렬 기준. 한 번의 쓰기가 여러 레코드에 같은 now 를 찍으므로
 *  (applyValidationResult 는 Task 를 옮기면서 메시지를 밀어 넣는다) 시각만으로는 순서가 정해지지
 *  않고, 테스트가 결정적일 수 없다. 순서는 "먼저 있었을 법한 것"으로 골랐다. */
const KIND_RANK: Record<JobEventKind, number> = {
  'run-created': 0,
  'task-created': 1,
  'dispatch-started': 2,
  message: 3,
  'gate-opened': 4,
  'gate-resolved': 5
}

/** 타임라인에서 빼는 메시지 종류.
 *
 *  heartbeat: 사람이 읽을 이벤트가 아니다. 그리고 세면 eventCount 가 계속 올라 사이드바 푸시가
 *  끊이지 않는다 — sameSnapshot 이 막아 주던 것을 이 필드가 다시 열어 버린다.
 *
 *  decision_gate: createGate 가 Gate 레코드와 **함께** 만드는 사본이다(state.ts). 둘을 다 세면
 *  같은 질문이 두 줄로 나온다. Gate 쪽을 택하는 이유는 그쪽에만 resolvedAt 과 resolution 이 있어
 *  해제까지 그릴 수 있어서다. */
const SKIP: ReadonlySet<MessageType> = new Set<MessageType>(['heartbeat', 'decision_gate'])

/** 여러 줄짜리 값의 한 줄 요약. state.ts 가 질문의 subject 를 만들 때와 같은 규칙이다 */
const firstLine = (s: string): string => s.split('\n')[0].slice(0, 120)

/** 정렬하지 않은 이벤트들. timelineFor 와 eventCountFor 가 같은 선택 규칙을 쓰게 하는 자리다 —
 *  규칙을 두 곳에 두면 개수와 목록이 갈라지고, 그 어긋남은 "푸시가 안 온다"로만 드러난다. */
function collect(
  state: OrchState,
  runId: string,
  isKnownSession: (sessionId: string) => boolean
): JobEvent[] {
  const run = state.runs.find((r) => r.id === runId)
  if (!run) return []
  const tasks = state.tasks.filter((t) => t.runId === runId)
  const titleOf = new Map(tasks.map((t) => [t.id, t.title]))
  const events: JobEvent[] = [
    { at: run.createdAt, kind: 'run-created', sourceId: run.id, summary: run.objective }
  ]
  for (const t of tasks) {
    events.push({
      at: t.createdAt,
      kind: 'task-created',
      sourceId: t.id,
      taskId: t.id,
      taskTitle: t.title,
      summary: t.title
    })
  }
  // Dispatch 는 runId 를 갖지 않는다 — 이 Run 의 Task 를 통해 고른다
  const own = new Set(tasks.map((t) => t.id))
  for (const d of state.dispatches) {
    if (!own.has(d.taskId)) continue
    events.push({
      at: d.startedAt,
      kind: 'dispatch-started',
      sourceId: d.id,
      taskId: d.taskId,
      taskTitle: titleOf.get(d.taskId),
      summary: d.provider,
      provider: d.provider,
      ...(d.retryOf ? { retry: true } : {}),
      ...(d.review ? { review: true } : {}),
      ...(isKnownSession(d.sessionId) ? { sessionId: d.sessionId } : {})
    })
  }
  for (const m of state.messages) {
    if (m.runId !== runId || SKIP.has(m.type)) continue
    // 메시지가 가리키는 Dispatch 의 세션 — 그 워커의 탭으로 가는 길이다
    const d = m.dispatchId ? state.dispatches.find((x) => x.id === m.dispatchId) : undefined
    events.push({
      at: m.createdAt,
      kind: 'message',
      sourceId: m.id,
      messageType: m.type,
      taskId: m.taskId,
      taskTitle: m.taskId ? titleOf.get(m.taskId) : undefined,
      summary: m.subject,
      ...(m.body ? { body: m.body } : {}),
      ...(m.outcome ? { outcome: m.outcome } : {}),
      ...(d && isKnownSession(d.sessionId) ? { sessionId: d.sessionId } : {})
    })
  }
  for (const g of state.gates) {
    if (g.runId !== runId) continue
    events.push({
      at: g.createdAt,
      kind: 'gate-opened',
      sourceId: g.id,
      taskId: g.taskId,
      taskTitle: titleOf.get(g.taskId),
      summary: firstLine(g.question),
      body: g.question
    })
    // resolveGate 는 메시지를 남기지 않는다(state.ts) — 이 이벤트가 해제의 유일한 기록이다
    if (g.resolvedAt) {
      events.push({
        at: g.resolvedAt,
        kind: 'gate-resolved',
        sourceId: g.id,
        taskId: g.taskId,
        taskTitle: titleOf.get(g.taskId),
        summary: g.resolution ? firstLine(g.resolution) : '',
        ...(g.resolution ? { body: g.resolution } : {})
      })
    }
  }
  return events
}

/** Run 하나의 이벤트, 시각 오름차순. 모달이 열릴 때만 불린다(orch.runDetail). */
export function timelineFor(
  state: OrchState,
  runId: string,
  isKnownSession: (sessionId: string) => boolean
): JobEvent[] {
  return collect(state, runId, isKnownSession).sort(
    (a, b) =>
      a.at.localeCompare(b.at) ||
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      a.sourceId.localeCompare(b.sourceId)
  )
}

/** 이벤트 개수. snapshotFor 가 매 쓰기마다 부르므로 정렬을 건너뛴다.
 *
 *  세기 위해 객체를 만드는 것은 낭비지만, 선택 규칙을 두 곳에 두는 것보다 낫다 — 개수와 목록이
 *  갈라지면 증상은 "질문이 도착해도 사이드바가 갱신되지 않는다"뿐이고 원인을 찾을 단서가 없다.
 *  세션 판정은 개수에 영향이 없으므로 아무것도 모른다고 넘긴다. */
export function eventCountFor(state: OrchState, runId: string): number {
  return collect(state, runId, () => false).length
}
