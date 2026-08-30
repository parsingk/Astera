// 설명 생성 에이전트의 출력 검증 — 스펙 §28 의 Schema Validation → Evidence Validation.
//
// **부분 통과를 그대로 싣지 않는다.** 여기서 떨어지면 그 기능은 generation-failed 가 되고
// 사유가 화면에 남는다. 스펙 §24-11("Do not invent behavior")·§24-12("grounded in supplied
// evidence")의 실행 지점이 이 파일이다 — 계약은 프롬프트가 요구하고, 검증은 여기서 잡는다.
//
// node: import 없음 — 파일 존재 여부는 술어로 받는다. 그래서 이 검증 전체가 fs 없이 전수
// 테스트된다 (transition.ts 가 조상 답을 값으로 받는 것과 같은 갈래다).
import type { FlowNode, FlowNodeType } from './types'
import { evidenceIdOf } from './evidence'

export interface ValidatedExplanation {
  overview: string
  userFlow: FlowNode[]
  failureFlows: FlowNode[]
  keyDecisions: { title: string; reason: string; sourceLabel: string; evidenceIds?: string[] }[]
  implementation: { role: string; path: string; evidenceIds?: string[] }[]
  /** 위 셋이 댄 경로까지 모두 합친 것 — 근거 목록은 여기서 만들어진다 */
  evidencePaths: string[]
  needsReview: boolean
  needsReviewReason?: string
}

export type ValidationResult =
  | { ok: true; value: ValidatedExplanation }
  | { ok: false; reason: string }

const NODE_TYPES: readonly FlowNodeType[] = ['start', 'step', 'decision', 'success', 'failure']

/** 분기 조건 문구의 한도. **칸 이름(22자)보다 짧다** — 이 문구가 앉는 자리는 상자와 상자 사이
 *  30px 이고, 상자 폭(150px)을 넘으면 옆 갈래 위로 삐져나온다. 10px 고정폭 한글로 열두 자면
 *  그 폭을 채운다.
 *
 *  **자르지 않고 거부하는 것**은 칸 이름과 같은 이유다. 다만 한도는 넉넉하다: 실측에서 에이전트가
 *  쓴 가장 긴 조건이 열여덟 자였고("한도에 도달하고 다음 계정이 있음"), 그것 하나로 3~4분짜리
 *  생성을 통째로 버리는 것은 값이 맞지 않는다. 여기서 잡으려는 것은 문장이 된 조건이다 —
 *  짧게 쓰라는 요구는 프롬프트가 하고, 이 줄은 그 요구가 완전히 무시됐을 때만 선다. */
export const MAX_CONDITION = 20

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

const bad = (reason: string): ValidationResult => ({ ok: false, reason })

/** 항목 하나가 댄 근거 경로를 id 로 바꾼다. **비어 있으면 undefined 다** — 빈 배열을 실으면
 *  "근거가 있다"고 말하면서 아무것도 가리키지 않는 단계가 되고, 그 단계는 눌러도 오른쪽이 비어
 *  있다(scope.ts 의 isScopable 이 개수로 판단한다).
 *
 *  @param sink 본 경로를 여기에 모은다 — 실재 여부는 부르는 쪽이 한꺼번에 묻고, 근거 목록도
 *    그 합집합에서 만들어진다. 항목이 위쪽 evidencePaths 에 없는 파일을 대도 거부하지 않는 이유:
 *    그 경로도 실재 검사를 그대로 지나므로 거짓이 실릴 길은 없고, 거부는 설명 전체를 버린다. */
function readEvidenceIds(v: unknown, at: string, sink: string[]): string[] | undefined | { err: string } {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v) || v.some((p) => !isStr(p))) return { err: `${at}: evidencePaths 가 문자열 배열이 아니다` }
  const paths = v as string[]
  for (const p of paths) sink.push(p)
  return paths.length > 0 ? paths.map(evidenceIdOf) : undefined
}

/** 흐름도 한 칸. label 22자 규칙은 여기서 **자르지 않고 거부한다** — 잘라 실으면 화면에는
 *  말없이 뭉개진 이름이 남고, 거부하면 에이전트가 description 으로 옮겨 다시 온다 */
