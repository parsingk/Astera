import { describe, it, expect } from 'vitest'
import { shouldRetryWithBypass, watchFirstLine, BYPASS_ENV, IMMEDIATE_EXIT_MS } from './retryBypass'
import type { ProcLike } from './proc'

describe('shouldRetryWithBypass', () => {
  it('말없이 즉사하면 재시도한다', () => {
    expect(shouldRetryWithBypass({ attempt: 0, sawProtocolLine: false, elapsedMs: 300 })).toBe(true)
  })

  // 한 줄이라도 말했으면 실행은 된 것이다. 그 뒤의 죽음은 CLI 자신의 사정이고 우회가 고칠 것이 아니다
  it('프로토콜을 한 줄이라도 말했으면 재시도하지 않는다', () => {
    expect(shouldRetryWithBypass({ attempt: 0, sawProtocolLine: true, elapsedMs: 300 })).toBe(false)
  })

  // 한참 살아 있다 죽은 것은 실행 거절이 아니다
  it('오래 살아 있었으면 재시도하지 않는다', () => {
    expect(shouldRetryWithBypass({ attempt: 0, sawProtocolLine: false, elapsedMs: IMMEDIATE_EXIT_MS + 1 })).toBe(false)
  })

  it('두 번은 없다', () => {
    expect(shouldRetryWithBypass({ attempt: 1, sawProtocolLine: false, elapsedMs: 100 })).toBe(false)
  })

  it('우회 env 는 Volta 것 하나뿐 — 증거가 있는 것만 넣는다', () => {
    expect(BYPASS_ENV).toEqual({ VOLTA_BYPASS: '1' })
  })
})

describe('watchFirstLine', () => {
  // ProcLike.onLine 은 구독자가 하나뿐인 setter 라, 매니저가 따로 붙으면 어댑터의 것을 빼앗는다.
  // 감싸서 지나가는 길에 세는 것이 그래서 필요하다.
  it('감싼 proc 은 줄을 그대로 흘려보내면서 본 적 있는지 기억한다', () => {
    let emit: (l: string) => void = () => {}
    const inner = {
      pid: 1,
      onLine: (cb: (l: string) => void) => { emit = cb },
      onExit: () => {},
      write: () => {},
      kill: () => {}
    } as ProcLike
    const w = watchFirstLine(inner)
    const seen: string[] = []
    w.proc.onLine((l) => seen.push(l))
    expect(w.sawLine()).toBe(false)
    emit('{"jsonrpc":"2.0"}')
    expect(seen).toEqual(['{"jsonrpc":"2.0"}'])
    expect(w.sawLine()).toBe(true)
  })

  // pid 는 Host 가 답하기 전엔 0 이고 답한 뒤 바뀐다; outlivesApp 은 createProcRouter 가 나중에 찍는다.
  // 감싸는 시점에 스프레드로 복사했다면 둘 다 그 순간 값에 멈춰 버린다.
  it('pid·outlivesApp 은 스냅샷이 아니라 실제 proc 을 계속 따라간다', () => {
    const inner = {
      pid: 0,
      onLine: () => {},
      onExit: () => {},
      write: () => {},
      kill: () => {}
    } as ProcLike
    const w = watchFirstLine(inner)
    expect(w.proc.pid).toBe(0)
    expect(w.proc.outlivesApp).toBeUndefined()
    inner.pid = 4242
    inner.outlivesApp = true
    expect(w.proc.pid).toBe(4242)
    expect(w.proc.outlivesApp).toBe(true)
  })
})
