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

  // WU §13 은 Case C 에 "명백한 별도 기능 요청이면 새 Unit" 이라는 예외를 두지만 V1 에는 없다.
  // 그 판정은 메시지 분류기를 요구하고(WU §4), WU §17 이 "잘게 나누는 것보다 크게 묶는 편이
  // 낫다"고 방향을 정했다.
  it('V1 은 메시지를 분류하지 않는다 — 진행 중이면 무엇이 오든 같은 Unit 이다', () => {
    // refinement · constraint · correction · question 이 모두 같은 결정을 받는다
    expect(decideBoundary('active')).toEqual({ kind: 'append' })
  })
})
