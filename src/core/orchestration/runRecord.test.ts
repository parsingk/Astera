import { describe, it, expect } from 'vitest'
import { justFinished } from './runRecord'
import type { OrchState } from './state'

const state = (tasks: { runId: string; status: string; consecutiveFailures?: number }[]): OrchState =>
  ({
    runs: [{ id: 'r1' }, { id: 'r2' }],
    tasks: tasks.map((t, i) => ({ id: `t${i}`, consecutiveFailures: 0, ...t }))
  }) as unknown as OrchState

describe('justFinished', () => {
  it('돌고 있던 Run 이 끝나면 그것을 알린다', () => {
    const before = state([{ runId: 'r1', status: 'dispatched' }])
    const after = state([{ runId: 'r1', status: 'completed' }])
    expect(justFinished(before, after)).toEqual([{ runId: 'r1', outcome: 'completed' }])
  })

  it('실패로 끝난 것도 알린다 — 실패한 작업도 무엇을 했는지 남을 값이 있다', () => {
    const before = state([{ runId: 'r1', status: 'dispatched' }])
    const after = state([{ runId: 'r1', status: 'failed', consecutiveFailures: 3 }])
    expect(justFinished(before, after)).toEqual([{ runId: 'r1', outcome: 'failed' }])
  })

  // The state is recomputed every round (outcomeOf is derived). Catching the state rather than
  // the edge would record the same finished Run on every round, forever.
  it('이미 끝나 있던 Run 은 다시 알리지 않는다', () => {
    const s = state([{ runId: 'r1', status: 'completed' }])
    expect(justFinished(s, s)).toEqual([])
  })

  it('아직 도는 Run 은 알리지 않는다', () => {
    const before = state([{ runId: 'r1', status: 'pending' }])
    const after = state([{ runId: 'r1', status: 'dispatched' }])
    expect(justFinished(before, after)).toEqual([])
  })

  it('여러 Run 이 같은 회차에 끝나도 각각 알린다', () => {
    const before = state([{ runId: 'r1', status: 'dispatched' }, { runId: 'r2', status: 'dispatched' }])
    const after = state([{ runId: 'r1', status: 'completed' }, { runId: 'r2', status: 'completed' }])
    expect(justFinished(before, after).map((x) => x.runId).sort()).toEqual(['r1', 'r2'])
  })

  // A failure with retries left is not terminal — outcomeOf says so, and this pins that.
  it('재시도가 남은 실패는 끝난 것이 아니다', () => {
    const before = state([{ runId: 'r1', status: 'dispatched' }])
    const after = state([{ runId: 'r1', status: 'failed', consecutiveFailures: 1 }])
    expect(justFinished(before, after)).toEqual([])
  })
})
