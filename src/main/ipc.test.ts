import { describe, it, expect, vi } from 'vitest'
import {
  accountRemovalBlockers,
  closeConversationOnExit,
  codexRolloutFromNote,
  forgetAttentionOnExit,
  historyResumePlan,
  hostHandshakeMeans,
  hostHoldings,
  parseAllowedExternalUrl,
  providerOfSession,
  liveWorkersFor,
  rollCoordinatorForSession,
  scheduleForAdoptedSession,
  sessionsTakenBackOnFailure,
  staleSpecFiles
} from './ipc'
import { createAttentionState } from './attention'
import { sanitizeResumePrompt } from '../core/sessions/commands'
import { PTY_LOST_SIGHT_EXIT_CODE } from '../core/sessions/pty'
import type { PtyEntry } from '../core/host/protocol'
import type { Account, ScheduleConfig, SessionInfo } from '../core/types'

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

  // An older Dispatch may have been opened before its worker ever wrote a spec. That means there is
  // nothing here to delete, not that this decision is shaky.
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

  // openDispatch opens with specPath as an empty string and fills it in once the worker has actually
  // started. That empty value must not protect any file.
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

  // orchestration.json gets hand-edited, and this repository sees both separators.
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

  // A coordinator brief lives in the same folder and no Dispatch claims it as its own. If its session
  // survived, that brief is a live agent's instructions.
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

  // This one line was the round's Critical. If 'unknown' folds into undefined, the Dispatch of a live
  // worker is closed and a second agent starts in the same worktree.
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

describe('sessionsTakenBackOnFailure — what startHostClient\'s outer catch settles with', () => {
  // A throw before anything ever accepted a connection (hostAddress, retireOlderHosts) is the
  // deterministic no-Host case — the same answer a missing out/main/host.js already settles.
  it('no peer ever seen settles null, same as no Host at all', () => {
    expect(sessionsTakenBackOnFailure(false)).toBeNull()
  })

  // A throw after a peer answered (createHostPtyFactory, the trailing onHostClientReady wiring) means
  // a Host may already be holding sessions this app never took back. Settling null there would have
  // the restart cleanup close a Dispatch whose worker is still running — the duplicate-agent failure
  // liveWorkersFor's own 'unknown' case exists to prevent.
  it('a peer was seen settles unknown, not null — its sessions are not evidence of nothing', () => {
    expect(sessionsTakenBackOnFailure(true)).toBe('unknown')
  })
})

describe('hostHandshakeMeans — what a completed handshake means for the ptys the app already had', () => {
  const a = '4242@2026-09-09T00:00:00.000Z'

  it('the boot handshake is the startup chain\'s, not a reconnect', () => {
    expect(hostHandshakeMeans(null, a)).toBe('first')
  })

  // The load-bearing one. A dropped socket ends every pty handle in the app while the Host keeps
  // running the processes; if this read as a new Host, nothing would take them back and the app would
  // sit beside a Host holding live agents it no longer knows about.
  it('the same Host answering again is a reconnect, and its ptys are still there to take back', () => {
    expect(hostHandshakeMeans(a, a)).toBe('same-host')
  })

  it('a different Host means the ptys the old one held are gone', () => {
    expect(hostHandshakeMeans(a, '5150@2026-09-09T00:00:00.000Z')).toBe('other-host')
  })

  // A Host that died and whose successor was handed the same pid — ordinary on win32, and the whole
  // reason `startedAt` is half of the identity rather than the pid being all of it.
  it('the same pid at a different start time is a different Host', () => {
    expect(hostHandshakeMeans(a, '4242@2026-09-09T00:00:05.000Z')).toBe('other-host')
  })
})

