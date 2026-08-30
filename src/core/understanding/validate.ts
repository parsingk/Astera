// 설명 생성 에이전트의 출력 검증 — 스펙 §28 의 Schema Validation → Evidence Validation.
//
// **부분 통과를 그대로 싣지 않는다.** 여기서 떨어지면 그 기능은 generation-failed 가 되고
// 사유가 화면에 남는다. 스펙 §24-11("Do not invent behavior")·§24-12("grounded in supplied
// evidence")의 실행 지점이 이 파일이다 — 계약은 프롬프트가 요구하고, 검증은 여기서 잡는다.
//
// node: import 없음 — 파일 존재 여부는 술어로 받는다. 그래서 이 검증 전체가 fs 없이 전수
// 테스트된다 (transition.ts 가 조상 답을 값으로 받는 것과 같은 갈래다).
import type { FlowNode, FlowNodeType } from './types'

export interface ValidatedExplanation {
  overview: string
  userFlow: FlowNode[]
  failureFlows: FlowNode[]
  keyDecisions: { title: string; reason: string; sourceLabel: string }[]
  implementation: { role: string; path: string }[]
  evidencePaths: string[]
  needsReview: boolean
  needsReviewReason?: string
}

export type ValidationResult =
  | { ok: true; value: ValidatedExplanation }
  | { ok: false; reason: string }

const NODE_TYPES: readonly FlowNodeType[] = ['start', 'step', 'decision', 'success', 'failure']

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

const bad = (reason: string): ValidationResult => ({ ok: false, reason })

/** 흐름도 한 칸. label 22자 규칙은 여기서 **자르지 않고 거부한다** — 잘라 실으면 화면에는
 *  말없이 뭉개진 이름이 남고, 거부하면 에이전트가 description 으로 옮겨 다시 온다 */
function readNode(v: unknown, at: string): FlowNode | string {
  if (!isObj(v)) return `${at}: 흐름 칸이 객체가 아니다`
  if (!isStr(v.id)) return `${at}: id 가 없다`
  if (!isStr(v.label)) return `${at}: label 이 없다`
  if (v.label.length > 22) return `${at}: label 이 22자를 넘는다 ("${v.label.slice(0, 30)}…")`
  if (!NODE_TYPES.includes(v.type as FlowNodeType)) return `${at}: type "${String(v.type)}" 은 없는 종류다`
  if (!Array.isArray(v.next)) return `${at}: next 가 배열이 아니다`
  const next: FlowNode['next'] = []
  for (const e of v.next) {
    if (!isObj(e) || !isStr(e.targetId)) return `${at}: next 의 간선이 targetId 를 잃었다`
    next.push(
      typeof e.condition === 'string'
        ? { targetId: e.targetId, condition: e.condition }
        : { targetId: e.targetId }
    )
  }
  return {
    id: v.id,
    label: v.label,
    type: v.type as FlowNodeType,
    description: typeof v.description === 'string' ? v.description : undefined,
    next
  }
}

function readFlow(v: unknown, name: string): FlowNode[] | string {
  if (!Array.isArray(v)) return `${name} 이 배열이 아니다`
  const nodes: FlowNode[] = []
  for (let i = 0; i < v.length; i++) {
    const n = readNode(v[i], `${name}[${i}]`)
    if (typeof n === 'string') return n
    nodes.push(n)
  }
  // 간선이 없는 칸을 가리키면 화면의 배치가 실패한다 — 지금 잡는 편이 낫다
  const ids = new Set(nodes.map((n) => n.id))
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

  const userFlow = readFlow(raw.userFlow, 'userFlow')
  if (typeof userFlow === 'string') return bad(userFlow)
  if (userFlow.length === 0) return bad('userFlow 가 비어 있다 — 흐름 없는 설명은 화면이 그릴 것이 없다')
  const failureFlows = readFlow(raw.failureFlows ?? [], 'failureFlows')
  if (typeof failureFlows === 'string') return bad(failureFlows)

  if (!Array.isArray(raw.keyDecisions)) return bad('keyDecisions 가 배열이 아니다')
  const keyDecisions: ValidatedExplanation['keyDecisions'] = []
  for (const d of raw.keyDecisions) {
    if (!isObj(d) || !isStr(d.title) || !isStr(d.reason) || !isStr(d.sourceLabel))
      return bad('keyDecisions 항목이 title/reason/sourceLabel 을 잃었다')
    keyDecisions.push({ title: d.title, reason: d.reason, sourceLabel: d.sourceLabel })
  }

  if (!Array.isArray(raw.implementation) || raw.implementation.length === 0)
    return bad('implementation 이 비어 있다 — 근거 없는 설명이다 (§24-12)')
  const implementation: ValidatedExplanation['implementation'] = []
  for (const i of raw.implementation) {
    if (!isObj(i) || !isStr(i.role) || !isStr(i.path))
      return bad('implementation 항목이 role/path 를 잃었다')
    implementation.push({ role: i.role, path: i.path })
  }

  if (!Array.isArray(raw.evidencePaths) || raw.evidencePaths.some((p) => !isStr(p)))
    return bad('evidencePaths 가 문자열 배열이 아니다')
  const evidencePaths = raw.evidencePaths as string[]

  // **유령 경로 하나면 전체를 거부한다.** 하나쯤 눈감으면 "몇 개까지 괜찮은가"라는 답 없는
  // 질문이 생긴다 — 실재하는 경로만 대는 것은 에이전트가 지킬 수 있는 계약이다
  for (const p of [...implementation.map((i) => i.path), ...evidencePaths])
    if (!fileExists(p)) return bad(`실재하지 않는 경로를 근거로 댔다: ${p}`)

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
