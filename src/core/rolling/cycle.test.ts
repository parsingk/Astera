import { describe, it, expect } from 'vitest'
import { RollCycle } from './cycle'

const NOW = 1_000_000

describe('RollCycle', () => {
  it('한도 감지 시 다음 계정으로 순환 롤한다 (1→2→3)', () => {
    const c = new RollCycle(3, 900_000, () => NOW)
    expect(c.onLimit()).toEqual({ type: 'roll', toIndex: 1 })
    c.advanceTo(1)
    expect(c.onLimit()).toEqual({ type: 'roll', toIndex: 2 })
    c.advanceTo(2)
  })

  it('한 사이클(계정 수) 연속 차단이면 15분 대기를 지시한다', () => {
    const c = new RollCycle(3, 900_000, () => NOW)
    c.onLimit()
    c.advanceTo(1)
    c.onLimit()
    c.advanceTo(2)
    expect(c.onLimit()).toEqual({ type: 'wait', retryAt: NOW + 900_000 })
  })

  it('대기 종료 후 다음 계정으로 롤한다 (3→1 순환)', () => {
    const c = new RollCycle(3, 900_000, () => NOW)
    c.onLimit(); c.advanceTo(1)
    c.onLimit(); c.advanceTo(2)
    c.onLimit() // wait
    expect(c.onWaitElapsed()).toEqual({ type: 'roll', toIndex: 0 })
    c.advanceTo(0)
    // 대기 후 재개된 사이클에서도 계속 차단이면 다음 배수(6)에서 다시 wait
    expect(c.onLimit()).toEqual({ type: 'roll', toIndex: 1 })
    c.advanceTo(1)
    expect(c.onLimit()).toEqual({ type: 'roll', toIndex: 2 })
    c.advanceTo(2)
    expect(c.onLimit().type).toBe('wait')
  })

  it('onHealthy는 연속 차단을 리셋한다 — 이후 다시 전체 사이클이 막혀야 wait', () => {
    const c = new RollCycle(2, 900_000, () => NOW)
    expect(c.onLimit()).toEqual({ type: 'roll', toIndex: 1 })
    c.advanceTo(1)
    c.onHealthy()
    expect(c.onLimit()).toEqual({ type: 'roll', toIndex: 0 }) // 리셋됐으므로 wait 아님
    c.advanceTo(0)
    expect(c.onLimit().type).toBe('wait') // 리셋 후 2연속 = 계정 수
  })
})