describe('scheduleForAdoptedSession — re-arming the schedule of a session taken back from the Host', () => {
  const rule = { kind: 'interval', everyMinutes: 30 } as const
  const cfg = { command: '/status', rule } as unknown as ScheduleConfig
  const store = (entries: Record<string, ScheduleConfig>) => (k: string): ScheduleConfig | null => entries[k] ?? null

  // The mistake this function exists to make impossible: scheduler.json is keyed by the conversation's
  // own session id, and looking it up by the app session id would silently find nothing for every
  // session — the same "no schedule, no warning" the adopter had before.
  it('never looks the schedule up under the app session id', () => {
    const asked: string[] = []
    scheduleForAdoptedSession({ id: 'app-sess-1', resumeSessionId: 'conv-9' }, 'conv-from-statusline', (k) => {
      asked.push(k)
      return null
    })
    expect(asked).not.toContain('app-sess-1')
  })

  it('uses resumeSessionId when the session was started as a resume — the key is known without a file', () => {
    expect(scheduleForAdoptedSession({ id: 'app-sess-1', resumeSessionId: 'conv-9' }, null, store({ 'conv-9': cfg }))).toBe(cfg)
  })

  // The ordinary case: a session that was never resumed learned its key at runtime, and the statusLine
  // capture file the CLI wrote is still in the profile under the app session id the adoption kept.
  it('falls back to the id the statusLine payload carries', () => {
    expect(
      scheduleForAdoptedSession({ id: 'app-sess-1' }, 'conv-from-statusline', store({ 'conv-from-statusline': cfg }))
    ).toBe(cfg)
  })

  // A session neither started as a resume nor found in the statusLine capture, and whose note carries
  // no codex session id either — a claude session whose capture file is gone, or a codex one the scan
  // had not mapped when the app went down. No key, so no schedule, and the store is not guessed at.
  it('gives up when neither source knows the conversation id, without asking the store', () => {
    let asked = 0
    expect(
      scheduleForAdoptedSession({ id: 'app-sess-1' }, null, () => {
        asked += 1
        return cfg
      })
    ).toBeNull()
    expect(asked).toBe(0)
  })

  it('a key with nothing stored under it is no schedule, not a made-up one', () => {
    expect(scheduleForAdoptedSession({ id: 'app-sess-1' }, 'conv-9', store({}))).toBeNull()
  })

  // codex has no statusLine, so the id its rollout watcher mapped — carried in the note since the
  // watcher started writing it down — is the only thing that can answer for a codex session that was
  // not started as a resume. Same second argument, a different source for it.
  it('takes the codex session id the note carried, the only key a codex session has', () => {
    expect(scheduleForAdoptedSession({ id: 'app-sess-1' }, 'cx-conv-1', store({ 'cx-conv-1': cfg }))).toBe(cfg)
  })
})

describe('codexRolloutFromNote — what an adopted codex session can be registered with', () => {
  // The whole point of remembering it: the watcher's own discovery cannot be run for an adopted
  // session, so the note is the only way it can be watched at all.
  it('reads back the rollout the watcher mapped before the restart', () => {
    expect(codexRolloutFromNote({ title: 't', rolloutPath: 'D:/r/one.jsonl', codexSessionId: 'cx-1' })).toEqual({
      rolloutPath: 'D:/r/one.jsonl',
      codexSessionId: 'cx-1'
    })
  })

  // The case the skip protects. A claude session's note, or a codex one whose scan had not answered
  // before the app went down: registering it would set the watcher scanning, and for an adopted
  // session that scan claims another session's file.
  it('answers null for a note with no rollout in it', () => {
    expect(codexRolloutFromNote({ title: 't', accountId: 'acc_1' })).toBeNull()
  })

  it('answers null rather than trusting a rollout path that is not a string', () => {
    expect(codexRolloutFromNote({ rolloutPath: 42, codexSessionId: 'cx-1' })).toBeNull()
  })

  // The path is what registration needs; the id is what the scheduler needs. A note that has one and
  // not the other still gets the watcher going.
  it('keeps a path whose note carries no usable id', () => {
    expect(codexRolloutFromNote({ rolloutPath: 'D:/r/one.jsonl' })).toEqual({
      rolloutPath: 'D:/r/one.jsonl',
      codexSessionId: null
    })
  })
})

