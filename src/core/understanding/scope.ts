// 흐름의 한 단계를 골랐을 때 오른쪽 단이 무엇으로 좁혀지는가. 겹침 판정 하나뿐이지만
// 규칙이므로 core 에 둔다.
import type { ExplanationDecision, FlowNode, ImplementationRef, RecordExplanation } from './types'

export interface ScopedView {
  node: FlowNode
  decisions: ExplanationDecision[]
  implementation: ImplementationRef[]
}

/** 근거가 없는 단계는 고를 수 없다. **비활성으로 그리는 것이 아니라 클릭 자체를 막는다** —
 *  눌러도 오른쪽이 비어 있으면 사용자는 자기가 무엇을 잘못했는지 묻게 된다. */
export const isScopable = (node: FlowNode): boolean => (node.evidenceIds?.length ?? 0) > 0

const overlaps = (a: readonly string[] | undefined, b: readonly string[]): boolean =>
  (a ?? []).some((id) => b.includes(id))

export function scopeToStep(x: RecordExplanation, nodeId: string): ScopedView | null {
  const node = x.flow.find((n) => n.id === nodeId)
  if (!node || !isScopable(node)) return null
  const ids = node.evidenceIds ?? []
  return {
    node,
    decisions: x.decisions.filter((d) => overlaps(d.evidenceIds, ids)),
    implementation: x.implementation.filter((i) => overlaps(i.evidenceIds, ids))
  }
}
