import { describe, it, expect } from 'vitest'
import { accountToDispatchOn } from './dispatchAccount'
import type { Account } from '../types'

const acc = (id: string, createdAt: string, provider?: Account['provider']): Account => ({
  id,
  label: id,
  configDir: `/cfg/${id}`,
  color: '#000',
  createdAt,
  ...(provider ? { provider } : {})
})

// provider 없는 계정은 claude 다(types.ts 의 Account.provider 주석 — 기존 accounts.json 호환)
const claudeA = acc('a', '2026-01-01T00:00:00.000Z')
const claudeB = acc('b', '2026-02-01T00:00:00.000Z')
const codexC = acc('c', '2026-01-15T00:00:00.000Z', 'codex')
const all = [claudeA, claudeB, codexC]
const loggedIn = (...ids: string[]): Set<string> => new Set(ids)

describe('accountToDispatchOn', () => {
  // 지정이 없으면 지금까지의 동작이 그대로여야 한다 — CLI 로 만든 Task 와 이 필드가 생기기 전의
  // Task 가 전부 이 갈래로 온다
  it('지정이 없으면 그 provider 의 기본 계정이다', () => {
    const r = accountToDispatchOn({ provider: 'claude', accounts: all, loggedInIds: loggedIn('a', 'b') })
    expect(r).toEqual({ ok: true, accountId: 'a' })
  })

  it('지정이 없고 그 provider 에 로그인된 계정이 없으면 실패다', () => {
    const r = accountToDispatchOn({ provider: 'claude', accounts: all, loggedInIds: loggedIn('c') })
    expect(r).toEqual({ ok: false, reason: 'none-logged-in' })
  })

  it('지정이 있고 로그인돼 있으면 그것이다 — 기본 계정보다 우선한다', () => {
    const r = accountToDispatchOn({
      assigned: 'b',
      provider: 'claude',
      accounts: all,
      loggedInIds: loggedIn('a', 'b')
    })
    expect(r).toEqual({ ok: true, accountId: 'b' })
  })

  // **기본 계정으로 조용히 넘기지 않는다.** 사용자가 이 계정을 고른 것은 다른 계정을 피하려는
  // 뜻일 수 있고, 말없이 갈아타면 그가 아끼려던 계정에 일이 간다. 부르는 쪽이 Gate 를 연다
  it('지정한 계정이 로그인 안 돼 있으면 실패다 — 기본 계정으로 넘기지 않는다', () => {
    const r = accountToDispatchOn({
      assigned: 'b',
      provider: 'claude',
      accounts: all,
      loggedInIds: loggedIn('a')
    })
    expect(r).toEqual({ ok: false, reason: 'assigned-unusable' })
  })

  it('지정한 계정이 지워졌으면 실패다', () => {
    const r = accountToDispatchOn({
      assigned: 'gone',
      provider: 'claude',
      accounts: all,
      loggedInIds: loggedIn('a', 'b')
    })
    expect(r).toEqual({ ok: false, reason: 'assigned-unusable' })
  })

  // 서버의 task-create 가 이 조합을 거절하지만 **입력은 명령이 아니라 파일이다** —
  // orchestration.json 은 프로세스보다 오래 살고 손으로 고쳐진다. schedule.ts 가 provider 없는 Run 을
  // 다루는 것과, graph.ts 가 순환을 다루는 것과 같은 이유다
  it('지정한 계정이 다른 provider 면 실패다 — 파일이 손으로 고쳐질 수 있다', () => {
    const r = accountToDispatchOn({
      assigned: 'c',
      provider: 'claude',
      accounts: all,
      loggedInIds: loggedIn('a', 'b', 'c')
    })
    expect(r).toEqual({ ok: false, reason: 'assigned-unusable' })
  })
})
