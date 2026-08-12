import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Toast } from './toast'

// 모듈 싱글턴이라 테스트마다 새로 import해 상태를 격리한다
let mod: typeof import('./toast')

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  mod = await import('./toast')
})

afterEach(() => {
  vi.useRealTimers()
})

/** 구독해서 최신 목록을 계속 반영하는 헬퍼 */
function watch(): { items: Toast[]; off: () => void } {
  const box: { items: Toast[]; off: () => void } = { items: [], off: () => {} }
  box.off = mod.subscribe((items) => {
    box.items = items
  })
  return box
}

describe('toast 스토어', () => {
  it('구독 즉시 현재 목록을 준다', () => {
    mod.toast.info('먼저 쌓인 알림')
    const w = watch()
    expect(w.items.map((t) => t.message)).toEqual(['먼저 쌓인 알림'])
  })

  it('kind를 그대로 실어 보낸다', () => {
    const w = watch()
    mod.toast.error('실패')
    mod.toast.success('성공')
    expect(w.items.map((t) => t.kind)).toEqual(['error', 'success'])
  })

  it('info/success는 4초 뒤 자동 소멸한다', () => {
    const w = watch()
    mod.toast.info('안내')
    mod.toast.success('완료')
    expect(w.items).toHaveLength(2)
    vi.advanceTimersByTime(3999)
    expect(w.items).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(w.items).toHaveLength(0)
  })

  it('error는 자동 소멸하지 않는다 — 실패를 놓치면 안 되므로', () => {
    const w = watch()
    mod.toast.error('저장 실패')
    vi.advanceTimersByTime(60_000)
    expect(w.items.map((t) => t.message)).toEqual(['저장 실패'])
  })

  it('dismiss는 해당 항목만 닫는다', () => {
    const w = watch()
    mod.toast.error('첫째')
    mod.toast.error('둘째')
    mod.dismiss(w.items[0].id)
    expect(w.items.map((t) => t.message)).toEqual(['둘째'])
  })

  it('이미 닫힌 id로 dismiss해도 구독자를 깨우지 않는다', () => {
    let calls = 0
    mod.subscribe(() => {
      calls++
    })
    mod.toast.error('하나')
    const seen = calls
    mod.dismiss(9999)
    expect(calls).toBe(seen)
  })

  it('5개를 넘으면 오래된 것부터 버린다', () => {
    const w = watch()
    for (let i = 1; i <= 7; i++) mod.toast.error(`실패 ${i}`)
    expect(w.items.map((t) => t.message)).toEqual(['실패 3', '실패 4', '실패 5', '실패 6', '실패 7'])
  })

  it('상한에 밀려 사라진 알림의 타이머는 남은 목록을 건드리지 않는다', () => {
    const w = watch()
    for (let i = 1; i <= 7; i++) mod.toast.info(`안내 ${i}`)
    vi.advanceTimersByTime(4000)
    expect(w.items).toHaveLength(0)
  })

  it('구독 해제 후에는 갱신을 받지 않는다', () => {
    const w = watch()
    w.off()
    mod.toast.error('해제 후')
    expect(w.items).toHaveLength(0)
  })
})

describe('액션 버튼', () => {
  it('액션이 있으면 info여도 자동 소멸하지 않는다 — 4초면 버튼을 놓친다', () => {
    const w = watch()
    mod.toast.info('업데이트 v0.3.11 준비됨', {
      action: { label: '지금 설치', onClick: () => {} }
    })
    vi.advanceTimersByTime(60_000)
    expect(w.items).toHaveLength(1)
  })

  it('라벨과 핸들러를 그대로 실어 보낸다', () => {
    const onClick = vi.fn()
    const w = watch()
    mod.toast.info('업데이트 v0.3.11 준비됨', { action: { label: '지금 설치', onClick } })
    expect(w.items[0].action?.label).toBe('지금 설치')
    w.items[0].action?.onClick()
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('액션 없는 호출은 예전 그대로 — action이 없고 자동 소멸한다', () => {
    const w = watch()
    mod.toast.success('완료')
    expect(w.items[0].action).toBeUndefined()
    vi.advanceTimersByTime(4000)
    expect(w.items).toHaveLength(0)
  })

  it('✕로 닫으면 액션 토스트도 사라진다 — 무시할 길이 있어야 한다', () => {
    const w = watch()
    mod.toast.info('업데이트 준비됨', { action: { label: '지금 설치', onClick: () => {} } })
    mod.dismiss(w.items[0].id)
    expect(w.items).toHaveLength(0)
  })

  it('닫힐 때 onDismiss가 한 번 불린다 — 캠페인 닫기 ack', () => {
    const onDismiss = vi.fn()
    const w = watch()
    mod.toast.info('새 버전', { action: { label: '다운로드', onClick: () => {} }, onDismiss })
    const id = w.items[0].id
    mod.dismiss(id)
    expect(onDismiss).toHaveBeenCalledOnce()
    // 이미 닫힌 id를 또 닫아도 다시 부르지 않는다
    mod.dismiss(id)
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('자동 소멸하는 토스트도 onDismiss를 부른다 — 타이머 경로도 같은 dismiss를 탄다', () => {
    const onDismiss = vi.fn()
    mod.toast.info('안내', { onDismiss })
    vi.advanceTimersByTime(4000)
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