function readNode(v: unknown, at: string, sink: string[]): FlowNode | string {
  if (!isObj(v)) return `${at}: 흐름 칸이 객체가 아니다`
  if (!isStr(v.id)) return `${at}: id 가 없다`
  if (!isStr(v.label)) return `${at}: label 이 없다`
  if (v.label.length > 22) return `${at}: label 이 22자를 넘는다 ("${v.label.slice(0, 30)}…")`
  if (!NODE_TYPES.includes(v.type as FlowNodeType)) return `${at}: type "${String(v.type)}" 은 없는 종류다`
  if (!Array.isArray(v.next)) return `${at}: next 가 배열이 아니다`
  const next: FlowNode['next'] = []
  for (const e of v.next) {
    if (!isObj(e) || !isStr(e.targetId)) return `${at}: next 의 간선이 targetId 를 잃었다`
    if (typeof e.condition === 'string' && e.condition.length > MAX_CONDITION)
      return `${at}: 분기 조건이 ${MAX_CONDITION}자를 넘는다 ("${e.condition.slice(0, 30)}…") — 조건은 문장이 아니라 딱지다`
    next.push(
      typeof e.condition === 'string'
        ? { targetId: e.targetId, condition: e.condition }
        : { targetId: e.targetId }
    )
  }
  const evidenceIds = readEvidenceIds(v.evidencePaths, at, sink)
  if (evidenceIds !== undefined && !Array.isArray(evidenceIds)) return evidenceIds.err
  return {
    id: v.id,
    label: v.label,
    type: v.type as FlowNodeType,
    description: typeof v.description === 'string' ? v.description : undefined,
    next,
    evidenceIds
  }
}

/**
 * @param known 간선이 가리켜도 되는 id 들. 주지 않으면 자기 안에서만 풀린다.
 *
 *  **두 흐름의 규칙이 다르다.** `userFlow` 는 화면에 그래프로 그려지므로(FlowDiagram → layoutFlow)
 *  없는 칸을 가리키면 선이 허공으로 간다 — 자기 안에서 닫혀 있어야 한다. `failureFlows` 는 목록으로
 *  그려질 뿐 간선을 그리지 않으므로, 본류로 돌아가는 간선을 가졌다고 해서 설명 전체를 버릴 이유가
 *  없다. 실제로 그것 때문에 216초짜리 생성 하나가 통째로 버려졌다(실측).
 */
function readFlow(v: unknown, name: string, sink: string[], known?: Set<string>): FlowNode[] | string {
  if (!Array.isArray(v)) return `${name} 이 배열이 아니다`
  const nodes: FlowNode[] = []
  for (let i = 0; i < v.length; i++) {
    const n = readNode(v[i], `${name}[${i}]`, sink)
    if (typeof n === 'string') return n
    nodes.push(n)
  }
  // 간선이 없는 칸을 가리키면 화면의 배치가 실패한다 — 지금 잡는 편이 낫다
  const ids = known ?? new Set(nodes.map((n) => n.id))
  for (const n of nodes)
    for (const e of n.next)
      if (!ids.has(e.targetId)) return `${name}: ${n.id} 가 없는 칸 ${e.targetId} 를 가리킨다`
  return nodes
}

/**
 * @param fileExists 저장소 상대 경로가 실재하는가 — 부르는 쪽(main)이 fs 로 답한다.
 *   **근거 검증의 요점이다**: 에이전트가 대는 경로가 유령이면 그 설명은 §24-12 를 어긴 것이다.
 */
