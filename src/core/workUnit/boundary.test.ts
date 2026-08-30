import { describe, it, expect } from 'vitest'
import { decideBoundary } from './boundary'

describe('decideBoundary — 새 사용자 메시지가 왔을 때 (WU §13)', () => {
  it('Case A — 열린 Unit 이 없으면 새로 연다', () => {
    expect(decideBoundary(null)).toEqual({ kind: 'open' })
  })

  it('Case B — 완료 후보면 그것을 확정하고 새로 연다', () => {
    expect(decideBoundary('completed-candidate')).toEqual({ kind: 'close-and-open' })
  })

  it('Case C — 진행 중이면 그 Unit 에 붙인다', () => {
    expect(decideBoundary('active')).toEqual({ kind: 'append' })
  })

  it('닫힌 상태가 들어오면 열린 Unit 이 없는 것으로 본다', () => {
    expect(decideBoundary('completed')).toEqual({ kind: 'open' })
    expect(decideBoundary('abandoned')).toEqual({ kind: 'open' })
  })

  // "V1 은 메시지를 분류하지 않는다"는 사실은 여기서 테스트하지 않는다 — 그것은 함수가 메시지를
  // **받지 않는다**는 타입 수준의 사실이고, boundary.ts 의 함수 주석이 제자리에서 말한다. 위의
  // Case C 와 같은 단언을 되풀이하는 테스트는 독립적으로 실패할 수 없어 지웠다.
})