describe('hostHoldings — what the Info tab says the Host is holding', () => {
  const entry = (over: Partial<PtyEntry>): PtyEntry => ({
    id: 'p1',
    pid: 100,
    meta: null,
    alive: true,
    ...over
  })
  const note = (kind: 'session' | 'run' | 'terminal', id: string): PtyEntry['meta'] => ({
    kind,
    id,
    restore: {}
  })

  it('counts the live sessions, terminals and runs separately', () => {
    expect(
      hostHoldings([
        entry({ id: 'a', meta: note('session', 's1') }),
        entry({ id: 'b', meta: note('terminal', 't1') }),
        entry({ id: 'c', meta: note('session', 's2') }),
        entry({ id: 'd', meta: note('run', 'r1') })
      ])
    ).toEqual({ sessions: 2, terminals: 1, runs: 1 })
  })

  // An exited pty is history the Host keeps for its replay buffer. Nothing about it survives closing
  // the app, which is the question this row answers, so it is not held.
  it('does not count a pty that has already exited', () => {
    expect(
      hostHoldings([entry({ meta: note('session', 's1'), alive: false })])
    ).toEqual({ sessions: 0, terminals: 0, runs: 0 })
  })

  // A run the Host owns survives the quit exactly as a session does — RunManager.stopAppOwned skips
  // every pty that outlives the app. Someone whose only held work is a long build or a dev server
  // must not read this row as saying nothing of theirs is protected.
  it('counts a run, because a Host-held run outlives the app too', () => {
    expect(hostHoldings([entry({ meta: note('run', 'r1') })])).toEqual({
      sessions: 0,
      terminals: 0,
      runs: 1
    })
  })

  // An entry with no note at all is one the sweep kills rather than adopts, so reporting it as held
  // would name as protected something the app is about to end.
  it('does not count a pty with no note', () => {
    expect(hostHoldings([entry({ meta: null })])).toEqual({ sessions: 0, terminals: 0, runs: 0 })
  })

  // Zero is a real answer here, and it is the one a Host that has just started gives. It is only ever
  // reached by an entry list the Host actually sent — the row says nothing at all until then.
  it('answers zeros for a Host holding nothing', () => {
    expect(hostHoldings([])).toEqual({ sessions: 0, terminals: 0, runs: 0 })
  })
})

// The real attention state (main/attention.ts) is used below rather than a recorder stub, so these
// pin the actual observable effect — what get() reads back after the exit — not just which branch
// forget() happened to be called from.
describe('forgetAttentionOnExit — the attention verdict on a session exit', () => {
  // A lost-sight exit means the app only lost its pty handle, not that the session ended — the Host
  // keeps running it, and no hook event arrives again until the next tool call. Forgetting here would
  // silently drop a `waiting` banner while a permission prompt is still on screen through the
  // reconnect.
  it('a lost-sight exit leaves the value', () => {
    const attention = createAttentionState()
    attention.onHookEvent('s1', { hook_event_name: 'Notification', notification_type: 'permission_prompt' })
    forgetAttentionOnExit(attention, 's1', PTY_LOST_SIGHT_EXIT_CODE)
    expect(attention.get('s1')).toBe('waiting')
  })

  it('an ordinary exit clears it', () => {
    const attention = createAttentionState()
    attention.onHookEvent('s1', { hook_event_name: 'Notification', notification_type: 'permission_prompt' })
    forgetAttentionOnExit(attention, 's1', 0)
    expect(attention.get('s1')).toBe('idle')
  })

  // registerIpc's real call passes attention as an optional dep (it is undefined in a harness that
  // never constructed one) — an exit must not throw just because nothing is there to forget.
  it('does nothing, without throwing, when there is no attention state', () => {
    expect(() => forgetAttentionOnExit(undefined, 's1', 0)).not.toThrow()
  })
})

// A `close` spy stands in for ConversationSessions here — unlike forgetAttentionOnExit's tests above,
// what close() itself does (stop the follow, stop the timer once nothing is left open) is already
// pinned by conversation.test.ts; this only has to show the exit code decides whether it is called.
describe('closeConversationOnExit — a session exit closes its open conversation', () => {
  it('a lost-sight exit leaves the conversation open', () => {
    const close = vi.fn()
    closeConversationOnExit({ close }, 's1', PTY_LOST_SIGHT_EXIT_CODE)
    expect(close).not.toHaveBeenCalled()
  })

  it('an ordinary exit closes it', () => {
    const close = vi.fn()
    closeConversationOnExit({ close }, 's1', 0)
    expect(close).toHaveBeenCalledWith('s1')
  })

  // registerIpc constructs conversationSessions unconditionally today, but the guard does not assume
  // that — the same defensive shape as forgetAttentionOnExit's undefined case above.
  it('does nothing, without throwing, when there is no conversation sessions', () => {
    expect(() => closeConversationOnExit(undefined, 's1', 0)).not.toThrow()
  })
})