export function validateExplanation(
  raw: unknown,
  fileExists: (repoRelativePath: string) => boolean
): ValidationResult {
  if (!isObj(raw)) return bad('출력이 JSON 객체가 아니다')
  if (!isStr(raw.overview)) return bad('overview 가 없다')

  // 항목들이 댄 근거 경로가 여기 모인다 — 실재 검사도, 근거 목록도 이 합집합에서 나온다
  const cited: string[] = []
  const userFlow = readFlow(raw.userFlow, 'userFlow', cited)
  if (typeof userFlow === 'string') return bad(userFlow)
  if (userFlow.length === 0) return bad('userFlow 가 비어 있다 — 흐름 없는 설명은 화면이 그릴 것이 없다')
  const failureFlows = readFlow(
    raw.failureFlows ?? [],
    'failureFlows',
    cited,
    // 본류로 돌아가는 간선을 허용한다 — 위 readFlow 의 주석. 자기 자신도 포함해야 하므로
    // 먼저 id 만 훑어 모은다(그 배열은 아직 검증 전이라 모양을 믿지 않고 방어적으로 읽는다)
    new Set([
      ...userFlow.map((n) => n.id),
      ...(Array.isArray(raw.failureFlows) ? raw.failureFlows : []).flatMap((n) =>
        isObj(n) && isStr(n.id) ? [n.id] : []
      )
    ])
  )
  if (typeof failureFlows === 'string') return bad(failureFlows)

  if (!Array.isArray(raw.keyDecisions)) return bad('keyDecisions 가 배열이 아니다')
  const keyDecisions: ValidatedExplanation['keyDecisions'] = []
  for (const d of raw.keyDecisions) {
    if (!isObj(d) || !isStr(d.title) || !isStr(d.reason) || !isStr(d.sourceLabel))
      return bad('keyDecisions 항목이 title/reason/sourceLabel 을 잃었다')
    const ids = readEvidenceIds(d.evidencePaths, 'keyDecisions', cited)
    if (ids !== undefined && !Array.isArray(ids)) return bad(ids.err)
    keyDecisions.push({ title: d.title, reason: d.reason, sourceLabel: d.sourceLabel, evidenceIds: ids })
  }

  if (!Array.isArray(raw.implementation) || raw.implementation.length === 0)
    return bad('implementation 이 비어 있다 — 근거 없는 설명이다 (§24-12)')
  const implementation: ValidatedExplanation['implementation'] = []
  for (const i of raw.implementation) {
    if (!isObj(i) || !isStr(i.role) || !isStr(i.path))
      return bad('implementation 항목이 role/path 를 잃었다')
    const ids = readEvidenceIds(i.evidencePaths, 'implementation', cited)
    if (ids !== undefined && !Array.isArray(ids)) return bad(ids.err)
    // **대지 않았으면 자기 경로가 곧 근거다.** 구현 참조는 "이 기능이 이 파일에 산다"는 말이라
    // 그 파일 말고 다른 근거가 있을 수 없다. 이 기본값이 없으면 단계를 눌렀을 때 "이 단계의 구현"
    // 칸이 늘 비고, 그것은 에이전트가 한 줄을 빠뜨렸다는 이유로 화면이 반쯤 죽는 것이다.
    implementation.push({ role: i.role, path: i.path, evidenceIds: ids ?? [evidenceIdOf(i.path)] })
  }

  if (!Array.isArray(raw.evidencePaths) || raw.evidencePaths.some((p) => !isStr(p)))
    return bad('evidencePaths 가 문자열 배열이 아니다')
  // 위쪽 목록과 항목들이 댄 것을 합친다 — 근거 목록이 이것으로 만들어지므로, 여기 없는 경로를
  // 가리키는 evidenceIds 는 아무것도 가리키지 않는 id 가 된다
  const evidencePaths = [
    ...new Set([...(raw.evidencePaths as string[]), ...cited, ...implementation.map((i) => i.path)])
  ]

  // **유령 경로 하나면 전체를 거부한다.** 하나쯤 눈감으면 "몇 개까지 괜찮은가"라는 답 없는
  // 질문이 생긴다 — 실재하는 경로만 대는 것은 에이전트가 지킬 수 있는 계약이다
  for (const p of evidencePaths) if (!fileExists(p)) return bad(`실재하지 않는 경로를 근거로 댔다: ${p}`)

  const needsReview = raw.needsReview === true
  const needsReviewReason = typeof raw.needsReviewReason === 'string' ? raw.needsReviewReason : undefined
  if (needsReview && !isStr(needsReviewReason))
    return bad('needsReview 인데 사유가 없다 — §24-13 은 사유까지가 계약이다')

  return {
    ok: true,
    value: { overview: raw.overview, userFlow, failureFlows, keyDecisions, implementation, evidencePaths, needsReview, needsReviewReason }
  }
}

/** 첫 분석(기능 목록 초안) 출력 검증 — 스펙 §21 */
export interface ValidatedDiscovery {
  features: { name: string; summary: string; implementationPaths: string[] }[]
}

export function validateDiscovery(
  raw: unknown,
  dirOrFileExists: (repoRelativePath: string) => boolean
): { ok: true; value: ValidatedDiscovery } | { ok: false; reason: string } {
  if (!isObj(raw) || !Array.isArray(raw.features)) return { ok: false, reason: 'features 배열이 없다' }
  if (raw.features.length === 0) return { ok: false, reason: '기능이 하나도 없다 — 빈 초안은 초안이 아니다' }
  const features: ValidatedDiscovery['features'] = []
  for (const f of raw.features) {
    if (!isObj(f) || !isStr(f.name) || !isStr(f.summary)) return { ok: false, reason: '기능 항목이 name/summary 를 잃었다' }
    if (!Array.isArray(f.implementationPaths) || f.implementationPaths.length === 0)
      return { ok: false, reason: `"${f.name}" 에 구현 경로가 없다 — 매핑이 설 자리가 없다` }
    for (const p of f.implementationPaths) {
      if (!isStr(p)) return { ok: false, reason: `"${f.name}" 의 구현 경로가 문자열이 아니다` }
      if (!dirOrFileExists(p)) return { ok: false, reason: `"${f.name}" 이 실재하지 않는 경로를 댔다: ${p}` }
    }
    features.push({ name: f.name, summary: f.summary, implementationPaths: f.implementationPaths as string[] })
  }
  return { ok: true, value: { features } }
}
