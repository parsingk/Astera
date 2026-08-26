import { describe, it, expect } from 'vitest'
import { accountToDispatchOn, rollChainFor } from './dispatchAccount'
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
    expect(r).toEqual({ ok: true, accountId: 'a', chain: ['a'] })
  })

  it('지정이 없고 그 provider 에 로그인된 계정이 없으면 실패다', () => {
    const r = accountToDispatchOn({ provider: 'claude', accounts: all, loggedInIds: loggedIn('c') })
    expect(r).toEqual({ ok: false, reason: 'none-logged-in' })
  })

  it('지정이 있고 로그인돼 있으면 그것이다 — 기본 계정보다 우선한다', () => {
    const r = accountToDispatchOn({
      assigned: ['b'],
      provider: 'claude',
      accounts: all,
      loggedInIds: loggedIn('a', 'b')
    })
    expect(r).toEqual({ ok: true, accountId: 'b', chain: ['b'] })
  })

  // **기본 계정으로 조용히 넘기지 않는다.** 사용자가 이 계정을 고른 것은 다른 계정을 피하려는
  // 뜻일 수 있고, 말없이 갈아타면 그가 아끼려던 계정에 일이 간다. 부르는 쪽이 Gate 를 연다
  it('지정한 계정이 로그인 안 돼 있으면 실패다 — 기본 계정으로 넘기지 않는다', () => {
    const r = accountToDispatchOn({
      assigned: ['b'],
      provider: 'claude',
      accounts: all,
      loggedInIds: loggedIn('a')
    })
    expect(r).toEqual({ ok: false, reason: 'assigned-unusable' })
  })

  it('지정한 계정이 지워졌으면 실패다', () => {
    const r = accountToDispatchOn({
      assigned: ['gone'],
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
      assigned: ['c'],
      provider: 'claude',
      accounts: all,
      loggedInIds: loggedIn('a', 'b', 'c')
    })
    expect(r).toEqual({ ok: false, reason: 'assigned-unusable' })
  })

  it('지정한 순서대로 체인을 돌려주고 첫 계정으로 띄운다', () => {
    const r = accountToDispatchOn({
      assigned: ['b', 'a'],
      provider: 'claude',
      accounts: all,
      loggedInIds: loggedIn('a', 'b')
    })
    expect(r).toEqual({ ok: true, accountId: 'b', chain: ['b', 'a'] })
  })

  it('쓸 수 없는 계정만 빼고 나머지 순서로 진행한다 (Gate 를 열지 않는다)', () => {
    const r = accountToDispatchOn({
      assigned: ['a', 'gone', 'b'],
      provider: 'claude',
      accounts: all,
      loggedInIds: loggedIn('a', 'b')
    })
    // 'gone' 은 목록에 없다 — 사람이 고른 것 중 남은 것으로 돈다
    expect(r).toEqual({ ok: true, accountId: 'a', chain: ['a', 'b'] })
  })

  it('provider 가 다른 계정은 체인에서 빠진다', () => {
    const r = accountToDispatchOn({
      assigned: ['a', 'c'],
      provider: 'claude',
      accounts: all,
      loggedInIds: loggedIn('a', 'c')
    })
    expect(r).toEqual({ ok: true, accountId: 'a', chain: ['a'] })
  })

  it('하나도 쓸 수 없으면 기본 계정으로 갈아타지 않고 실패한다', () => {
    const r = accountToDispatchOn({
      assigned: ['gone', 'c'],
      provider: 'claude',
      accounts: all,
      loggedInIds: loggedIn('a', 'c')
    })
    expect(r).toEqual({ ok: false, reason: 'assigned-unusable' })
  })

  it('같은 계정이 두 번 적혀 있으면 한 번으로 접는다 (손으로 고친 파일)', () => {
    const r = accountToDispatchOn({
      assigned: ['a', 'a', 'b'],
      provider: 'claude',
      accounts: all,
      loggedInIds: loggedIn('a', 'b')
    })
    // 같은 계정이 두 칸이면 RollCycle 은 두 계정인 줄 알고 "갈아탄다" — 같은 계정으로
    expect(r).toEqual({ ok: true, accountId: 'a', chain: ['a', 'b'] })
  })

  it('빈 목록은 지정 없음과 같다 — 기본 계정으로 간다', () => {
    const r = accountToDispatchOn({
      assigned: [],
      provider: 'claude',
      accounts: all,
      loggedInIds: loggedIn('a', 'b')
    })
    expect(r).toEqual({ ok: true, accountId: 'a', chain: ['a'] })
  })
})

