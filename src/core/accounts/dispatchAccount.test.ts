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

  // **첫 칸과 뒤 칸은 다르게 다룬다.** 아래 두 테스트는 **같은 목록(['a','b'])에 로그인 상태만
  // 뒤집은 짝**이다 — 그래서 위치를 안 보는 구현(어느 쪽이든 남은 것으로 띄운다)은 반드시 한쪽에서
  // 걸린다. `a,b` 는 "a 를 태우고 b 는 a 가 바닥난 뒤에만 건드린다"는 뜻이므로, a 의 로그인이 풀렸을
  // 때 b 로 띄우면 사람이 아끼려던 계정이 그 Task 를 통째로 태운다 — 뒤 칸을 적은 것은 바닥난 뒤에
  // 갈아타도 된다는 동의이고 그것으로 시작해도 된다는 동의가 아니다
  it('첫 칸을 못 쓰면 뒤 칸이 쓸 수 있어도 실패다 — 아끼려던 계정을 올려세우지 않는다', () => {
    const r = accountToDispatchOn({
      assigned: ['a', 'b'],
      provider: 'claude',
      accounts: all,
      loggedInIds: loggedIn('b')
    })
    expect(r).toEqual({ ok: false, reason: 'assigned-unusable' })
  })

  it('첫 칸을 쓸 수 있으면 뒤 칸이 로그아웃돼 있어도 성공한다 — 뒤 칸만 빠진다', () => {
    const r = accountToDispatchOn({
      assigned: ['a', 'b'],
      provider: 'claude',
      accounts: all,
      loggedInIds: loggedIn('a')
    })
    expect(r).toEqual({ ok: true, accountId: 'a', chain: ['a'] })
  })

  // 첫 칸이 "못 쓰는" 세 가지 이유를 모두 같은 답으로 못박는다 — 위 로그아웃과 함께, 지워진 계정과
  // provider 어긋남도 뒤 칸을 올려세우는 이유가 되지 않는다
  it('첫 칸이 지워졌으면 뒤 칸으로 띄우지 않는다', () => {
    const r = accountToDispatchOn({
      assigned: ['gone', 'a'],
      provider: 'claude',
      accounts: all,
      loggedInIds: loggedIn('a', 'b')
    })
    expect(r).toEqual({ ok: false, reason: 'assigned-unusable' })
  })

  it('첫 칸의 provider 가 어긋나면 뒤 칸으로 띄우지 않는다', () => {
    const r = accountToDispatchOn({
      assigned: ['c', 'a'],
      provider: 'claude',
      accounts: all,
      loggedInIds: loggedIn('a', 'b', 'c')
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
  // **기대 체인이 사전순과 어긋나야 이 테스트가 순서를 지킨다.** 이 기능이 있는 이유가 그 순서이므로
  // (사람이 적은 대로 갈아탄다) 정렬하거나 뒤집는 구현이 통과하면 안 된다 — 요청된 계정을 'b' 로
  // 두면 기대값 ['b','a'] 가 정렬(['a','b'])·역정렬(['a','b'])과 모두 다르다
  it('둘 다 로그인돼 있으면 요청된 계정 뒤에 적은 순서로 붙인다 — 사전순이 아니다', () => {
    expect(
      rollChainFor({
        requested: 'b',
        taskAccountIds: ['a'],
        provider: 'claude',
        accounts: all,
        loggedInIds: loggedIn('a', 'b')
      })
    ).toEqual({ chain: ['b', 'a'] })
  })

  // 세 칸을 따로 보는 이유: 두 칸은 **꼬리만** 정렬하는 구현을 잡지 못한다. 이 파일의 계정
  // 픽스처에는 claude 가 둘뿐이라(claudeA·claudeB) 같은 헬퍼로 하나를 더 만들어 쓴다.
  // 기대값 ['b','d','a'] 는 정렬(['a','b','d'])·역정렬(['a','d','b'])·꼬리 정렬(['b','a','d'])과
  // 모두 다르다
  it('세 칸도 적은 순서 그대로다 — 부분 정렬도 아니다', () => {
    const claudeD = acc('d', '2026-03-01T00:00:00.000Z')
    expect(
      rollChainFor({
        requested: 'b',
        taskAccountIds: ['d', 'a'],
        provider: 'claude',
        accounts: [...all, claudeD],
        loggedInIds: loggedIn('a', 'b', 'd')
      })
    ).toEqual({ chain: ['b', 'd', 'a'] })
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

  it('provider 가 다른 계정은 체인에서 빠진다 — 검토 Dispatch 가 그 모양이다', () => {
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
  // 그래서 다른 계정이 남아 있어도 그것으로 갈아타지 않고 요청된 계정 하나로 저하한다.
  // **이 자리가 accountToDispatchOn 의 첫 칸 규칙과 만나는 곳이다**: 요청된 계정이 그 목록의 첫 칸
  // 이므로 그 함수는 이제 실패로 답하고, 이 함수는 그 실패를 여기 적힌 대로 저하로 바꾼다 — 체인을
  // 못 만드는 것이 워커를 못 띄우는 이유가 되어서는 안 된다. 이 갈래의 답은 그 규칙 전과 같아야 한다
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

  // 저하 이유를 가르는 질문은 "**뒤 칸에** 쓸 수 있는 것이 하나라도 있는가"다. 합친 목록을 그대로
  // accountToDispatchOn 에 다시 넣어 가르는 구현은 여기서 틀린다 — 그 목록의 첫 칸('a')도 뒤 첫
  // 칸('gone')도 못 쓰므로 실패로 돌아오고, 'b' 를 쓸 수 있는데도 "하나도 못 쓴다"고 적힌다
  it('요청된 계정과 뒤 첫 칸이 함께 막혀도 쓸 수 있는 칸이 남으면 requested-unusable 이다', () => {
    expect(
      rollChainFor({
        requested: 'a',
        taskAccountIds: ['gone', 'b'],
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

  // 빈 배열과 없음이 **같은 답**이라는 것을 값으로 못박는다 — 위 테스트와 같은 길을 지나므로
  // 값만 다시 단정하면 겹치는 테스트다. 이 등식은 이 함수 밖에서도 규칙이다: state.ts 의
  // createTask 가 빈 배열을 아예 싣지 않고, Task.accountIds 의 JSDoc 이 "없거나 비면" 이라고 적는다
  it('빈 목록과 지정 없음은 같은 답이다', () => {
    const base = {
      requested: 'a',
      provider: 'claude' as const,
      accounts: all,
      loggedInIds: loggedIn('a', 'b')
    }
    expect(rollChainFor({ ...base, taskAccountIds: [] })).toEqual(rollChainFor(base))
    expect(rollChainFor({ ...base, taskAccountIds: [] })).toEqual({ chain: ['a'] })
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
