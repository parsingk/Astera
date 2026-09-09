import { describe, it, expect } from 'vitest'
import {
  accountRemovalBlockers,
  historyResumePlan,
  parseAllowedExternalUrl,
  providerOfSession,
  liveWorkersFor,
  rollCoordinatorForSession,
  staleSpecFiles
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

// Reused by the reattach adopter (registerIpc's startHostClient) so a session taken back from the
// Host registers with the same coordinator spawnSession would have chosen.
describe('rollCoordinatorForSession', () => {
  it('routes a codex session to codexRolling', () => {
    const list = [sess('s1', 'acc1')]
    const get = (id: string): Account => account({ id, provider: 'codex' })
    expect(rollCoordinatorForSession('s1', list, get)).toBe('codexRolling')
  })

  it('routes a claude session to rolling', () => {
    const list = [sess('s1', 'acc1')]
    const get = (id: string): Account => account({ id, provider: 'claude' })
    expect(rollCoordinatorForSession('s1', list, get)).toBe('rolling')
  })

  // A caller that folded this into an if/else on the provider string alone would let a gone account
  // fall into the else branch and register with rolling — the wrong coordinator for a codex session.
  it('routes to neither when the account is gone', () => {
    const list = [sess('s1', 'acc1')]
    const get = (): Account => {
      throw new Error('no such account')
    }
    expect(rollCoordinatorForSession('s1', list, get)).toBeNull()
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

describe('staleSpecFiles — which spec files a boot clears', () => {
  const SPECS = String.raw`C:\Users\me\AppData\astera\orch\specs`
  const SEP = '\\'
  const open = (name: string): { specPath: string } => ({ specPath: [SPECS, name].join(SEP) })
  const closed = (name: string): { endedAt: string; specPath: string } => ({
    endedAt: '2026-09-09T00:00:00.000Z',
    specPath: [SPECS, name].join(SEP)
  })

  it('keeps the spec file of a Dispatch that is still open', () => {
    expect(
      staleSpecFiles({ files: ['tsk_1-dsp_1.md'], dispatches: [open('tsk_1-dsp_1.md')], runs: [], live: undefined })
    ).toEqual([])
  })

  it('deletes the spec file of a Dispatch the restart closed', () => {
    expect(
      staleSpecFiles({
        files: ['tsk_1-dsp_1.md', 'tsk_2-dsp_2.md'],
        dispatches: [open('tsk_1-dsp_1.md'), closed('tsk_2-dsp_2.md')],
        runs: [],
        live: undefined
      })
    ).toEqual(['tsk_2-dsp_2.md'])
  })

  it('deletes a file no Dispatch claims', () => {
    expect(staleSpecFiles({ files: ['orphan.md'], dispatches: [], runs: [], live: undefined })).toEqual([
      'orphan.md'
    ])
  })

  // 오래된 Dispatch 는 워커가 spec 을 쓰기 전에 열렸을 수 있다 — 지울 것이 없다는 뜻이지 이 판정이
  // 흔들린다는 뜻이 아니다.
  it('an open Dispatch whose spec file is already gone changes nothing', () => {
    expect(
      staleSpecFiles({
        files: ['orphan.md'],
        dispatches: [open('tsk_1-dsp_1.md'), open('tsk_2-dsp_2.md')],
        runs: [],
        live: undefined
      })
    ).toEqual(['orphan.md'])
  })

  // openDispatch 는 specPath 를 빈 문자열로 열고 워커가 실제로 뜬 뒤에 채운다. 그 빈 값이 아무 파일도
  // 지켜서는 안 된다.
  it('a Dispatch whose specPath is still the empty placeholder protects nothing', () => {
    expect(
      staleSpecFiles({
        files: ['tsk_1-dsp_1.md'],
        dispatches: [{ specPath: '' }, { specPath: '' }],
        runs: [],
        live: undefined
      })
    ).toEqual(['tsk_1-dsp_1.md'])
  })

  // orchestration.json 은 손으로 고쳐지고, 이 저장소는 두 구분자를 다 본다.
  it('matches a specPath written with either separator', () => {
    expect(
      staleSpecFiles({
        files: ['tsk_1-dsp_1.md'],
        dispatches: [{ specPath: 'C:/Users/me/orch/specs/tsk_1-dsp_1.md' }],
        runs: [],
        live: undefined
      })
    ).toEqual([])
  })

  // 코디네이터 브리핑도 같은 폴더에 있고 어떤 Dispatch 도 자기 것이라 하지 않는다. 세션이 살아남았으면
  // 그 브리핑은 살아 있는 에이전트의 지시문이다.
  it('keeps a coordinator brief whose session the Host handed back', () => {
    expect(
      staleSpecFiles({
        files: ['coordinator-run_1.md'],
        dispatches: [],
        runs: [{ id: 'run_1', coordinatorSessionId: 'sess_c' }],
        live: new Set(['sess_c'])
      })
    ).toEqual([])
  })

  it('deletes a coordinator brief whose session did not survive', () => {
    expect(
      staleSpecFiles({
        files: ['coordinator-run_1.md'],
        dispatches: [],
        runs: [{ id: 'run_1', coordinatorSessionId: 'sess_c' }],
        live: new Set(['someone-else'])
      })
    ).toEqual(['coordinator-run_1.md'])
  })

  it('deletes every coordinator brief when there is no Host, exactly as before', () => {
    expect(
      staleSpecFiles({
        files: ['coordinator-run_1.md'],
        dispatches: [],
        runs: [{ id: 'run_1', coordinatorSessionId: 'sess_c' }],
        live: undefined
      })
    ).toEqual(['coordinator-run_1.md'])
  })

  it('keeps a coordinator brief when what the Host still runs is unknown', () => {
    expect(
      staleSpecFiles({
        files: ['coordinator-run_1.md', 'coordinator-run_2.md'],
        dispatches: [],
        runs: [{ id: 'run_1', coordinatorSessionId: 'sess_c' }, { id: 'run_2' }],
        live: 'unknown'
      })
    ).toEqual(['coordinator-run_2.md'])
  })
})

describe('liveWorkersFor — the three answers the Host can give about its sessions', () => {
  it('no Host at all is the pre-Host answer: nothing survived', () => {
    expect(liveWorkersFor(null)).toBeUndefined()
  })

  // 이 한 줄이 이 라운드의 Critical 이었다. 'unknown' 이 undefined 로 접히면 살아 있는 워커의 Dispatch
  // 가 닫히고 같은 워크트리에 두 번째 에이전트가 뜬다.
  it('an unanswered Host stays unknown and does not collapse into "nothing survived"', () => {
    expect(liveWorkersFor('unknown')).toBe('unknown')
  })

  it('an answer is the set of sessions it named', () => {
    expect(liveWorkersFor({ adopted: 1, refused: 0, sessions: ['sess_a'] })).toEqual(new Set(['sess_a']))
  })

  it('an answer naming nothing is an empty set, not unknown — the Host really had nothing', () => {
    expect(liveWorkersFor({ adopted: 0, refused: 2, sessions: [] })).toEqual(new Set())
  })
})
