import { describe, it, expect } from 'vitest'
import {
  accountRemovalBlockers,
  historyResumePlan,
  parseAllowedExternalUrl,
  providerOfSession
} from './ipc'
import { sanitizeResumePrompt } from '../core/sessions/commands'
import type { Account, SessionInfo } from '../core/types'

const account = (over: Partial<Account>): Account =>
  ({
    id: 'acc1',
    label: 'a',
    configDir: 'C:\\cfg',
    color: '#000',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over
  }) as Account

const sess = (id: string, accountId: string): SessionInfo =>
  ({ id, accountId, cwd: 'C:\\p', title: 't', status: 'running' }) as SessionInfo

// usage.session 은 이 값으로 어느 소스를 읽을지 고른다 — codex 는 rollout 감시자,
// claude 는 statusLine 캡처 파일. 잘못 고르면 하단 바가 통째로 빈다.
describe('providerOfSession', () => {
  it('세션이 쓰는 계정의 provider 를 돌려준다', () => {
    const list = [sess('s1', 'acc1'), sess('s2', 'acc2')]
    const get = (id: string): Account =>
      account({ id, provider: id === 'acc2' ? 'codex' : 'claude' })
    expect(providerOfSession('s2', list, get)).toBe('codex')
    expect(providerOfSession('s1', list, get)).toBe('claude')
  })

  // accounts.json 이 provider 를 갖기 전에 만들어진 계정 — providerOf 의 하위 호환 규칙
  it('provider 가 없는 계정은 claude 로 본다', () => {
    expect(providerOfSession('s1', [sess('s1', 'acc1')], () => account({}))).toBe('claude')
  })

  it('목록에 없는 세션은 null', () => {
    expect(providerOfSession('gone', [sess('s1', 'acc1')], () => account({}))).toBeNull()
  })

  // core.accounts.get 은 없는 id 에 대해 throw 한다. 계정을 지운 뒤 탭이 살아 있는 동안 3초마다
  // 들어오는 조회가 예외로 터지면 안 된다.
  it('계정이 사라진 세션은 예외 없이 null', () => {
    expect(
      providerOfSession('s1', [sess('s1', 'acc1')], () => {
        throw new Error('no such account')
      })
    ).toBeNull()
  })
})

// parseAllowedExternalUrl is the scheme allowlist shared by system.openExternal (the markdown
// preview's external-link IPC) and main/index.ts's setWindowOpenHandler/will-navigate guards — see
// its doc comment in ipc.ts for why the two must not drift apart.
describe('parseAllowedExternalUrl — 외부 URL 스킴 화이트리스트', () => {
  it('http/https/mailto는 통과시키고 파싱된 URL을 돌려준다', () => {
    expect(parseAllowedExternalUrl('http://example.com')?.toString()).toBe('http://example.com/')
    expect(parseAllowedExternalUrl('https://example.com/a?b=c')?.toString()).toBe(
      'https://example.com/a?b=c'
    )
    expect(parseAllowedExternalUrl('mailto:a@b.com')?.toString()).toBe('mailto:a@b.com')
  })

  it('허용 목록 밖의 스킴은 null을 돌려준다 — javascript:/file: 모두', () => {
    expect(parseAllowedExternalUrl('javascript:alert(1)')).toBeNull()
    expect(parseAllowedExternalUrl('file:///etc/passwd')).toBeNull()
    expect(parseAllowedExternalUrl('ftp://example.com')).toBeNull()
  })

  it('파싱 자체가 실패하는 문자열은 예외 없이 null을 돌려준다', () => {
    expect(parseAllowedExternalUrl('not a url')).toBeNull()
    expect(parseAllowedExternalUrl('')).toBeNull()
  })

  it('반환값의 toString()은 검증에 쓴 문자열과 같다 — 원래 url을 그대로 다시 쓰지 않기 위해서', () => {
    // new URL이 탭·개행을 걷어내므로, 걷어낸 결과가 그대로 나와야 한다
    expect(parseAllowedExternalUrl('https://example.com/\t')?.toString()).toBe(
      'https://example.com/'
    )
  })
})

// 돌아가는 세션이 쓰는 계정은 지울 수 없다. registry.remove 는 세션을 보지 않고 지우고 get 은 없는
// id 에 던지므로, 지워지면 그 세션은 provider 조회도 롤도 못 한다 — 견디는 코드를 겹치기보다 못
// 지우게 하는 쪽이다.
describe('accountRemovalBlockers', () => {
  const s = (o: Partial<{ accountId: string; rollAccountIds: string[]; status: 'running' | 'exited'; title: string }>) => ({
    accountId: o.accountId ?? 'a1',
    rollAccountIds: o.rollAccountIds,
    status: o.status ?? ('running' as const),
    title: o.title ?? 'tab'
  })

  it('아무 세션도 쓰지 않으면 빈 배열 — 지워도 된다', () => {
    expect(accountRemovalBlockers('a9', [s({ accountId: 'a1' })])).toEqual([])
  })

  it('그 계정으로 돌고 있는 세션을 막는다', () => {
    expect(accountRemovalBlockers('a1', [s({ accountId: 'a1', title: '작업 탭' })])).toEqual(['작업 탭'])
  })

  // 현재 계정만 보면 2계정 체인의 **대기 계정**이 지워지고, a1 이 한도에 걸리는 순간 갈아탈 곳이
  // 없어 롤이 중단된다. 그래서 체인에 담겨 있기만 해도 막는다.
  it('지금 쓰지 않아도 롤링 대기 순서에 있으면 막는다', () => {
    const rows = [s({ accountId: 'a1', rollAccountIds: ['a1', 'a2'], title: '롤링 탭' })]
    expect(accountRemovalBlockers('a2', rows)).toEqual(['롤링 탭'])
  })

  it('종료된 세션은 세지 않는다 — 계정을 붙잡고 있지 않다', () => {
    const rows = [s({ accountId: 'a1', rollAccountIds: ['a1', 'a2'], status: 'exited' })]
    expect(accountRemovalBlockers('a1', rows)).toEqual([])
    expect(accountRemovalBlockers('a2', rows)).toEqual([])
  })

  it('막는 세션이 여럿이면 전부 돌린다 — 사용자가 무엇을 닫아야 할지 알아야 한다', () => {
    const rows = [
      s({ accountId: 'a1', title: '첫째' }),
      s({ accountId: 'a2', rollAccountIds: ['a2', 'a1'], title: '둘째' })
    ]
    expect(accountRemovalBlockers('a1', rows)).toEqual(['첫째', '둘째'])
  })
})

