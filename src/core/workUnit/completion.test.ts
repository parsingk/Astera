import { describe, it, expect } from 'vitest'
import { onAgentIdle, onBoundaryConfirm, onFeatureDisabled, onSessionEnd } from './completion'

describe('onAgentIdle — 에이전트가 조용해졌을 때', () => {
  it('바뀐 것이 있으면 완료 후보가 된다', () => {
    expect(onAgentIdle({ status: 'active', observedChangeCount: 3, idleSignalTrusted: true })).toBe(
      'completed-candidate'
    )
  })

  it('바뀐 것이 없으면 그대로 진행 중이다 — 생각만 하다 멈춘 것일 수 있다', () => {
    expect(onAgentIdle({ status: 'active', observedChangeCount: 0, idleSignalTrusted: true })).toBe(
      'active'
    )
  })

  // busyTitleReliable 이 false 인 프로바이더 (ProviderDescriptor)
  it('유휴 신호를 믿을 수 없는 프로바이더면 아무것도 하지 않는다', () => {
    expect(onAgentIdle({ status: 'active', observedChangeCount: 3, idleSignalTrusted: false })).toBe(
      'active'
    )
  })

  it('이미 완료 후보면 그대로다 — 두 번 올라가지 않는다', () => {
    expect(
      onAgentIdle({ status: 'completed-candidate', observedChangeCount: 5, idleSignalTrusted: true })
    ).toBe('completed-candidate')
  })
})

describe('onBoundaryConfirm — 다음 사용자 메시지가 앞 Unit 을 확정할 때 (WU §6)', () => {
  it('완료 후보는 완료가 된다', () => {
    expect(onBoundaryConfirm('completed-candidate')).toBe('completed')
  })
})

describe('onSessionEnd — 세션이 끝났을 때 (WU §14-4)', () => {
  it('바뀐 것이 있었으면 완료다', () => {
    expect(onSessionEnd({ observedChangeCount: 2 })).toBe('completed')
  })

  it('아무것도 안 바뀌었으면 버린다 — 질문만 하다 끝난 Unit 이다 (스펙 §7)', () => {
    expect(onSessionEnd({ observedChangeCount: 0 })).toBe('abandoned')
  })
})

describe('onFeatureDisabled — 기능을 껐을 때 (스펙 §16.1)', () => {
  it('세션 종료와 같게 다룬다 — 관찰이 멈추므로 더 정교해질 길이 없다', () => {
    expect(onFeatureDisabled({ observedChangeCount: 2 })).toBe('completed')
    expect(onFeatureDisabled({ observedChangeCount: 0 })).toBe('abandoned')
  })

  it('완료 후보로 남기지 않는다 — 확정해 줄 다음 메시지가 오지 않는다', () => {
    expect(onFeatureDisabled({ observedChangeCount: 1 })).not.toBe('completed-candidate')
  })
})
