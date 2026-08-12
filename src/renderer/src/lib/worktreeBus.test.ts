import { beforeEach, describe, expect, it, vi } from 'vitest'

// 모듈 싱글턴이라 테스트마다 새로 import해 상태를 격리한다
let mod: typeof import('./worktreeBus')

beforeEach(async () => {
  vi.resetModules()
  mod = await import('./worktreeBus')
})

describe('worktreeBus', () => {
  it('구독자에게 생성 알림을 전달한다', () => {
    const calls: number[] = []
    mod.subscribeCreated(() => calls.push(1))
    mod.notifyCreated()
    mod.notifyCreated()
    expect(calls).toEqual([1, 1])
  })

  it('구독 해제 후에는 알림을 받지 않는다', () => {
    const calls: number[] = []
    const off = mod.subscribeCreated(() => calls.push(1))
    off()
    mod.notifyCreated()
    expect(calls).toEqual([])
  })

  it('구독자가 여럿이면 전부에게 전달한다', () => {
    const a: number[] = []
    const b: number[] = []
    mod.subscribeCreated(() => a.push(1))
    mod.subscribeCreated(() => b.push(1))
    mod.notifyCreated()
    expect(a).toEqual([1])
    expect(b).toEqual([1])
  })
})