// 사이드바 히스토리 재개(App.tsx → sessions.spawn)가 Smart Resume 을 만나는 자리의 판정.
//
// **왜 순수 함수로 빼는가.** 판정 자체는 spawnSession 안에 있어야 자연스럽지만, 그 함수는
// registerIpc 안의 클로저라 electron 하네스 없이는 닿을 수 없다 — 위 세 헬퍼(providerOfSession,
// parseAllowedExternalUrl, accountRemovalBlockers)가 ipc.ts 에서 export 되어 있는 이유와 같다.
//
// 규칙의 원본은 rolling.ts 와 codexRolling.ts 의 roll() 이다(SPEC §11.5 가 `--resume` 발원지로
// 꼽은 셋 중 둘). 세 번째가 여기다.
describe('historyResumePlan — 사이드바 재개의 백지 재개 판정', () => {
  // 경로는 String.raw 로 적는다 — 이 줄이 담는 것은 실제 파일시스템 경로이고, 평범한 문자열
  // 리터럴로 쓰면 `\t`(탭)·`\s`(s) 같은 이스케이프가 조용히 끼어든다. 그러면 sanitizer 에 걸린
  // 이유가 경로가 아니라 테스트의 오타가 되고, 아래 두 갈래를 가르는 것이 `&` 인지 탭인지
  // 알 수 없게 된다.
  const line = (dir = String.raw`C:\tab-resume`): string =>
    `Continue this session: re-read the resume briefing the app just wrote to ${dir}${String.raw`\s1.md`}, then carry on from where the work already stands.`

  it("'original' 이면 브리핑이 있어도 백지로 가지 않는다", () => {
    const plan = historyResumePlan({ strategy: 'original', provider: 'claude', briefing: line() })
    expect(plan.blankSlate).toBe(false)
  })

  it("'smart' 이고 브리핑이 있으면 백지로 가고, 그 한 줄을 첫 프롬프트로 싣는다", () => {
    const plan = historyResumePlan({ strategy: 'smart', provider: 'claude', briefing: line() })
    expect(plan.blankSlate).toBe(true)
    expect(plan.initialPrompt).toBe(line())
  })

  // 계획의 지배 제약 — 브리핑을 만들 수 없으면 백지 재개를 하지 않는다. 대화를 버리는 대가로
  // 얻는 것이 없기 때문이다.
  it('브리핑을 만들지 못했으면 스위치가 켜져 있어도 백지로 가지 않는다', () => {
    const plan = historyResumePlan({ strategy: 'smart', provider: 'claude', briefing: null })
    expect(plan.blankSlate).toBe(false)
  })

  // codex 는 이 줄을 argv 로 싣는다 — buildCodexCommand 가 아니라 호출부가 sanitize 한다
  // (codexRolling.ts 의 백지 재개와 같은 자리, 같은 이유).
  it('codex 는 sanitize 를 통과한 값을 싣는다', () => {
    const plan = historyResumePlan({ strategy: 'smart', provider: 'codex', briefing: line() })
    expect(plan.blankSlate).toBe(true)
    expect(plan.initialPrompt).toBe(sanitizeResumePrompt(line()))
  })

  // codexRolling.ts 의 fix wave 7, finding 2 와 같은 사고를 막는다: 경로에 `["&|<>^%]` 가 있으면
  // sanitizer 가 그것을 지워 없는 파일을 가리키게 되는데, 백지 세션에는 돌아갈 대화조차 없다.
  // 그럴 때는 백지를 포기하고 복사 + `--resume` 으로 내려간다 — 뭉개진 힌트가 온전한 대화와 함께
  // 도착하면 작은 손해로 끝난다.
  it('codex 에서 포인터가 뭉개지면 백지를 포기하고, 그 사실을 알린다', () => {
    const plan = historyResumePlan({
      strategy: 'smart',
      provider: 'codex',
      briefing: line(String.raw`C:\Users\R&D\tab-resume`)
    })
    expect(plan.blankSlate).toBe(false)
    expect(plan.mangled).toBe(true)
  })

  // 뭉개짐 거부는 codex 만의 사정이다 — claude 는 이 줄을 PTY 가 아니라 argv 로 싣되
  // sanitizer 를 통과시키지 않으므로 `&` 가 그대로 살아 있다.
  it('claude 는 같은 경로에서도 백지로 간다 — sanitizer 를 지나지 않는다', () => {
    const plan = historyResumePlan({
      strategy: 'smart',
      provider: 'claude',
      briefing: line(String.raw`C:\Users\R&D\tab-resume`)
    })
    expect(plan.blankSlate).toBe(true)
    expect(plan.mangled).toBe(false)
  })
})
