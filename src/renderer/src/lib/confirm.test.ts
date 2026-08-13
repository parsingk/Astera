import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingConfirm } from './confirm'

// 모듈 싱글턴이라 테스트마다 새로 import해 상태를 격리한다
let mod: typeof import('./confirm')

beforeEach(async () => {
  vi.resetModules()
  mod = await import('./confirm')
})

function watch(): { pending: PendingConfirm | null } {
  const box: { pending: PendingConfirm | null } = { pending: null }
  mod.subscribe((p) => {
    box.pending = p
  })
  return box
}

const REQUEST = { title: '저장하지 않은 변경', body: '닫을까요?', confirmLabel: '닫기' }

describe('confirm 스토어', () => {
  it('요청하면 구독자에게 내용이 전달되고 열림 상태가 된다', () => {
    const w = watch()
    void mod.confirmModal(REQUEST)
    expect(w.pending?.title).toBe('저장하지 않은 변경')
    expect(w.pending?.confirmLabel).toBe('닫기')
    expect(mod.isConfirmOpen()).toBe(true)
  })

  it('확인하면 true로 resolve하고 닫힌다', async () => {
    const w = watch()
    const answer = mod.confirmModal(REQUEST)
    mod.settle(true)
    await expect(answer).resolves.toBe(true)
    expect(w.pending).toBeNull()
    expect(mod.isConfirmOpen()).toBe(false)
  })

  it('취소하면 false로 resolve한다', async () => {
    const answer = mod.confirmModal(REQUEST)
    mod.settle(false)
    await expect(answer).resolves.toBe(false)
  })

  it('이미 열려 있으면 두 번째 요청은 즉시 취소된다 — 탭 ✕ 연타로 모달이 겹치지 않게', async () => {
    const first = mod.confirmModal(REQUEST)
    const second = mod.confirmModal({ title: '다른 확인', body: '진행할까요?' })
    await expect(second).resolves.toBe(false)
    // 첫 요청은 살아 있어야 한다
    expect(mod.isConfirmOpen()).toBe(true)
    mod.settle(true)
    await expect(first).resolves.toBe(true)
  })

  it('닫힌 뒤에는 새 요청을 받는다', async () => {
    mod.settle(true) // 열린 게 없을 때의 settle은 무시된다
    expect(mod.isConfirmOpen()).toBe(false)
    const answer = mod.confirmModal(REQUEST)
    mod.settle(true)
    await expect(answer).resolves.toBe(true)
  })

  it('같은 요청을 두 번 settle해도 한 번만 처리된다', async () => {
    const answer = mod.confirmModal(REQUEST)
    mod.settle(true)
    mod.settle(false) // pending이 이미 비었으므로 무시
    await expect(answer).resolves.toBe(true)
  })
})
