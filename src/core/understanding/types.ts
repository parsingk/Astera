// How It Works 화면이 읽는 값들. 스펙(ASTERA_PROJECT_UNDERSTANDING_...)의 모델에서 화면이 실제로
// 쓰는 필드만 옮겼다 — 생성 쪽이 더 필요해지면 그때 늘린다.
// node: import 없음 — 렌더러와 main 이 함께 읽는다.

/** 스펙 §53. 사이드바 줄과 페인 머리가 이 값으로 갈린다 */
export type FeatureStatus =
  | 'up-to-date'
  | 'needs-review'
  | 'possibly-stale'
  | 'generating'
  | 'update-available'
  | 'generation-failed'

export interface ProjectFeature {
  id: string
  /** 기능 이름. 클래스 이름이 아니다 — "인증"이지 "AuthService"가 아니다 */
  name: string
  /** 사이드바 한 줄에 들어가는 요약 */
  summary: string
  status: FeatureStatus
  /** ISO. 이 기능의 설명을 마지막으로 갱신한 시각.
   *  **아직 그리는 화면이 없다** — 설계 §3·§8 이 사이드바 메타에 `2일 전 · 근거 6` 을 적었지만
   *  이번 브랜치는 `근거 6` 만 그린다. 상대 시각 포매터가 저장소에 없고, 설명을 만드는 계층이
   *  없어 이 값에 의미 있는 시각이 들어오지도 않는다. 생성 계획이 그 둘을 함께 맡는다
   *  (docs/2026-08-29-how-it-works-ui-design.md §3). */
  updatedAt: string
  /** "근거 6". 설명을 통째로 읽지 않고 개수만 보이려고 두는 파생값이다 */
  evidenceCount: number
  /** 검토가 필요한 이유. up-to-date 면 없다. 이 문자열이 사이드바에서 시각 자리를 대신한다 */
  staleReason?: string
}

export type FlowNodeType = 'start' | 'step' | 'decision' | 'success' | 'failure'

export interface FlowEdge {
  targetId: string
  /** 분기 조건의 표시 문구 — "예", "아니오", "실패" */
  condition?: string
}

export interface FlowNode {
  id: string
  /** 흐름도 칸에 그려지는 이름. **22자 안쪽으로 쓴다** — 칸은 고정 크기이고 두 줄까지만 감싸므로
   *  그보다 길면 잘린다(flowLayout.ts 의 NODE_W/NODE_H, styles.css 의 `.hiw-node > span`).
   *  잘리는 것은 칸이 좁아서가 아니라 단계 이름이 문장이 됐다는 뜻이다 — 자세한 설명은
   *  `description` 의 자리이고, 그쪽은 길이 제한이 없다. */
  label: string
  /** 단계를 골랐을 때 오른쪽에 뜨는 "이 단계에서 일어나는 일" */
  description?: string
  type: FlowNodeType
  next: FlowEdge[]
  /** 이 값이 오른쪽 단을 좁히는 열쇠다. 비어 있으면 그 단계는 고를 수 없다 */
  evidenceIds?: string[]
}

export type EvidenceType =
  | 'source-file'
  | 'git-change'
  | 'validation'
  | 'adr'
  | 'decision'
  | 'session'
  | 'job'

export interface ExplanationEvidence {
  id: string
  type: EvidenceType
  label: string
  path?: string
  sessionId?: string
  jobId?: string
  commit?: string
}

/** 결정의 출처. **알약 색이 이 값으로 갈린다** — agent 만 --warn 이고 나머지는 --text-faint 다.
 *  추정을 결정과 같은 무게로 보여 주지 않기 위한 구분이다(스펙 §12) */
export type DecisionSource = 'adr' | 'decision' | 'user' | 'agent'

export interface ExplanationDecision {
  id: string
  title: string
  reason: string
  source: DecisionSource
  /** 알약에 적히는 문구 — "ADR-012", "세션 #140 · 추정" */
  sourceLabel: string
  evidenceIds?: string[]
}

export interface ImplementationRef {
  /** 사람의 말 — "인증 API" */
  role: string
  /** 저장소 상대 경로. 줄 번호를 쓰지 않는다(ADR-005) */
  path: string
  evidenceIds?: string[]
}

export interface ChangeSummary {
  id: string
  /** ISO */
  at: string
  sourceKind: 'session' | 'job'
  sourceId: string
  /** "세션 #182" */
  sourceLabel: string
  /** 기능 관점의 변화 한 문장. 커밋 메시지가 아니다 */
  body: string
  /** 프로젝트 전체 목록에서만 채운다 — 어느 기능의 변화인지 */
  featureName?: string
  evidenceIds?: string[]
}

export interface FeatureExplanation {
  featureId: string
  overview: string
  userFlow: FlowNode[]
  failureFlows: FlowNode[]
  keyDecisions: ExplanationDecision[]
  implementation: ImplementationRef[]
  recentChanges: ChangeSummary[]
  evidence: ExplanationEvidence[]
  /** 사람이 고친 설명. 재생성이 덮지 못한다(스펙 §56) */
  userEdited: boolean
  generatedAt: string
}

/** 프로젝트 하나의 이해 전체. 저장소가 프로젝트 경로 → 이 값으로 들고 있다 */
export interface ProjectUnderstanding {
  features: ProjectFeature[]
  /** featureId → 설명 */
  explanations: Record<string, FeatureExplanation>
  /** 마지막 분석 시각. 한 번도 분석하지 않았으면 없다 */
  analyzedAt?: string
  /** 사이드바 아래 세 줄 — 프로젝트 전체의 최근 변경 */
  recentChanges: ChangeSummary[]
}