// 이 규칙이 순수 함수로 나와 있는 이유: 워커를 띄우는 세 길(자동 배치·CLI·검토)이 전부 배선의 한
// 래퍼로 모이는데 그 파일에는 테스트가 닿지 않는다(src/main/ipc.ts). 규칙이 그 안에만 있으면 다음
// 편집을 막아 줄 것이 아무것도 없다
describe('rollChainFor', () => {
  it('둘 다 로그인돼 있으면 요청된 계정 뒤에 적은 순서로 붙인다', () => {
    expect(
      rollChainFor({
        requested: 'a',
        taskAccountIds: ['b'],
        provider: 'claude',
        accounts: all,
        loggedInIds: loggedIn('a', 'b')
      })
    ).toEqual({ chain: ['a', 'b'] })
  })

  it('로그인 안 된 계정은 체인에서 빠진다 — 남은 순서로 돈다', () => {
    expect(
      rollChainFor({
        requested: 'a',
        taskAccountIds: ['b'],
        provider: 'claude',
        accounts: all,
        loggedInIds: loggedIn('a')
      })
    ).toEqual({ chain: ['a'] })
  })

  it('provider 가 다른 계정은 체인에서 빠진다 — 검토 경로가 지금과 같이 도는 이유다', () => {
    expect(
      rollChainFor({
        requested: 'c',
        taskAccountIds: ['a', 'b'],
        provider: 'codex',
        accounts: all,
        loggedInIds: loggedIn('a', 'b', 'c')
      })
    ).toEqual({ chain: ['c'] })
  })

  // 요청된 계정이 첫 칸이 아니면 롤링이 아는 "지금 계정"과 Dispatch 에 기록된 계정이 어긋난다.
  // 그래서 다른 계정이 남아 있어도 그것으로 갈아타지 않고 요청된 계정 하나로 저하한다
  it('요청된 계정을 못 쓰면 남은 계정으로 갈아타지 않고 요청된 계정 하나로 저하한다', () => {
    expect(
      rollChainFor({
        requested: 'a',
        taskAccountIds: ['b'],
        provider: 'claude',
        accounts: all,
        loggedInIds: loggedIn('b')
      })
    ).toEqual({ chain: ['a'], degraded: 'requested-unusable' })
  })

  it('하나도 쓸 수 없으면 요청된 계정 하나로 저하한다', () => {
    expect(
      rollChainFor({
        requested: 'a',
        taskAccountIds: ['gone'],
        provider: 'claude',
        accounts: all,
        loggedInIds: loggedIn('b')
      })
    ).toEqual({ chain: ['a'], degraded: 'nothing-usable' })
  })

  // Task 에 지정이 없는 것이 보통이다 — 그때 답은 요청된 계정 하나로 확정이고, 배선은 이 갈래에서
  // 로그인 조회를 아예 하지 않는다(계정마다 파일·Keychain 읽기가 붙는다)
  it('Task 에 지정이 없으면 요청된 계정 하나다', () => {
    expect(
      rollChainFor({
        requested: 'a',
        provider: 'claude',
        accounts: all,
        loggedInIds: loggedIn('a', 'b')
      })
    ).toEqual({ chain: ['a'] })
  })

  it('빈 목록도 지정 없음과 같다', () => {
    expect(
      rollChainFor({
        requested: 'a',
        taskAccountIds: [],
        provider: 'claude',
        accounts: all,
        loggedInIds: loggedIn('a', 'b')
      })
    ).toEqual({ chain: ['a'] })
  })

  // 요청된 계정이 Task 목록에도 적혀 있는 것은 보통이다(자동 배치가 그 목록의 첫 계정을 요청한다) —
  // 두 칸으로 세면 RollCycle 이 두 계정인 줄 알고 같은 계정으로 "갈아탄다"
  it('요청된 계정이 Task 목록에 또 적혀 있으면 한 칸으로 접는다', () => {
    expect(
      rollChainFor({
        requested: 'a',
        taskAccountIds: ['a', 'b'],
        provider: 'claude',
        accounts: all,
        loggedInIds: loggedIn('a', 'b')
      })
    ).toEqual({ chain: ['a', 'b'] })
  })
})
