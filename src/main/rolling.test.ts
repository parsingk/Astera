import { createHook } from 'node:async_hooks'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Account, SessionInfo } from '../core/types'
import { claudeHistoryStrategy } from '../core/history/strategies/claude'
import { matchesLimitPhrase } from '../core/rolling/detect'
import { parseResetTime } from '../core/rolling/resetTime'
import { BlockRegistry } from '../core/rolling/blockRegistry'
import { RollingCoordinator, type RollingDeps } from './rolling'

const acc = (id: string, label: string): Account => ({
  id,
  label,
  configDir: path.join('D:\\cfg', id),
  color: '#fff',
  createdAt: '2026-07-22T00:00:00Z'
})

const payload = (pct: number, sid = 'claude-sess', slug = 'D--work-p'): unknown => ({
  session_id: sid,
  transcript_path: path.join('D:\\cfg', 'a1', 'projects', slug, `${sid}.jsonl`),
  rate_limits: { five_hour: { used_percentage: pct } }
})

// resets_at(epoch초) 포함 페이로드 — reset 앵커(3-b) 테스트용. normalizeReset이 초→ISO 변환한다.
const payloadReset = (five: number, fiveResetsAtSec: number, sid = 'claude-sess'): unknown => ({
  session_id: sid,
  transcript_path: path.join('D:\\cfg', 'a1', 'projects', 'D--work-p', `${sid}.jsonl`),
  rate_limits: { five_hour: { used_percentage: five, resets_at: fiveResetsAtSec } }
})

function harness(overrides: Partial<RollingDeps> = {}): {
  coord: RollingCoordinator
  events: string[]
  written: { id: string; data: string }[]
  sent: { channel: string; payload: Record<string, unknown> }[]
  copied: { src: string; dest: string }[]
  spawned: (SessionInfo & { orchEnv?: { cliPath: string; infoPath: string; skillsPath: string } })[]
  payloads: Map<string, unknown>
  info1: SessionInfo
} {
  const accounts: Record<string, Account> = {
    a1: acc('a1', '계정A'),
    a2: acc('a2', '계정B'),
    a3: acc('a3', '계정C')
  }
  const events: string[] = []
  const written: { id: string; data: string }[] = []
  const sent: { channel: string; payload: Record<string, unknown> }[] = []
  const copied: { src: string; dest: string }[] = []
  const spawned: (SessionInfo & { orchEnv?: { cliPath: string; infoPath: string; skillsPath: string } })[] = []
  const payloads = new Map<string, unknown>()
  let seq = 1
  const coord = new RollingCoordinator({
    spawn: (opts) => {
      seq++
      const info: SessionInfo = {
        id: `s${seq}`,
        accountId: opts.account.id,
        cwd: opts.cwd,
        status: 'running',
        title: 'p',
        resumeSessionId: opts.resumeSessionId,
        rollAccountIds: opts.rollAccountIds,
        slackNotify: opts.slackNotify,
        bypassPermissions: opts.bypassPermissions
      }
      spawned.push({ ...info, orchEnv: opts.orchEnv })
      events.push(`spawn:${info.id}:${opts.account.id}`)
      return info
    },
    write: (id, data) => written.push({ id, data }),
    kill: (id) => events.push(`kill:${id}`),
    getAccount: (id) => accounts[id] ?? null,
    readStatusPayload: (id) => Promise.resolve(payloads.get(id) ?? null),
    send: (channel, p) => sent.push({ channel, payload: p as Record<string, unknown> }),
    log: () => {},
    lang: () => 'ko', // 기존 한국어 기대값을 유지
    blocks: new BlockRegistry(), // 하네스마다 새 인스턴스 — 앞 테스트의 차단이 뒤 테스트를 막지 않게
    copy: (src, dest) => {
      copied.push({ src, dest })
      events.push('copy')
      return Promise.resolve()
    },
    ...overrides
  } satisfies RollingDeps)
  const info1: SessionInfo = {
    id: 's1',
    accountId: 'a1',
    cwd: 'D:\\work\\p',
    status: 'running',
    title: 'p',
    rollAccountIds: ['a1', 'a2', 'a3']
  }
  // settleIo가 "아직 뭔가 도착하는 중인가"를 판단할 근거. 하네스가 스스로 등록하므로 호출부는
  // 그대로다 — 자세한 이유는 settleIo 위 주석에
  ioProbes.push(() => events.length + written.length + sent.length + copied.length + spawned.length)
  return { coord, events, written, sent, copied, spawned, payloads, info1 }
}

// 이 리터럴이 통짜면 이 테스트 파일 자체가 롤링 세션의 PTY로 흘러갈 때(예: cat/read) 스캐너가
// 물어 실제 롤을 유발한다 — 접합으로 쪼개 소스에 트리거를 두지 않는다. 런타임 값은 동일하다.
const LIMIT_TEXT = 'Claude usage limit ' + 'reached ∙ resets 3am'
// 관리자 통제 플랜에서 실측한 한도 선택 목록(2026-08-26). 항목 1의 라벨 앞에 'Stop and ' 가 붙어 있는
// 것과, 항목 2가 **CLI 자신의 자동 대기** 라는 것이 요점이다. 통짜 금지 관례는 LIMIT_TEXT 와 동일.
const WAIT_DIALOG =
  'What do you want to do?\n\n> 1. Stop and wait for ' +
  'limit to reset\n  2. Wait here, then continue automatically shortly\n' +
  '  3. Ask your admin for more usage\n\nEnter to confirm · Esc to cancel'
// 문구에 reset 시각까지 담은 픽스처. 통짜 금지 관례는 LIMIT_TEXT와 동일.
const limitWithReset = (kind: 'session' | 'weekly', tail: string): string =>
  "You've hit your " + kind + ` limit · resets ${tail} (Asia/Seoul)`
const flush = (): Promise<void> => vi.advanceTimersByTimeAsync(0) as unknown as Promise<void>

beforeEach(() => {
  vi.useFakeTimers()
  ioProbes.length = 0 // 지난 테스트의 하네스는 settleIo의 판단 근거가 될 수 없다
})
afterEach(() => {
  vi.useRealTimers()
})

describe('RollingCoordinator', () => {
  it('한도 감지 시 복사→kill→spawn 순서로 다음 계정에 same-ID resume한다', async () => {
    const h = harness()
    h.payloads.set('s1', payload(97))
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    expect(h.events).toEqual(['copy', 'kill:s1', 'spawn:s2:a2'])
    expect(h.copied[0].dest).toBe(path.join('D:\\cfg', 'a2', 'projects', 'D--work-p', 'claude-sess.jsonl'))
    expect(h.spawned[0].resumeSessionId).toBe('claude-sess')
    expect(h.sent.some((s) => s.channel === 'session:rolled')).toBe(true)
  })

  it('롤로 띄운 세션에 orchEnv를 실어 보낸다', async () => {
    const env = { cliPath: 'C:/astera/cli.js', infoPath: 'C:/astera/info.json', skillsPath: 'C:/astera/skills' }
    const h = harness({ orchEnv: () => env })
    h.payloads.set('s1', payload(97))
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    expect(h.spawned[0].orchEnv).toEqual(env)
  })

  it('orchEnv dep이 주입되지 않으면 실리지 않는다', async () => {
    const h = harness() // 주입 없음
    h.payloads.set('s1', payload(97))
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    expect(h.spawned[0].orchEnv).toBeUndefined()
  })

  // 게이트를 제거했다. 한도로 막힌 순간 statusLine은 이미 멈춰 있어 낡은 스냅샷만
  // 보이므로, 게이트가 정당한 한도 문구를 막는 쪽이 실제 피해였다(13시간 무감지). 오탐 방어는
  // 게이트가 아니라 실측 문구로 좁힌 LIMIT_RE가 담당한다 — codex와 같은 원칙.
  it('사용률이 낮아도 한도 문구만으로 롤한다 (게이트 제거)', async () => {
    const h = harness()
    h.payloads.set('s1', payload(42))
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    expect(h.events).toEqual(['copy', 'kill:s1', 'spawn:s2:a2'])
  })

  // 종전 기대값은 'none' 이었다 — 중단이 아무것도 예약하지 않는다는, 지금 고친 그 동작이다.
  // 중단 자체(copy/kill/spawn 없음)는 그대로 검사하고, 그 뒤에 무엇이 게시되는지는 아래의
  // '중단된 롤이 다음 시도를 예약한다' describe 가 재시도까지 함께 못박는다.
  it('statusline 메타가 아예 없으면 롤을 중단하고 대기 상태를 알린다', async () => {
    const h = harness()
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    expect(h.events).toEqual([])
    expect(h.sent.at(-1)?.payload.state).toBe('waiting')
  })

  it('respawn 후 신뢰 다이얼로그를 자동 수락한다 (Enter 400ms)', async () => {
    const h = harness()
    h.payloads.set('s1', payload(97))
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    h.coord.handleData({ sessionId: 's2', data: 'Do you trust the files in this folder?' })
    await vi.advanceTimersByTimeAsync(400)
    expect(h.written).toContainEqual({ id: 's2', data: '\r' })
    expect(h.sent.some((s) => s.channel === 'session:rollState' && s.payload.state === 'trust')).toBe(true)
  })

  it('공백 없이 그려진 신뢰 다이얼로그도 자동 수락한다 (실제 rolling.log 화면)', async () => {
    const h = harness()
    h.payloads.set('s1', payload(97))
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    // 종전에는 이 렌더링을 놓쳐 30초 폴백이 이어가기 문구를 다이얼로그 안으로 타이핑했다
    h.coord.handleData({
      sessionId: 's2',
      data: 'Onlyproceedifyoutrustthisconfiguration.Doyoutrustthefilesinthisfolder?1.Yes,Itrustthisfolder2.No,exit'
    })
    await vi.advanceTimersByTimeAsync(400)
    expect(h.written).toContainEqual({ id: 's2', data: '\r' })
  })

  it('awaitingReady 구간에서는 forceRoll도 재롤하지 않는다 — 신뢰 타이머는 살아있는 세션에 정상 발화한다 (리뷰 Finding 2)', async () => {
    const h = harness()
    h.payloads.set('s1', payload(97))
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT }) // → a2 (s2), awaitingReady=true
    await flush()
    h.payloads.set('s2', payload(97, 'claude-sess')) // a2도 이미 한도 임박 — 재롤 시도용
    h.coord.handleData({ sessionId: 's2', data: 'Do you trust the files in this folder?' }) // trustTimer(400ms) 예약, liveId='s2' 캡처
    // (Finding 2 수정 전에는) forceRoll(E2E 강제 훅)이 onLimit의 가드를 그대로 타면서도
    // awaitingReady를 보지 않아 400ms 안에 재롤을 강제할 수 있었다 — 그 재롤이 s2를 stale하게
    // 만들면 아래 trustTimer가 죽은 세션에 쓸 위험이 있었다(liveId 캡처 가드로 막긴 했지만).
    // 수정 후에는 onLimit 자체가 awaitingReady를 가드해 forceRoll도 재롤하지 않는다 — 레이스 자체가
    // 구조적으로 사라진다.
    await h.coord.forceRoll('s2')
    await flush()
    expect(h.spawned).toHaveLength(1) // 재롤 없음 — s2가 여전히 live
    await vi.advanceTimersByTimeAsync(400) // 신뢰 타이머 발화 시점
    expect(h.written).toContainEqual({ id: 's2', data: '\r' }) // 살아있는 s2에 정상적으로 Enter가 간다
  })

  it('awaitingReady 중에는 onLimit이 재롤하지 않는다 (forceRoll로 직접 구동, 리뷰 Finding 2)', async () => {
    const h = harness()
    h.payloads.set('s1', payload(97))
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT }) // → a2 (s2), awaitingReady=true
    await flush()
    expect(h.spawned).toHaveLength(1)
    h.payloads.set('s2', payload(97, 'claude-sess')) // a2도 이미 한도 임박한 낡은/실제 payload
    // onLimitCandidate·tick 폴백·forceRoll 전부 onLimit이라는 같은 choke point를 거친다 —
    // forceRoll로 그 choke point를 직접 구동해 awaitingReady 가드 하나로 셋 다 지켜지는지 확인한다.
    await h.coord.forceRoll('s2')
    await flush()
    expect(h.spawned).toHaveLength(1) // 재롤 없음 — awaitingReady 가드가 막는다
  })

  it('알아보지 못한 대화상자가 떠 있으면 30초 폴백이 그 위로 타이핑하지 않는다', async () => {
    const h = harness()
    h.payloads.set('s1', payload(97))
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT }) // → a2 (s2), awaitingReady=true
    await flush()
    // statusline이 오지 않는다(payloads에 s2 없음) — 모달이 화면을 잡고 있을 때의 실제 상황이다.
    // 문구는 우리가 아는 신뢰 문장이 아니므로 trustSeen은 서지 않는다. 종전에는 이 조합에서
    // 30초 폴백이 이어가기 문구를 이 선택 목록 안으로 타이핑했다.
    h.coord.handleData({ sessionId: 's2', data: 'Some prompt we do not know\n❯ 1. Yes\n  2. No' })
    await vi.advanceTimersByTimeAsync(35_000)
    expect(h.written.filter((w) => w.id === 's2')).toEqual([])
    // 대신 120초 데드라인이 사람을 부른다 — 효과를 예측할 수 없는 입력을 보내는 것보다 낫다
    await vi.advanceTimersByTimeAsync(90_000)
    expect(h.sent.some((s) => s.channel === 'session:rollState' && s.payload.state === 'stalled')).toBe(true)
  })

  it('자동 프롬프트가 타임아웃하면 awaitingReady를 되돌리고 stalled로 사람을 부른다', async () => {
    const h = harness()
    h.payloads.set('s1', payload(97))
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT }) // → a2 (s2), awaitingReady=true
    await flush()
    expect(h.spawned).toHaveLength(1)
    // s2의 statusline이 끝내 쓰이지 않는다(payloads에 s2가 없다). 신뢰 다이얼로그를 보내 trustSeen을
    // 세우면 30초 폴백 경로(!chain.trustSeen 조건)가 막히고 120초 타임아웃까지 간다 — 그 조합만이
    // 타임아웃에 도달하는 유일한 길이다.
    h.coord.handleData({ sessionId: 's2', data: 'Do you trust the files in this folder?' })
    await vi.advanceTimersByTimeAsync(500) // 신뢰 타이머(400ms) 소화
    await vi.advanceTimersByTimeAsync(125_000) // READY_TIMEOUT_MS(120초) 경과

    // 자동 재개가 끝내 실패한 것은 사람이 봐야 하는 사건이다 — 종전에는 'none'으로 게시해
    // UI에 정상으로 보였다.
    expect(h.sent.some((s) => s.channel === 'session:rollState' && s.payload.state === 'stalled')).toBe(
      true
    )

    // 그리고 감지가 살아 있어야 한다. 종전에는 awaitingReady가 영구히 true로 남아 이 체인이 한도를
    // 다시는 감지하지 못했다 — onLimit·handleData·limitTailCheck·tick의 폴백이 모두 그 플래그에
    // 걸리므로 조용한 영구 사망이고 복구 경로가 없었다.
    h.payloads.set('s2', payload(97, 'claude-sess')) // roll()이 메타를 배울 수 있게 (타임아웃 후이므로 sendPrompt는 재예약되지 않는다)
    h.coord.handleData({ sessionId: 's2', data: LIMIT_TEXT })
    await flush()
    expect(h.spawned).toHaveLength(2) // a3로 롤
  })

  it('롤 직후 awaitingReady 구간(statusline 부재)에서는 한도 문구를 재트리거로 인정하지 않는다 (전환 직후 쿨다운)', async () => {
    const h = harness()
    h.payloads.set('s1', payload(97))
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT }) // → a2 (s2)
    await flush()
    expect(h.spawned).toHaveLength(1) // s2까지만 스폰된 상태 (awaitingReady=true, s2 statusline 없음)
    h.coord.handleData({ sessionId: 's2', data: LIMIT_TEXT }) // 재개 리플레이가 한도 문구를 출력해도
    await flush()
    expect(h.spawned).toHaveLength(1) // 추가 spawn 없음 — 쿨다운이 리플레이 오탐-재롤을 막는다
  })

  it('statusline 첫 기록 후 이어서 프롬프트 + Enter를 보낸다', async () => {
    const h = harness()
    h.payloads.set('s1', payload(97))
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    h.payloads.set('s2', payload(5, 'claude-sess'))
    await vi.advanceTimersByTimeAsync(1_000) // READY_POLL
    expect(h.written.some((w) => w.id === 's2' && w.data === '이어서 작업 진행해 줘')).toBe(true)
    await vi.advanceTimersByTimeAsync(150)
    expect(h.written.at(-1)).toEqual({ id: 's2', data: '\r' })
  })

  it('한 사이클 전부 차단 → waiting 후 15분 뒤 첫 계정으로 재시도한다', async () => {
    const h = harness()
    h.payloads.set('s1', payload(100))
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT }) // → a2 (s2)
    await flush()
    h.payloads.set('s2', payload(100, 'claude-sess'))
    await vi.advanceTimersByTimeAsync(1_000) // s2 프롬프트 전송 (awaitingReady 해제)
    h.coord.handleData({ sessionId: 's2', data: LIMIT_TEXT }) // → a3 (s3)
    await flush()
    h.payloads.set('s3', payload(100, 'claude-sess'))
    await vi.advanceTimersByTimeAsync(1_000)
    h.coord.handleData({ sessionId: 's3', data: LIMIT_TEXT }) // 3연속 → waiting
    await flush()
    const waiting = h.sent.find((s) => s.payload.state === 'waiting')
    expect(waiting).toBeDefined()
    expect(h.spawned).toHaveLength(2) // 아직 a1 재시도 전
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(h.spawned.at(-1)?.accountId).toBe('a1') // 대기 후 1번 계정으로 롤
  })

  it('세션 exit 시 체인을 폐기하고 이후 한도 문구를 무시한다', async () => {
    const h = harness()
    h.payloads.set('s1', payload(97))
    h.coord.register(h.info1)
    h.coord.handleExit({ sessionId: 's1' })
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    expect(h.events).toEqual([])
  })

  it('kill()이 동기적으로 exit을 통지해도 롤 진행 중인 체인을 폐기하지 않는다 (handleExit rolling 가드)', async () => {
    // RollingDeps.kill(): void는 exit이 비동기라는 걸 강제하지 않는다. 실제 node-pty 어댑터는 항상
    // 비동기지만, 이 테스트는 kill() 콜백 안에서 곧바로 handleExit를 재호출하는 동기 어댑터를 흉내내
    // "kill 직후~map swap 전" 레이스를 직접 재현한다.
    const accounts: Record<string, Account> = { a1: acc('a1', '계정A'), a2: acc('a2', '계정B') }
    const payloads = new Map<string, unknown>()
    let seq = 1
    let coord!: RollingCoordinator
    coord = new RollingCoordinator({
      spawn: (opts) => {
        seq++
        return {
          id: `s${seq}`,
          accountId: opts.account.id,
          cwd: opts.cwd,
          status: 'running',
          title: 'p',
          resumeSessionId: opts.resumeSessionId,
          rollAccountIds: opts.rollAccountIds
        }
      },
      write: () => {},
      kill: (id) => coord.handleExit({ sessionId: id }), // 동기 재진입 시뮬레이션
      getAccount: (id) => accounts[id] ?? null,
      readStatusPayload: (id) => Promise.resolve(payloads.get(id) ?? null),
      send: () => {},
      log: () => {},
      lang: () => 'ko',
      blocks: new BlockRegistry(),
      copy: () => Promise.resolve()
    } satisfies RollingDeps)
    const info1: SessionInfo = {
      id: 's1',
      accountId: 'a1',
      cwd: 'D:\\work\\p',
      status: 'running',
      title: 'p',
      rollAccountIds: ['a1', 'a2']
    }
    payloads.set('s1', payload(97))
    coord.register(info1)
    coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    // 가드가 없다면 kill() 재진입이 체인을 disposed=true로 만들고, roll()이 그 상태로 새 세션(s2)에
    // 재등록해 findLiveByClaudeSession이 영구히 null을 반환한다(§7.1에서 분석한 실패 모드).
    expect(coord.findLiveByClaudeSession('claude-sess')?.id).toBe('s2')
  })

  it('사용자 지정 롤 프롬프트가 있으면 기본 대신 그 문구를 전송한다', async () => {
    const h = harness()
    h.payloads.set('s1', payload(97))
    h.coord.register({ ...h.info1, rollPrompt: '계속 이어가 줘 부탁해' })
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush() // → s2 롤
    h.payloads.set('s2', payload(5, 'claude-sess'))
    await vi.advanceTimersByTimeAsync(1_000) // 준비 신호 → 자동 프롬프트
    expect(h.written.some((w) => w.id === 's2' && w.data === '계속 이어가 줘 부탁해')).toBe(true)
    expect(h.written.some((w) => w.data === '이어서 작업 진행해 줘')).toBe(false)
  })

  it('롤 프롬프트가 공백뿐이면 기본 문구로 폴백한다', async () => {
    const h = harness()
    h.payloads.set('s1', payload(97))
    h.coord.register({ ...h.info1, rollPrompt: '   ' })
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    h.payloads.set('s2', payload(5, 'claude-sess'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.written.some((w) => w.id === 's2' && w.data === '이어서 작업 진행해 줘')).toBe(true)
  })

  it('롤 respawn 시 slackNotify를 그대로 전달한다', async () => {
    const h = harness()
    h.payloads.set('s1', payload(97))
    h.coord.register({ ...h.info1, slackNotify: true })
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    expect(h.spawned[0].slackNotify).toBe(true)
  })

  it('롤 respawn 시 bypassPermissions를 그대로 전달한다', async () => {
    const h = harness()
    h.payloads.set('s1', payload(97))
    h.coord.register({ ...h.info1, bypassPermissions: true })
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    expect(h.spawned[0].bypassPermissions).toBe(true)
  })

  it('활성 체인의 claude 세션 ID로 live 세션을 찾는다 (resume 가드)', async () => {
    const h = harness()
    h.payloads.set('s1', payload(97))
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    expect(h.coord.findLiveByClaudeSession('claude-sess')?.id).toBe('s2')
    expect(h.coord.findLiveByClaudeSession('other')).toBeNull()
  })

  // 한도 도달 시 Claude Code가 띄우는 선택지를 스스로 걷어낸다.
  // 한도 문구·대기 항목 번호를 접합으로 분할한다 — 이 파일이 롤링 세션의 PTY로 흘러가면 스캐너가
  // 물어 실제 롤·키 입력이 발생하기 때문이다. 접합 후 런타임 값은 동일하다.
  const LIMIT_CHOICE_SCREEN = [
    "You've hit your " + 'session limit',
    '  1. Adjust monthly spend limit: $50',
    '❯ 2. Wait for ' + 'limit to reset',
    '  3. Upgrade to Max for higher session limits every month'
  ].join('\n')

  it('한도 선택지가 떠 있으면 대기 항목 번호를 눌러 해제한다', async () => {
    const h = harness()
    h.payloads.set('s1', payload(97))
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_CHOICE_SCREEN })
    await vi.advanceTimersByTimeAsync(200) // 번호 → 150ms → Enter
    expect(h.written.map((w) => w.data)).toEqual(['2', '\r'])
  })

  it('선택지 해제 후에도 프롬프트는 보내지 않는다 — reset 전 재전송 방지', async () => {
    const h = harness()
    h.payloads.set('s1', payload(97))
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_CHOICE_SCREEN })
    await vi.advanceTimersByTimeAsync(200)
    // 롤은 정상 진행되지만 PTY에 들어간 것은 선택지 응답뿐이다
    expect(h.written.some((w) => w.data.includes('이어서'))).toBe(false)
  })

  it('선택지가 없으면 아무것도 입력하지 않고 롤만 진행한다', async () => {
    const h = harness()
    h.payloads.set('s1', payload(97))
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    expect(h.written).toEqual([])
    expect(h.events).toEqual(['copy', 'kill:s1', 'spawn:s2:a2'])
  })

  // "선택지 번호를 못 찾았다" 로그가 한도 문구를 원문 그대로 담으면
  // rolling.log 자신이 새 트리거 소스가 된다 — 이 분기에 도달하는 조건 자체가 hit.limit(따라서
  // matchedText가 항상 그 문구를 포함)이다. 앞선 작업이 transcript 로그에서 같은
  // 위험을 막았는데 이 로그는 놓쳤었다. 마스킹 뒤에도 세션 식별 같은 진단 가치는 남는지,
  // reset 절(RESET_RE는 문구 접두를 요구한다)도 문구와 함께 무해해지는지 확인한다.
  it('선택지 번호를 못 찾을 때 남기는 로그는 한도 문구와 그 reset 절을 가린다', async () => {
    const logs: string[] = []
    const h = harness({ log: (m) => logs.push(m) })
    h.payloads.set('s1', payload(97))
    h.coord.register(h.info1)
    // 선택지 번호가 없는(findWaitChoice가 못 찾는) 한도 문구 — reset 시각까지 담아 마스킹이
    // RESET_RE의 접두까지 지우는지 함께 본다.
    h.coord.handleData({ sessionId: 's1', data: limitWithReset('session', '11am') })
    await flush()
    const notFoundLog = logs.find((l) => l.includes('limit choice not found'))
    expect(notFoundLog).toBeDefined()
    expect(matchesLimitPhrase(notFoundLog!)).toBe(false) // 프로덕션 스캐너(OutputScanner)가 다시 물지 않는다
    expect(parseResetTime(notFoundLog!, Date.now())).toBeNull() // reset 절도 문구 접두 없이는 파싱되지 않는다
    expect(notFoundLog).toContain('session=s1') // 진단 가치(세션 식별)는 남아 있다
  })

  // 선택지 목록이 먼저 그려지고 한도 문구가 뒤 청크로 오는 순서 — 스캐너가 매치 시점의 누적
  // 텍스트를 돌려주지 않으면 앞 청크의 번호를 놓친다 (계획 작성 중 발견한 결함의 회귀 방지)
  // 아래 두 청크도 접합으로 분할한다 — 붙여 두면 이 파일 자체가 PTY로 흘러갈 때 스캐너가 물어
  // 실제 롤·키 입력을 유발한다. 접합 후 런타임 값은 동일하다.
  it('선택지와 한도 문구가 다른 청크로 갈려 와도 번호를 찾는다', async () => {
    const h = harness()
    h.payloads.set('s1', payload(97))
    h.coord.register(h.info1)
    h.coord.handleData({
      sessionId: 's1',
      data: '  1. Adjust monthly spend limit: $50\n❯ 2. Wait for ' + 'limit to reset\n'
    })
    h.coord.handleData({ sessionId: 's1', data: "You've hit your " + 'session limit' })
    await vi.advanceTimersByTimeAsync(200)
    expect(h.written.map((w) => w.data)).toEqual(['2', '\r'])
  })

  // 위 테스트의 반대 순서 — 실전에서 실제로 이 순서로 온다. 한도 문구가 먼저 출력되고 선택지
  // 목록은 그 뒤에 렌더되는데, 스캐너는 매치 시 버퍼를 비우고 선택지 텍스트만으로는 LIMIT_RE가
  // 매치되지 않아 번호를 찾을 두 번째 기회가 없었다. 선택지가 남으면 세션이 입력 대기로 멈춰
  // statusLine이 정지하고 이후 감지가 모두 죽는다.
  it('한도 문구가 먼저 오고 선택지가 뒤에 와도 번호를 찾아 누른다', async () => {
    const h = harness()
    h.payloads.set('s1', payload(97))
    h.coord.register({ ...h.info1, rollAccountIds: ['a1'] }) // 단일 계정 — 대기 경로라 세션이 살아 있다
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT }) // 문구만 (선택지는 아직 화면에 없다)
    await flush()
    h.coord.handleData({
      sessionId: 's1',
      data: '  1. Adjust monthly spend limit: $50\n❯ 2. Wait for ' + 'limit to reset\n'
    })
    await vi.advanceTimersByTimeAsync(200)
    expect(h.written.map((w) => w.data)).toEqual(['2', '\r'])
  })

  it('감시 창이 지난 뒤 도착한 선택지는 누르지 않는다', async () => {
    const h = harness()
    h.payloads.set('s1', payload(97))
    h.coord.register({ ...h.info1, rollAccountIds: ['a1'] })
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    await vi.advanceTimersByTimeAsync(31_000) // CHOICE_WATCH_MS(30초) 경과
    h.coord.handleData({
      sessionId: 's1',
      data: '  1. Adjust monthly spend limit: $50\n❯ 2. Wait for ' + 'limit to reset\n'
    })
    await vi.advanceTimersByTimeAsync(200)
    expect(h.written).toEqual([])
  })
})

// resume 리플레이 오탐. --resume 재개는 대화 전체를 화면에 재생하고 그 대화에는 직전 한도 문구가
// 들어 있다. awaitingReady 쿨다운은 자동 프롬프트를 보내는 순간 해제되는데, 프롬프트는 첫
// statusline이 보이면 즉시 나가므로 리플레이가 아직 흐르는 중이다.
describe('롤 직후 리플레이 유예', () => {
  it('유예 안에 도착한 한도 문구는 재롤하지 않는다', async () => {
    const h = harness()
    h.payloads.set('s1', payload(97))
    h.payloads.set('s2', payload(10)) // 새 계정은 여유 있다
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    expect(h.events).toEqual(['copy', 'kill:s1', 'spawn:s2:a2'])
    await vi.advanceTimersByTimeAsync(1_500) // 준비 폴링 → 자동 프롬프트 (awaitingReady 해제)
    const afterRoll = [...h.events]
    h.coord.handleData({ sessionId: 's2', data: LIMIT_TEXT }) // 리플레이가 되울린 옛 문구
    await flush()
    expect(h.events).toEqual(afterRoll) // 재롤 없음
  })

  it('유예가 지난 뒤 도착한 한도 문구는 정상적으로 재롤한다', async () => {
    const h = harness()
    h.payloads.set('s1', payload(97))
    h.payloads.set('s2', payload(97))
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    await vi.advanceTimersByTimeAsync(61_000) // REPLAY_GRACE_MS(60초) 경과
    h.coord.handleData({ sessionId: 's2', data: LIMIT_TEXT })
    await flush()
    expect(h.events).toContain('spawn:s3:a3') // a2 → a3로 재롤
  })
})

// 주간 한도 롤링 + reset 타겟 재시도
const MIN = 60_000
const win = (used: number, resetIso?: string): Record<string, unknown> =>
  resetIso ? { used_percentage: used, resets_at: resetIso } : { used_percentage: used }
const payloadEx = (o: {
  five?: number
  weekly?: number
  fiveReset?: string
  weeklyReset?: string
  sid?: string // 한 하네스에 체인이 둘 이상일 때 — 안 주면 종전 그대로 'claude-sess'
}): unknown => ({
  session_id: o.sid ?? 'claude-sess',
  transcript_path: path.join(
    'D:\\cfg',
    'live',
    'projects',
    'D--work-p',
    `${o.sid ?? 'claude-sess'}.jsonl`
  ),
  rate_limits: {
    ...(o.five != null ? { five_hour: win(o.five, o.fiveReset) } : {}),
    ...(o.weekly != null ? { seven_day: win(o.weekly, o.weeklyReset) } : {})
  }
})
const settle = (): Promise<void> => vi.advanceTimersByTimeAsync(1_200) as unknown as Promise<void>
const lastWaiting = (
  sent: { channel: string; payload: Record<string, unknown> }[]
): Record<string, unknown> | undefined =>
  [...sent].reverse().find((s) => s.channel === 'session:rollState' && s.payload.state === 'waiting')
    ?.payload

// 같은 계정으로의 재개 횟수. 이제 그 경로는 kill·spawn을 하지 않으므로 spawn을 세면 안 되고,
// 관측 가능한 결과는 살아 있는 PTY로 나간 재개 프롬프트다.
const RESUME_PROMPT = '이어서 작업 진행해 줘'
const resumeCount = (h: { written: { id: string; data: string }[] }): number =>
  h.written.filter((w) => w.data === RESUME_PROMPT).length

describe('RollingCoordinator 주간 한도 롤링', () => {
  it('주간 전용 차단(five<90, weekly>=90)도 롤링을 유발한다', async () => {
    const h = harness()
    h.payloads.set('s1', payloadEx({ five: 20, weekly: 97, weeklyReset: new Date(Date.now() + 30 * MIN).toISOString() }))
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    expect(h.spawned.at(-1)?.accountId).toBe('a2') // 이전엔 게이트가 무시했지만 이제 롤
  })

  it('전부 주간 차단 → 가장 이른 주간 reset 계정으로 타겟 재시도(scope=weekly)', async () => {
    const h = harness()
    const now = Date.now()
    h.payloads.set('s1', payloadEx({ five: 20, weekly: 97, weeklyReset: new Date(now + 30 * MIN).toISOString() })) // A: +30m
    h.payloads.set('s2', payloadEx({ five: 20, weekly: 97, weeklyReset: new Date(now + 10 * MIN).toISOString() })) // B: +10m (가장 이름)
    h.payloads.set('s3', payloadEx({ five: 20, weekly: 97, weeklyReset: new Date(now + 20 * MIN).toISOString() })) // C: +20m
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT }); await settle() // → B(s2)
    h.coord.handleData({ sessionId: 's2', data: LIMIT_TEXT }); await settle() // → C(s3)
    h.coord.handleData({ sessionId: 's3', data: LIMIT_TEXT }); await flush()   // 전부 차단 → wait
    const w = lastWaiting(h.sent)
    expect(w?.scope).toBe('weekly')
    const spawnedBefore = h.spawned.length
    await vi.advanceTimersByTimeAsync(10 * MIN + 5 * MIN) // B의 reset(+10m) 경과
    expect(h.spawned.length).toBe(spawnedBefore + 1)
    expect(h.spawned.at(-1)?.accountId).toBe('a2') // 가장 이른 B로 롤백
  })

  it('혼합(주간 1 + 5시간 2) → 더 빨리 풀리는 5시간 계정으로(scope=session)', async () => {
    const h = harness()
    const now = Date.now()
    h.payloads.set('s1', payloadEx({ five: 97, weekly: 30, fiveReset: new Date(now + 5 * MIN).toISOString() }))  // A: 5h +5m
    h.payloads.set('s2', payloadEx({ five: 20, weekly: 97, weeklyReset: new Date(now + 30 * MIN).toISOString() })) // B: 주간 +30m
    h.payloads.set('s3', payloadEx({ five: 97, weekly: 30, fiveReset: new Date(now + 8 * MIN).toISOString() }))  // C: 5h +8m
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT }); await settle() // → B
    h.coord.handleData({ sessionId: 's2', data: LIMIT_TEXT }); await settle() // → C
    h.coord.handleData({ sessionId: 's3', data: LIMIT_TEXT }); await flush()   // 전부 차단 → wait
    const w = lastWaiting(h.sent)
    expect(w?.scope).toBe('session') // 5시간이 더 빨리 풀리므로 주간 백오프 아님
    await vi.advanceTimersByTimeAsync(5 * MIN + 3 * MIN) // A의 5시간 reset(+5m) 경과
    expect(h.spawned.at(-1)?.accountId).toBe('a1') // 가장 이른 A(5시간)로 롤백
  })

  it('reset 미상(창은 임계치나 resets_at 없음) → 15분 폴백(scope=session)', async () => {
    const h = harness()
    h.payloads.set('s1', payloadEx({ five: 97 })) // resets_at 없음
    h.payloads.set('s2', payloadEx({ five: 97 }))
    h.payloads.set('s3', payloadEx({ five: 97 }))
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT }); await settle()
    h.coord.handleData({ sessionId: 's2', data: LIMIT_TEXT }); await settle()
    h.coord.handleData({ sessionId: 's3', data: LIMIT_TEXT }); await flush()
    const w = lastWaiting(h.sent)
    expect(w?.scope).toBe('session')
    const spawnedBefore = h.spawned.length
    await vi.advanceTimersByTimeAsync(15 * MIN + 2 * MIN) // 폴백 15분 경과
    expect(h.spawned.length).toBe(spawnedBefore + 1) // 폴백으로 재시도 발생
  })

  it('무출력 폴백 트리거를 주간 100%에서도 발동한다 (틱)', async () => {
    const h = harness()
    h.payloads.set('s1', payloadEx({ five: 20, weekly: 100, weeklyReset: new Date(Date.now() + 20 * MIN).toISOString() }))
    h.coord.register(h.info1)
    // handleData(출력) 없이 30초 이상 무출력 → 15초 틱이 주간 100%를 보고 폴백 롤.
    // tickChain이 이제 limitTailCheck(①)를 await한 뒤에야 폴백을 평가한다 — 이 체인의
    // transcript_path는 존재하지 않는 더미 경로라 ①의 open()이 실패로 안착하는 데도 실제 fs I/O
    // 완료 콜백이 필요하다. 순수 fake-timer 진행만으로는 그 콜백이 돌지 않으므로(파일 하단 advanceIo
    // 주석 참고) advanceIo로 바꿔 실제 타이머 틱을 끼워 넣는다 — 발동 조건·기대값은 그대로다.
    await advanceIo(46_000)
    expect(h.spawned.at(-1)?.accountId).toBe('a2')
  })

  it('reset이 이미 지난 경우 즉시가 아니라 최소 대기(하한) 후 재시도한다', async () => {
    const h = harness()
    const past = new Date(Date.now() - 10 * MIN).toISOString() // 이미 지난 reset
    h.payloads.set('s1', payloadEx({ five: 20, weekly: 97, weeklyReset: past }))
    h.payloads.set('s2', payloadEx({ five: 20, weekly: 97, weeklyReset: past }))
    h.payloads.set('s3', payloadEx({ five: 20, weekly: 97, weeklyReset: past }))
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT }); await settle()
    h.coord.handleData({ sessionId: 's2', data: LIMIT_TEXT }); await settle()
    h.coord.handleData({ sessionId: 's3', data: LIMIT_TEXT }); await flush() // 전부 차단 → wait
    const spawnedBefore = h.spawned.length
    await vi.advanceTimersByTimeAsync(30_000) // 하한(60s) 이내
    expect(h.spawned.length).toBe(spawnedBefore) // 아직 재시도 안 함
    await vi.advanceTimersByTimeAsync(40_000) // 누적 70초 > 하한
    expect(h.spawned.length).toBe(spawnedBefore + 1) // 하한 경과 후 재시도
  })
})

// 차단 계정 회피 — 계정별 차단 기록을 랩 초기화가 아니라 시간 만료로 관리한다
const infoPair = (): SessionInfo => ({
  id: 's1', accountId: 'a1', cwd: 'D:\\work\\p', status: 'running', title: 'p', rollAccountIds: ['a1', 'a2']
})

describe('RollingCoordinator 차단 계정 회피', () => {
  it('주간 소진이 기록된 계정으로는 되돌아가지 않고 대기한다', async () => {
    const h = harness()
    const t0 = Date.now()
    h.payloads.set('s1', payloadEx({ five: 95, weekly: 30, fiveReset: new Date(t0 + 10 * MIN).toISOString() }))
    h.payloads.set('s3', payloadEx({ five: 30, weekly: 30 })) // 대기 후 복귀할 a1 세션 (정상)
    h.coord.register(infoPair())
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    expect(h.spawned.at(-1)?.accountId).toBe('a2')
    // a2는 주간 소진 — 전환하자마자 막힌다 (reset은 5시간 뒤)
    h.payloads.set('s2', payloadEx({ five: 1, weekly: 100, weeklyReset: new Date(t0 + 300 * MIN).toISOString() }))
    await settle() // 자동 프롬프트 전송 → awaitingReady 해제
    h.coord.handleData({ sessionId: 's2', data: LIMIT_TEXT })
    await flush() // 둘 다 차단 → a1의 5시간 reset까지 대기
    expect(lastWaiting(h.sent)?.scope).toBe('session')
    await vi.advanceTimersByTimeAsync(14 * MIN) // a1 reset(+10m)+여유 경과 → a1 복귀 + healthy(60s)
    expect(h.spawned.at(-1)?.accountId).toBe('a1')
    const spawnedBefore = h.spawned.length
    // a1이 다시 5시간 한도. a2의 주간 차단은 아직 유효하므로 전환하지 않고 a1의 reset을 기다려야 한다.
    h.payloads.set('s3', payloadEx({ five: 100, weekly: 30, fiveReset: new Date(Date.now() + 180 * MIN).toISOString() }))
    h.coord.handleData({ sessionId: 's3', data: LIMIT_TEXT })
    await flush()
    expect(h.spawned.length).toBe(spawnedBefore) // 주간 소진 계정으로 전환하지 않음
    expect(lastWaiting(h.sent)?.scope).toBe('session')
  })

  it('차단 기록이 만료된 계정은 다시 전환 대상이 된다', async () => {
    const h = harness()
    const t0 = Date.now()
    h.payloads.set('s1', payloadEx({ five: 95, weekly: 30, fiveReset: new Date(t0 + 2 * MIN).toISOString() }))
    h.payloads.set('s2', payloadEx({ five: 30, weekly: 30 }))
    h.coord.register(infoPair())
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush() // → a2. a1은 +2분까지만 차단
    await vi.advanceTimersByTimeAsync(5 * MIN)
    h.payloads.set('s2', payloadEx({ five: 100, weekly: 30, fiveReset: new Date(Date.now() + 60 * MIN).toISOString() }))
    h.coord.handleData({ sessionId: 's2', data: LIMIT_TEXT })
    await flush()
    expect(h.spawned.at(-1)?.accountId).toBe('a1') // 차단이 풀렸으므로 정상 전환
  })

  // 세 워커가 같은 계정들을 돌면 각자 모든 계정에서 한도를 다시 맞아야 했다 — 워커마다 계정마다
  // kill+respawn 한 번이 낭비였고, 그 낭비를 없애는 것이 공유 기록이다(SPEC §11.2/6).
  it('다른 체인이 막힌 계정을 알려 주면 그 계정을 건너뛴다 (몰림 방지)', async () => {
    const h = harness()
    // 체인 1: [a1, a2, a3] — a1 에서 한도 → a2 로 롤. 그 순간 a1 이 공유 기록에 올라간다
    h.payloads.set('s1', payload(97))
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    expect(h.spawned.at(-1)?.accountId).toBe('a2')
    // 체인 2: 같은 계정들을 다른 순서로 도는 둘째 워커. a2 에서 한도를 만나면 라운드 로빈이 가리키는
    // 다음 계정이 a1 이다 — 공유가 없으면 방금 막힌 그 계정으로 그대로 옮겨 간다.
    h.payloads.set('s10', payload(97, 'claude-sess-2', 'D--work-q'))
    h.coord.register({
      ...h.info1,
      id: 's10',
      accountId: 'a2',
      cwd: 'D:\\work\\q',
      rollAccountIds: ['a2', 'a1', 'a3']
    })
    h.coord.handleData({ sessionId: 's10', data: LIMIT_TEXT })
    await flush()
    expect(h.spawned.at(-1)?.accountId).toBe('a3')
  })

  // 오탐 안전 밸브. 공유 기록은 계정에 관한 사실이라 잘못 적히면 그 계정을 도는 모든 체인을 막는다 —
  // 어떤 체인이 그 계정에서 HEALTHY_MS 를 무사히 넘기면 기록을 걷어낸다.
  it('어떤 체인이 그 계정으로 무사히 돌면 공유 기록이 풀린다 (오탐 안전 밸브)', async () => {
    const h = harness()
    // 체인 1: [a2, a1] — a2 에서 한도 → a1 로 롤. 이제 a1 에서 정상으로 돌고 있다
    h.payloads.set('s1', payload(97))
    h.coord.register({ ...h.info1, accountId: 'a2', rollAccountIds: ['a2', 'a1'] })
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    expect(h.spawned.at(-1)?.accountId).toBe('a1')
    h.payloads.set('s2', payload(5)) // 준비 신호 → 자동 프롬프트 → healthy 타이머 무장
    await settle()
    // 체인 2: a1 에서 한도를 보고 그 계정을 공유 기록에 올린다(진짜든 오탐이든)
    h.payloads.set('s10', payload(97, 'claude-sess-2', 'D--work-q'))
    h.coord.register({
      ...h.info1,
      id: 's10',
      accountId: 'a1',
      cwd: 'D:\\work\\q',
      rollAccountIds: ['a1', 'a3']
    })
    h.coord.handleData({ sessionId: 's10', data: LIMIT_TEXT })
    await flush()
    // 중간 체크포인트: 이 시점에는 기록이 살아 있어야 한다. 없으면 아래 마지막 단언이 "기록이
    // 지워졌다"가 아니라 "애초에 공유가 없었다"로도 통과해 버린다.
    h.payloads.set('s30', payload(97, 'claude-sess-4', 'D--work-s'))
    h.coord.register({
      ...h.info1,
      id: 's30',
      accountId: 'a2',
      cwd: 'D:\\work\\s',
      rollAccountIds: ['a2', 'a1', 'a3']
    })
    h.coord.handleData({ sessionId: 's30', data: LIMIT_TEXT })
    await flush()
    expect(h.spawned.at(-1)?.accountId).toBe('a3')
    // 체인 1 이 a1 에서 HEALTHY_MS(60초)를 무사히 넘긴다 → 공유 기록이 지워진다
    await vi.advanceTimersByTimeAsync(65_000)
    // 체인 3: a1 이 다시 후보다. 기록이 남아 있었다면 a3 로 우회한다
    h.payloads.set('s20', payload(97, 'claude-sess-3', 'D--work-r'))
    h.coord.register({
      ...h.info1,
      id: 's20',
      accountId: 'a2',
      cwd: 'D:\\work\\r',
      rollAccountIds: ['a2', 'a1', 'a3']
    })
    h.coord.handleData({ sessionId: 's20', data: LIMIT_TEXT })
    await flush()
    expect(h.spawned.at(-1)?.accountId).toBe('a1')
  })

  // 합쳐진 기록은 pickAvailable 만 먹이는 것이 아니다. planRetry 는 currentIndex 까지 포함해 전부
  // 훑으므로, 남이 적은 기록이 **이 체인이 지금 앉아 있는 계정**의 재시도 시각과 scope 라벨까지
  // 바꾼다. 기록이 맞을 때는 그것이 맞는 동작이고(주간 소진 계정은 5시간 창이 뭐라 하든 못 쓴다),
  // 틀릴 때는 여기가 대가가 가장 큰 자리다 — 대기하는 체인은 그 계정에 도착하지 않으니 healthy
  // 타이머 밸브가 걸리지 않는다.
  //
  // **순서가 핵심이다.** 위 두 테스트는 남의 기록을 자기 판정 **뒤에** 적으므로 이 자리를 지나가지
  // 않는다. 여기서는 먼저 적는다.
  it('다른 체인이 먼저 적은 더 긴 기록이 자기 계정의 대기까지 늘리고 라벨도 바꾼다', async () => {
    const h = harness()
    const t0 = Date.now()
    // 체인 2: 같은 a1 에서 주간 소진 — 60분짜리 기록을 공유 기록에 먼저 올린다
    h.payloads.set('s10', payloadEx({
      sid: 'claude-sess-2', five: 20, weekly: 100, weeklyReset: new Date(t0 + 60 * MIN).toISOString()
    }))
    h.coord.register({ ...h.info1, id: 's10', cwd: 'D:\\work\\q', rollAccountIds: ['a1', 'a2'] })
    // 체인 1: 단일 계정 a1. 자기 증거는 "5시간 창이 2분 뒤 풀린다" 뿐이다
    h.payloads.set('s1', payloadEx({ five: 100, weekly: 20, fiveReset: new Date(t0 + 2 * MIN).toISOString() }))
    h.coord.register({ ...h.info1, rollAccountIds: ['a1'] })
    h.coord.handleData({ sessionId: 's10', data: LIMIT_TEXT })
    await flush()
    expect(h.spawned.at(-1)?.accountId).toBe('a2') // 판정이 인정됐다 = a1 이 공유 기록에 올라갔다
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    const w = lastWaiting(h.sent)
    expect(w?.sessionId).toBe('s1') // 체인 1 의 대기다 — 체인 2 는 롤했으므로 대기를 게시하지 않는다
    // 공유가 없으면 자기 증거만 보고 t0+3분(2분 + 여유 1분)·session 이다. 합쳐지면 더 긴 쪽이
    // 이겨 t0+61분·weekly 로 바뀐다 — 시각뿐 아니라 라벨도 남의 기록을 따른다.
    expect(w?.nextRetryAt).toBe(new Date(t0 + 61 * MIN).toISOString())
    expect(w?.scope).toBe('weekly')
  })

  it('respawn 후 재부착 switching 이벤트에는 reattach 표시가 붙는다 (Slack 중복 방지)', async () => {
    const h = harness()
    h.payloads.set('s1', payload(97))
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    const switches = h.sent.filter((s) => s.payload.state === 'switching')
    expect(switches.map((s) => [s.payload.sessionId, s.payload.reattach])).toEqual([
      ['s1', undefined], // 롤 시작 — 옛 세션 키
      ['s2', true] // 새 세션 키로 배너 재부착 — 알림 대상 아님
    ])
  })
})

// 단일 계정 자동 재개 — rollAccountIds 길이 1: 한도 즉시 대기 후 같은 계정 재개
const infoSelf = (): SessionInfo => ({
  id: 's1', accountId: 'a1', cwd: 'D:\\work\\p', status: 'running', title: 'p', rollAccountIds: ['a1']
})

describe('RollingCoordinator 단일 계정 자동 재개', () => {
  it('5시간 한도 → 리셋까지 대기 후 같은 계정으로 재개', async () => {
    const h = harness()
    const now = Date.now()
    h.payloads.set('s1', payloadEx({ five: 100, weekly: 20, fiveReset: new Date(now + 10 * MIN).toISOString() }))
    h.coord.register(infoSelf())
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT }); await flush()
    expect(lastWaiting(h.sent)?.scope).toBe('session')
    expect(resumeCount(h)).toBe(0) // 즉시 재개하지 않고 리셋까지 대기
    await vi.advanceTimersByTimeAsync(10 * MIN + 2 * MIN)
    // 같은 계정이므로 kill·spawn 없이 살아 있는 세션에 재개 프롬프트만 보낸다
    expect(h.spawned).toEqual([])
    expect(resumeCount(h)).toBe(1)
  })

  it('주간 한도 → 주간 리셋까지 대기 후 같은 계정으로 재개(scope weekly)', async () => {
    const h = harness()
    const now = Date.now()
    h.payloads.set('s1', payloadEx({ five: 20, weekly: 100, weeklyReset: new Date(now + 15 * MIN).toISOString() }))
    h.coord.register(infoSelf())
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT }); await flush()
    expect(lastWaiting(h.sent)?.scope).toBe('weekly')
    await vi.advanceTimersByTimeAsync(15 * MIN + 2 * MIN)
    expect(h.spawned).toEqual([])
    expect(resumeCount(h)).toBe(1)
  })
})

describe('사각지대 3-b — 단일 계정 reset 앵커 후향 판정', () => {
  const single = (h: ReturnType<typeof harness>): SessionInfo => ({ ...h.info1, rollAccountIds: ['a1'] })

  it('reset 후 활동이 재개됐으면(자가 회복) 개입하지 않는다', async () => {
    const resetSec = Math.floor(Date.now() / 1000) + 600 // +10분
    let probed = Date.now() - 60_000
    const h = harness({
      probeActivity: () => Promise.resolve(probed),
      readPending: () => Promise.resolve(1)
    })
    h.payloads.set('s1', payloadReset(95, resetSec)) // 한도 증거 게이트를 넘는 사용률
    h.coord.register(single(h))
    await vi.advanceTimersByTimeAsync(20_000) // 첫 틱 → applyMeta → 앵커 예약
    probed = resetSec * 1000 + 30_000 // 리셋 직후 서브에이전트 파일 갱신 (자가 회복)
    await vi.advanceTimersByTimeAsync(16 * 60_000) // reset(+10분) + GRACE(5분) 경과
    expect(h.written).toEqual([])
    expect(h.events).toEqual([])
  })

  it('reset 전 정지 + pending ≥ 1 + reset 후 무활동 → 살아있는 세션에 프롬프트만 (무파괴), Enter 150ms 뒤 none 게시', async () => {
    // 정각으로 고정 — Enter/none 150ms 타이밍을 ms 오차 없이 딱 잘라 검증하기 위해 (내부적으로
    // reset(+10분)+GRACE(5분)=정확히 15분 뒤 발화하도록 만든다)
    vi.setSystemTime(new Date(2026, 6, 31, 10, 0, 0))
    const start = Date.now()
    const resetSec = Math.floor(start / 1000) + 600
    const h = harness({
      probeActivity: () => Promise.resolve(start - 60_000), // reset 한참 전에 멈춘 활동
      readPending: () => Promise.resolve(1)
    })
    h.payloads.set('s1', payloadReset(95, resetSec)) // 한도 증거 게이트를 넘는 사용률
    h.coord.register(single(h))
    // reset(+10분)+GRACE(5분)=15분 직전까지는 아무것도 전송되지 않는다
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1)
    expect(h.written).toEqual([])
    // 발화 시각(15분) 도달 — 프롬프트는 즉시 쓰지만 Enter는 150ms 뒤로 미룬다 (rolling 규약)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.events).toEqual([]) // kill/copy/spawn 없음
    expect(h.written.map((w) => w.data)).toEqual(['이어서 작업 진행해 줘'])
    expect(
      h.sent.some((s) => s.channel === 'session:rollState' && s.payload.state === 'nudged')
    ).toBe(true)
    // 'none'은 Enter 전송(150ms 뒤) 전에는 게시되지 않는다 — scheduler의 nudged 억제가
    // 그때까지 유지돼야 재개 프롬프트와 스케쥴 발화가 같은 입력 줄에 섞이지 않는다
    await vi.advanceTimersByTimeAsync(149)
    expect(h.sent.some((s) => s.payload.state === 'none')).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.written.map((w) => w.data)).toEqual(['이어서 작업 진행해 줘', '\r'])
    expect(h.sent.some((s) => s.payload.state === 'none')).toBe(true)
  })

  it('pending이 없으면(그냥 idle 세션) 프롬프트를 보내지 않는다', async () => {
    const start = Date.now()
    const resetSec = Math.floor(start / 1000) + 600
    const h = harness({
      probeActivity: () => Promise.resolve(start - 60_000),
      readPending: () => Promise.resolve(0)
    })
    h.payloads.set('s1', payloadReset(95, resetSec))
    h.coord.register(single(h))
    await vi.advanceTimersByTimeAsync(16 * 60_000)
    expect(h.written).toEqual([])
    expect(h.events).toEqual([])
  })

  // 한도 증거 게이트. 이 경로는 reset 시각 도달만으로 발화하므로, 한도로 막힌 흔적이 없으면
  // "사용자가 자리를 비운 정상 세션"에 프롬프트를 밀어 넣는다 — 실제로 관측된 사고다.
  it('사용률이 한도 임계 미달이면 pending이 있어도 프롬프트를 보내지 않는다 — 한도 증거 없음', async () => {
    const start = Date.now()
    const resetSec = Math.floor(start / 1000) + 600
    const h = harness({
      probeActivity: () => Promise.resolve(start - 60_000), // reset 한참 전에 멈춘 활동
      readPending: () => Promise.resolve(1) // 백그라운드 작업은 남아 있다
    })
    h.payloads.set('s1', payloadReset(30, resetSec)) // 30% — 한도로 막힌 세션이 아니다
    h.coord.register(single(h))
    await vi.advanceTimersByTimeAsync(16 * 60_000) // reset(+10분) + GRACE(5분) 경과
    expect(h.written).toEqual([])
    expect(h.events).toEqual([])
  })

  it('동일 resets_at 스냅샷을 반복해도 reset 타이머를 한 번만 예약한다 (재무장 가드)', async () => {
    const resetSec = Math.floor(Date.now() / 1000) + 600
    const h = harness({
      probeActivity: () => Promise.resolve(Date.now()),
      readPending: () => Promise.resolve(1)
    })
    h.payloads.set('s1', payloadReset(84, resetSec))
    h.coord.register(single(h))
    const spy = vi.spyOn(globalThis, 'setTimeout')
    // 여러 틱(15초 간격)에서 동일 스냅샷이 반복 → armResetCheck가 매 틱 호출되지만,
    // 재무장 가드(resetCheckAt === at)로 reset 타이머(지연 > GRACE)는 첫 틱에서만 예약된다.
    await vi.advanceTimersByTimeAsync(45_000)
    const resetArms = spy.mock.calls.filter((c) => typeof c[1] === 'number' && c[1] > 5 * 60_000)
    expect(resetArms).toHaveLength(1)
    spy.mockRestore()
  })

  // 한도 문구의 reset 시각을 1차 소스로 쓴다 — 스냅샷은 한도로 멈춘 순간부터
  // 얼어 있을 수 있어 신뢰하지 않는다. 아래 5건은 recordRecovery가 private이라 관측 가능한
  // 결과(재개 시각)로만 검증한다 — 위 605-680 라인의 payloadReset + advanceTimersByTimeAsync
  // 패턴을 그대로 따른다.
  it('문구의 reset 시각을 스냅샷보다 우선한다 — 스냅샷이 더 늦어도', async () => {
    // 2026-08-03 09:00 KST. 문구는 11am(2시간 뒤), 스냅샷은 게이트를 넘은 5시간 창이 8시간 뒤.
    // 스냅샷을 쓰면 8시간을 기다린다 — 그 값은 얼어 있을 수 있어 신뢰하지 않는다.
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 3, 0, 0))) // 09:00 KST
    const h = harness()
    const snapshotReset = Math.floor(Date.UTC(2026, 7, 3, 8, 0) / 1000) // 17:00 KST = 8시간 뒤
    h.payloads.set('s1', payloadReset(95, snapshotReset))
    h.coord.register({ ...h.info1, rollAccountIds: ['a1'] }) // 단일 계정 → 대기 경로
    await flush()
    h.coord.handleData({ sessionId: 's1', data: limitWithReset('session', '11am') })
    await vi.advanceTimersByTimeAsync(300)
    expect(resumeCount(h)).toBe(0) // 아직 재롤 없음
    // 문구의 11am(+여유 1분)이면 2시간 1분 뒤 재개. 스냅샷의 8시간을 썼다면 여기서 안 뜬다.
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000 + 90_000)
    expect(resumeCount(h)).toBe(1)
  })

  it('문구 파싱이 실패하면 스냅샷 게이트로 떨어진다 — 기존 동작', async () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 3, 0, 0)))
    const h = harness()
    const snapshotReset = Math.floor(Date.UTC(2026, 7, 3, 0, 30) / 1000) // 30분 뒤
    h.payloads.set('s1', payloadReset(95, snapshotReset))
    h.coord.register({ ...h.info1, rollAccountIds: ['a1'] })
    await flush()
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT }) // reset 시각 없는 옛 문구
    await vi.advanceTimersByTimeAsync(300)
    expect(resumeCount(h)).toBe(0)
    // 중간 체크포인트(Fix round 1 리뷰): 이 한 번의 최종 검사만으로는 recordRecovery가
    // `fromText`(파싱 결과) 대신 인접한 동명의 `text`(원문)로 게이트를 판정해도 못 잡는다 —
    // text는 파싱 실패해도 진리값이 참이라 스냅샷을 잘못 버리고 블라인드 폴백(RETRY_FALLBACK_MS=
    // 15분, hasReset=false라 마진 없음)으로 떨어지는데, 20분 지점에서 봐도 이미 1건이라 그
    // 회귀를 놓친다. 20분은 그 버그 후보(15분, +5분 여유)를 지났지만 올바른 스냅샷 후보
    // (30분+RETRY_MARGIN_MS=31분, -11분 여유)에는 못 미친다 — 버그가 있으면 여기서 이미 1건이
    // 관측된다.
    await vi.advanceTimersByTimeAsync(20 * 60_000 - 300)
    expect(resumeCount(h)).toBe(0)
    await vi.advanceTimersByTimeAsync(11 * 60_000 + 90_000) // 31분 통과 + 여유
    expect(resumeCount(h)).toBe(1)
  })

  it('스냅샷이 없어도 문구가 있으면 그 시각을 쓴다', async () => {
    // 종전에는 payload가 없으면 recordRecovery를 건너뛰어 recovery[i]가 null로 남고
    // planRetry가 now+15분으로 취급했다. 문구를 손에 들고 있는데 캡처 파일이 없다는
    // 이유로 정확한 시각을 버리는 셈이었다.
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 3, 0, 0))) // 09:00 KST
    const h = harness()
    // payloads를 비워 둔다 → 한도 감지 시점의 readStatusPayload가 null — recordRecovery가
    // 스냅샷 없이 문구만으로 기록해야 함을 검증한다.
    h.coord.register({ ...h.info1, rollAccountIds: ['a1'] })
    await flush()
    h.coord.handleData({ sessionId: 's1', data: limitWithReset('session', '11am') })
    await vi.advanceTimersByTimeAsync(300)
    expect(resumeCount(h)).toBe(0)
    // 여기서 뒤늦게 스냅샷을 채워도 위에서 이미 문구로 기록된 recovery.at에는 영향이 없다 —
    // 이 테스트가 검증하려는 판정은 이미 끝났다. 단일 계정이라 대기 만료는 resumeInPlace로 가고
    // 그쪽은 세션 메타 없이도 재개하므로, 이 줄은 재개의 전제 조건이 아니라 대기 중에도 체인이
    // 정상적으로 메타를 학습한다는 현실을 맞춰 주는 것뿐이다.
    h.payloads.set('s1', payload(5))
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 60_000) // 옛 15분 폴백이면 여기서 재개
    expect(resumeCount(h)).toBe(0)
    // 누적 16분 + 108분 = 124분 → 문구의 11am(2시간1분=121분) 경과, 여유 약 3분.
    // (브리프 초안의 105분은 121분에 300ms 여유만 남겨 타이밍이 조금이라도 어긋나면 깨졌다 —
    // 여유를 넓힌다. 후속 구현 시 조정.)
    await vi.advanceTimersByTimeAsync(108 * 60_000)
    expect(resumeCount(h)).toBe(1)
  })

  it('스냅샷도 문구도 없으면 15분 폴백 — 기존 동작', async () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 3, 0, 0)))
    const h = harness()
    h.coord.register({ ...h.info1, rollAccountIds: ['a1'] })
    await flush()
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await vi.advanceTimersByTimeAsync(300)
    expect(resumeCount(h)).toBe(0)
    // 위 테스트와 같은 이유로 뒤늦게 채운다 — 재개의 전제는 아니고 대기 중 메타 학습을 맞춰 준다.
    h.payloads.set('s1', payload(5))
    // 중간 체크포인트(Fix round 1 리뷰): 여기엔 문구도 스냅샷도 없어 recordRecovery가 남길 수
    // 있는 경쟁 정보가 없으므로 text/fromText 혼동 버그는 이 테스트에서 원천적으로 관측되지
    // 않는다(payload가 null이라 어느 쪽으로 게이트를 걸어도 u는 null). 대신 retry.ts에서 서로
    // 값이 다른(RETRY_MIN_FLOOR_MS=1분 vs RETRY_FALLBACK_MS=15분) 두 상수를 혼동해 retryAt이
    // 하한(1분) 자체로 붕괴하는 회귀를 잡는다. 5분은 하한(+4분 여유)을 지났지만 올바른 폴백
    // (15분, -10분 여유)에는 못 미친다.
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 300)
    expect(resumeCount(h)).toBe(0)
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 90_000) // 15분 통과 + 여유
    expect(resumeCount(h)).toBe(1)
  })

  it('weekly 문구는 BlockRecord.weekly를 세워 scope=weekly로 반영한다 (Slack 알림 문구의 입력)', async () => {
    // 스냅샷은 5시간 창만 게이트를 넘겼다(weekly=false로 기록됐을 것) — 문구가 주간이라고
    // 말하므로 그 쪽이 맞다. scope는 planRetry를 거쳐 'waiting' 이벤트로 나가고, 렌더러
    // (TerminalView.tsx)가 'session.terminal.weeklyLimitWaiting'로 번역해 Slack 알림 문구까지
    // 이어진다 — RollingCoordinator 계층에서는 scope 필드까지만 검증한다.
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 3, 0, 0)))
    const h = harness()
    h.payloads.set('s1', payloadReset(95, Math.floor(Date.UTC(2026, 7, 3, 1, 0) / 1000)))
    h.coord.register({ ...h.info1, rollAccountIds: ['a1'], slackNotify: true })
    await flush()
    h.coord.handleData({ sessionId: 's1', data: limitWithReset('weekly', '7pm') })
    await vi.advanceTimersByTimeAsync(300)
    expect(lastWaiting(h.sent)?.scope).toBe('weekly')
  })
})

describe('상태 세대 가드 — 지연된 none이 최신 상태를 덮어쓰지 않는다', () => {
  it('sendPrompt Enter 대기(150ms) 중 방해가 있으면 지연된 none을 건너뛴다', async () => {
    const h = harness()
    // 2계정 체인에서 연속 2회째 한도 감지는 RollCycle이 스트릭 규칙(streak % count === 0,
    // core/rolling/cycle.ts)으로 무조건 wait를 반환한다 — action.type !== 'roll'이라 pickAvailable은
    // 아예 호출되지 않는다. 즉 이 테스트가 'waiting'을 얻는 근거는 recordRecovery의 차단 기록이나
    // resets_at 유무가 아니라 RollCycle의 수학적 계약이다(따라서 타이밍 우연이 아니라 결정론적).
    const info = { ...h.info1, rollAccountIds: ['a1', 'a2'] }
    h.payloads.set('s1', payload(97))
    h.coord.register(info)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT }) // → a2(s2)
    await flush()
    expect(h.spawned.at(-1)?.accountId).toBe('a2')
    h.payloads.set('s2', payload(5, 'claude-sess')) // 낮은 사용량 statusline — 프롬프트 트리거용
    await vi.advanceTimersByTimeAsync(1_000) // READY_POLL → sendPrompt: 프롬프트 write + Enter 150ms 타이머 예약(세대 캡처)
    expect(h.written.some((w) => w.id === 's2' && w.data === '이어서 작업 진행해 줘')).toBe(true)
    // Enter 대기 중 방해: 한도 게이트를 넘는 statusline + 한도 문구 → onLimitCandidate → onLimit →
    // RollCycle이 wait 반환(위 주석) → 'waiting' 게시(세대 전진)
    h.payloads.set('s2', payload(97, 'claude-sess'))
    h.coord.handleData({ sessionId: 's2', data: LIMIT_TEXT })
    await flush()
    const waiting = h.sent.find((s) => s.payload.state === 'waiting')
    expect(waiting).toBeDefined()
    await vi.advanceTimersByTimeAsync(150) // 원래 Enter 타이머 발화 시점
    expect(h.written.at(-1)).toEqual({ id: 's2', data: '\r' }) // Enter는 세대와 무관하게 그대로 전송된다
    expect(h.sent.some((s) => s.payload.state === 'none')).toBe(false) // 지연 none은 낡은 세대라 건너뜀
    expect(h.sent.at(-1)).toBe(waiting) // 'waiting'이 마지막 rollState로 유지된다
  })

  it('resetAnchorCheck(nudge) Enter 대기(150ms) 중 방해가 있으면 지연된 none을 건너뛴다', async () => {
    vi.setSystemTime(new Date(2026, 6, 31, 10, 0, 0)) // 정각 고정 — 기존 테스트와 동일한 15분 타이밍
    const start = Date.now()
    const resetSec = Math.floor(start / 1000) + 600
    const h = harness({
      probeActivity: () => Promise.resolve(start - 60_000), // reset 한참 전에 멈춘 활동
      readPending: () => Promise.resolve(1)
    })
    h.payloads.set('s1', payloadReset(95, resetSec)) // 한도 증거 게이트를 넘는 사용률
    h.coord.register({ ...h.info1, rollAccountIds: ['a1'] })
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1)
    expect(h.written).toEqual([])
    await vi.advanceTimersByTimeAsync(1) // reset(+10분)+GRACE(5분) 도달 → nudge, Enter 150ms 타이머 예약(세대 캡처)
    expect(h.written.map((w) => w.data)).toEqual(['이어서 작업 진행해 줘'])
    // Enter 대기 중 방해: 한도 게이트를 넘는 statusline + 한도 문구 → onLimitCandidate → onLimit.
    // 단일 계정(count=1)은 RollCycle.onLimit이 항상 wait를 반환하므로 예외 없이 'waiting'이 게시된다
    h.payloads.set('s1', payload(97, 'claude-sess'))
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    const waiting = h.sent.find((s) => s.payload.state === 'waiting')
    expect(waiting).toBeDefined()
    await vi.advanceTimersByTimeAsync(150) // 원래 Enter 타이머 발화 시점
    expect(h.written.map((w) => w.data)).toEqual(['이어서 작업 진행해 줘', '\r']) // Enter는 그대로 전송된다
    expect(h.sent.some((s) => s.payload.state === 'none')).toBe(false) // 지연 none은 낡은 세대라 건너뜀
    expect(h.sent.at(-1)).toBe(waiting) // 'waiting'이 마지막 rollState로 유지된다
  })
})

it('claudeSessionId 최초 학습 시 롤링 설정을 1회 persist하고 재학습엔 저장하지 않는다', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const persisted: { sid: string; cfg: { accountIds: string[]; prompt?: string } }[] = []
  const h = harness({ persistConfig: (sid, cfg) => persisted.push({ sid, cfg }) })
  h.coord.register(h.info1) // rollAccountIds a1,a2,a3
  h.payloads.set('s1', payload(50)) // session_id 'claude-sess', five=50 → 롤 트리거 없음
  await vi.advanceTimersByTimeAsync(15_000) // TICK_MS → tick → applyMeta → persist
  expect(persisted).toEqual([
    { sid: 'claude-sess', cfg: { accountIds: ['a1', 'a2', 'a3'], prompt: '이어서 작업 진행해 줘' } }
  ])
  await vi.advanceTimersByTimeAsync(15_000) // 두 번째 틱 — 이미 학습됨 → 재persist 없음
  expect(persisted).toHaveLength(1)
  vi.useRealTimers()
})

describe('idle nudge', () => {
  const idleHook = { hook_event_name: 'Notification', message: 'Claude is waiting for your input' }
  const MIN = 60_000

  // notification_type이 실린 페이로드로 실제 진입점을 통과시킨다. 순수 함수 단위 테스트만으로는
  // 필드가 onHookEvent에서 판정 함수까지 실제로 전달되는지 검증되지 않는다 — 캐스트나 필드명이
  // 어긋나도 문구 폴백이 받아내며 조용히 통과한다.
  it('notification_type=idle_prompt만으로 nudge가 나간다 (문구 없이)', async () => {
    const h = harness({
      probeActivity: () => Promise.resolve(Date.now() - 20 * MIN),
      readPending: () => Promise.resolve(null)
    })
    h.payloads.set('s1', payload(95))
    h.coord.register(h.info1)
    h.coord.onHookEvent('s1', { hook_event_name: 'Notification', notification_type: 'idle_prompt' })
    // payload(95)의 transcript_path는 존재하지 않는 더미 경로다. tick()이 이제 limitTailCheck(①)를
    // await한 뒤에야 idleNudgeCheck를 평가하므로, ①의 실패 판정(open() 실패)이 실제로
    // 안착해야 아래 idleNudgeCheck가 계속 돌 수 있다 — 순수 fake-timer 진행만으로는 그 완료 콜백이
    // 돌지 않는다(파일 하단 advanceIo 주석 참고). advanceIo로 바꿔 실제 타이머 틱을 끼워 넣는다.
    await advanceIo(11 * MIN)
    // nudge의 Enter는 advanceIo가 실제 I/O를 안착시킨 "뒤"에야 예약되는 페이크 타이머(150ms)라
    // advanceIo 자체의 0ms 보정으론 못 잡는다 — 그 시점부터 별도로 페이크 시간을 더 흘려준다.
    await vi.advanceTimersByTimeAsync(200)
    expect(h.written.map((w) => w.data)).toEqual(['이어서 작업 진행해 줘', '\r'])
  })

  it('타입이 유휴가 아니면 문구가 유휴여도 nudge하지 않는다 — 타입이 우선', async () => {
    const h = harness({
      probeActivity: () => Promise.resolve(Date.now() - 20 * MIN),
      readPending: () => Promise.resolve(null)
    })
    h.payloads.set('s1', payload(95))
    h.coord.register(h.info1)
    h.coord.onHookEvent('s1', {
      hook_event_name: 'Notification',
      notification_type: 'worker_permission_prompt',
      message: 'Claude is waiting for your input'
    })
    await vi.advanceTimersByTimeAsync(11 * MIN)
    expect(h.written).toEqual([])
  })

  it('Notification 후 10분 정지가 이어지면 프롬프트를 1회 보낸다', async () => {
    const h = harness({
      probeActivity: () => Promise.resolve(Date.now() - 20 * MIN),
      readPending: () => Promise.resolve(null)
    })
    h.payloads.set('s1', payload(95))
    h.coord.register(h.info1)
    h.coord.onHookEvent('s1', idleHook)
    // advanceIo가 필요한 이유는 위 idle_prompt 테스트와 동일 — 더미 transcript_path에 대한 ①의
    // 실패 판정이 실제로 안착해야 idleNudgeCheck가 계속 돈다
    await advanceIo(11 * MIN)
    await vi.advanceTimersByTimeAsync(200) // nudge의 Enter(150ms 페이크 타이머) — 이유는 위와 동일
    expect(h.written.map((w) => w.data)).toEqual(['이어서 작업 진행해 줘', '\r'])
  })

  // Dispatch 가 닫힌 워커 세션. 위 테스트와 setup 이 같고 unregister 한 줄만 다르다 — 그것이
  // 이 부정 단언의 근거다(위가 통과하는 동안에만 이 테스트가 무언가를 증명한다).
  it('unregister한 세션은 유휴 알림에도 프롬프트를 받지 않는다', async () => {
    const h = harness({
      probeActivity: () => Promise.resolve(Date.now() - 20 * MIN),
      readPending: () => Promise.resolve(null)
    })
    h.payloads.set('s1', payload(95))
    h.coord.register(h.info1)
    h.coord.unregister('s1') // Dispatch 가 닫혔다 — 세션은 살아 있다
    h.coord.onHookEvent('s1', idleHook)
    await advanceIo(11 * MIN)
    await vi.advanceTimersByTimeAsync(200)
    expect(h.written).toEqual([])
  })

  it('unregister는 등록되지 않은 id에 무해하다 — 다른 체인도 건드리지 않는다', async () => {
    const h = harness({
      probeActivity: () => Promise.resolve(Date.now() - 20 * MIN),
      readPending: () => Promise.resolve(null)
    })
    h.payloads.set('s1', payload(95))
    h.coord.register(h.info1)
    expect(() => h.coord.unregister('s-nope')).not.toThrow()
    h.coord.onHookEvent('s1', idleHook)
    await advanceIo(11 * MIN)
    await vi.advanceTimersByTimeAsync(200)
    expect(h.written.map((w) => w.data)).toEqual(['이어서 작업 진행해 줘', '\r'])
  })

  it('같은 스톨에서 두 번 nudge하지 않고 stalled로 사람을 부른다', async () => {
    const h = harness({
      probeActivity: () => Promise.resolve(Date.now() - 20 * MIN),
      readPending: () => Promise.resolve(null)
    })
    h.payloads.set('s1', payload(95))
    h.coord.register(h.info1)
    h.coord.onHookEvent('s1', idleHook)
    await advanceIo(11 * MIN) // 1회차 nudge (advanceIo 필요 이유는 위와 동일)
    await vi.advanceTimersByTimeAsync(200) // nudge의 Enter(150ms 페이크 타이머) — 위 첫 테스트와 동일 이유
    const afterFirst = h.written.length
    await advanceIo(11 * MIN) // 계속 정지 → stalled
    expect(h.written.length).toBe(afterFirst) // 추가 입력 없음
    expect(h.sent.filter((s) => s.payload.state === 'stalled').length).toBe(1)
  })

  it('10분 안에 출력이 있으면 nudge하지 않는다', async () => {
    const h = harness({
      probeActivity: () => Promise.resolve(Date.now()),
      readPending: () => Promise.resolve(null)
    })
    h.payloads.set('s1', payload(95))
    h.coord.register(h.info1)
    h.coord.onHookEvent('s1', idleHook)
    // 이 테스트는 실패하지 않았어도 advanceIo로 바꾼다 — 그대로 두면 tickChain이 더미 경로의 ①
    // 판정에 막혀 idleNudgeCheck가 전혀 안 돌아도 기대값(빈 배열)이 우연히 같아, "최근 활동이면
    // nudge 안 함"을 더는 검증하지 못하는 채로 조용히 통과한다
    await advanceIo(5 * MIN)
    h.coord.handleData({ sessionId: 's1', data: 'still working' }) // 활동 재개
    await advanceIo(11 * MIN)
    expect(h.written).toEqual([])
  })

  it('권한 요청 Notification은 nudge하지 않는다 — 선택지에 텍스트를 밀어 넣지 않는다', async () => {
    const h = harness({
      probeActivity: () => Promise.resolve(Date.now() - 20 * MIN),
      readPending: () => Promise.resolve(null)
    })
    h.payloads.set('s1', payload(95))
    h.coord.register(h.info1)
    h.coord.onHookEvent('s1', {
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash'
    })
    await vi.advanceTimersByTimeAsync(11 * MIN)
    expect(h.written).toEqual([])
  })

  it('nudge 직후의 echo는 스톨 상태를 지우지 않는다 — 재nudge 루프 방지', async () => {
    const h = harness({
      probeActivity: () => Promise.resolve(Date.now() - 20 * MIN),
      readPending: () => Promise.resolve(null)
    })
    h.payloads.set('s1', payload(95))
    h.coord.register(h.info1)
    h.coord.onHookEvent('s1', idleHook)
    await advanceIo(10 * MIN) // 1회차 nudge 발화 (grace 안, advanceIo 이유는 위와 동일)
    await vi.advanceTimersByTimeAsync(200) // Enter(150ms 페이크 타이머)까지만 — 위 첫 테스트와 동일 이유
    const afterFirst = h.written.length
    // nudge가 쓴 프롬프트가 PTY echo로 되돌아오는 것을 재현 (grace 창 안)
    h.coord.handleData({ sessionId: 's1', data: '이어서 작업 진행해 줘' })
    await advanceIo(11 * MIN)
    // echo로 상태가 지워졌다면 여기서 2회차 nudge가 나간다 — 나가면 안 된다
    expect(h.written.length).toBe(afterFirst)
    expect(h.sent.filter((s) => s.payload.state === 'stalled').length).toBe(1)
  })

  it('grace 창을 지난 실제 응답은 스톨을 해제해 다음 스톨에서 다시 nudge할 수 있다', async () => {
    const h = harness({
      probeActivity: () => Promise.resolve(Date.now() - 20 * MIN),
      readPending: () => Promise.resolve(null)
    })
    h.payloads.set('s1', payload(95))
    h.coord.register(h.info1)
    h.coord.onHookEvent('s1', idleHook)
    await advanceIo(11 * MIN) // 1회차 nudge (advanceIo 이유는 위와 동일)
    const afterFirst = h.written.length
    await advanceIo(5_000) // NUDGE_ECHO_GRACE_MS 경과
    h.coord.handleData({ sessionId: 's1', data: 'Claude가 실제로 응답을 시작한 출력' })
    h.coord.onHookEvent('s1', idleHook) // 새 스톨
    await advanceIo(11 * MIN)
    expect(h.written.length).toBeGreaterThan(afterFirst) // 2회차 nudge가 나가야 한다
  })

  it('스톨이 이어지는 동안 Notification이 반복돼도 nudge 시각을 미루지 않는다', async () => {
    const h = harness({
      probeActivity: () => Promise.resolve(Date.now() - 20 * MIN),
      readPending: () => Promise.resolve(null)
    })
    h.payloads.set('s1', payload(95))
    h.coord.register(h.info1)
    h.coord.onHookEvent('s1', idleHook)
    await advanceIo(5 * MIN)
    h.coord.onHookEvent('s1', idleHook) // 같은 스톨의 반복 알림 — 시계를 되돌리면 안 된다
    await advanceIo(5 * MIN + 30_000)
    expect(h.written.length).toBeGreaterThan(0) // 첫 알림 기준 10분이 지났으므로 nudge가 나가야 한다
  })

  // 한도 증거 게이트. idle_prompt Notification은 "턴이 정상 종료되고 사용자 차례"에도 발화하므로
  // (core/hooks/notification.ts), 이 게이트가 없으면 자리를 비운 정상 세션이 프롬프트를 받는다 —
  // 실제로 관측된 사고다(한도 감지 기록이 전혀 없는 세션에서 nudge 발화).
  it('사용률이 한도 임계 미달이면 정지가 이어져도 nudge하지 않는다 — 한도 증거 없음', async () => {
    const h = harness({
      probeActivity: () => Promise.resolve(Date.now() - 20 * MIN),
      readPending: () => Promise.resolve(null)
    })
    h.payloads.set('s1', payload(30)) // 30% — 한도로 막힌 세션이 아니다
    h.coord.register(h.info1)
    h.coord.onHookEvent('s1', idleHook)
    await advanceIo(11 * MIN)
    await vi.advanceTimersByTimeAsync(200)
    expect(h.written).toEqual([])
  })

  // 이 테스트는 종전에 **idle nudge 가** 멈춘 세션을 되살리는 것을 검사했다(롤이 중단되면 체인이
  // 대기도 아니고 롤링도 아닌 상태로 남았으므로 틱이 그 체인을 계속 봤다). 중단이 이제 재시도를
  // 예약하므로 그 전제가 사라졌다 — 대기가 걸린 체인은 틱이 건너뛰고(waitTimer 가드), 그와 함께
  // 감지·폴백·nudge 가 모두 멈춘다. 되살리는 것은 이제 nudge 가 아니라 그 예약된 재시도다.
  //
  // 그래서 검사 대상을 그 우선순위로 바꾼다: 대기 중에는 아무것도 세션에 쓰지 않고(nudge 가
  // 끼어들면 예약된 재시도와 두 번 개입한다), 예약된 시각에 재개 문장이 들어간다. 종전 기대값과
  // 같은 문장이 같은 세션에 들어가는 것이고, 다른 것은 그것을 넣는 경로와 시각이다.
  it('롤이 실패해 멈춘 세션은 예약된 재시도가 되살린다 — 대기 중에는 nudge하지 않는다', async () => {
    // probeActivity·readPending 오버라이드가 없다: 대기의 억제는 **틱 자체**에서 걸려
    // (tick 의 waitTimer 가드) idleNudgeCheck 가 아예 호출되지 않으므로, nudge 의 전제 조건을
    // 차려 놓아도 이 테스트에서는 아무것도 달라지지 않는다.
    const h = harness({
      // a2를 못 찾게 해 롤을 중단시킨다 → 중단이 재시도를 예약한다(rolling.ts 의 rescheduleAbortedRoll)
      getAccount: (id) => (id === 'a1' ? acc('a1', '계정A') : null)
    })
    h.payloads.set('s1', payload(30)) // 스냅샷은 게이트 미달 — 차단 기록만이 증거다
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    expect(h.events).toEqual([]) // 롤 중단 — copy/kill/spawn 없음
    const retryAt = Date.parse(String(h.sent.at(-1)?.payload.nextRetryAt))
    expect(retryAt).toBeGreaterThan(Date.now())
    h.coord.onHookEvent('s1', idleHook)
    await advanceIo(11 * MIN)
    await vi.advanceTimersByTimeAsync(200)
    expect(h.written).toEqual([]) // 대기 중 — nudge 가 끼어들지 않는다
    await advanceIo(retryAt - Date.now() + 1_000) // 예약된 시각
    await vi.advanceTimersByTimeAsync(200) // 150ms 엔터 타이머
    expect(h.written.map((w) => w.data)).toEqual(['이어서 작업 진행해 줘', '\r'])
    expect(h.events).toEqual([]) // 같은 계정이므로 kill·spawn 없이 제자리 재개다
  })

  // `limitEvidence` 의 분기 ①(현재 계정에 차단 기록이 있으면 사용률이 낮아도 nudge 한다)을 위한
  // 테스트. 위의 테스트가 종전에 이 분기를 덮고 있었고, 중단이 재시도를 예약하게 되면서 그 경로로는
  // 더 이상 이 상태에 닿을 수 없다 — 그래서 **살아 있는 생산자**로 다시 덮는다.
  //
  // 살아 있는 생산자는 이것이다: `roll()` 은 `chain.recovery` 를 지우지 않고, healthy 타이머는
  // **현재 칸만** 지운다(다른 계정의 기록은 남긴다). 그래서 기록이 남은 계정으로 되돌아오면 그 기록이
  // 현재 칸의 기록이 된다. 그 뒤 자동 프롬프트가 120초 만료로 'stalled' 로 끝나면 — 그 경로는
  // awaitingReady 만 풀고 프롬프트를 보내지 않으므로 **healthy 타이머가 걸리지 않는다** — 기록은
  // 지워지지 않은 채 체인이 다시 틱 대상이 된다. 스냅숏은 없으니(분기 ②는 false) nudge 를 내는 것은
  // 분기 ① 하나뿐이고, 관측되는 결과는 살아 있는 PTY 로 나가는 재개 문장이다.
  it('되돌아온 계정에 차단 기록이 남아 있으면 사용률 근거 없이도 nudge한다', async () => {
    const T0 = Date.UTC(2026, 7, 3, 0, 0)
    vi.setSystemTime(new Date(T0))
    const h = harness({
      probeActivity: () => Promise.resolve(Date.now() - 20 * MIN), // 서브에이전트 활동 없음
      readPending: () => Promise.resolve(null)
    })
    const twoAccounts = { ...h.info1, rollAccountIds: ['a1', 'a2'] }
    // a1 의 차단은 2분 뒤 풀린다 — 그래야 아래에서 a1 으로 되돌아올 수 있다
    h.payloads.set('s1', payloadReset(97, Math.floor((T0 + 2 * MIN) / 1000)))
    h.payloads.set('s2', payloadEx({ five: 20 })) // a2 는 멀쩡하다 → 자동 프롬프트가 정상 발화해 healthy 타이머를 건다
    h.coord.register(twoAccounts)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advanceIo(3 * MIN) // a1 → a2 롤 + healthy 타이머(60초)로 recovery[a2] 정리. recovery[a1] 은 남는다
    expect(h.spawned.at(-1)?.accountId).toBe('a2')
    // a2 도 한도에 걸린다 → a1 의 차단은 이미 풀렸으므로 a1 으로 되돌아간다
    h.coord.handleData({ sessionId: 's2', data: LIMIT_TEXT })
    await advanceIo(1_000)
    expect(h.spawned.at(-1)?.accountId).toBe('a1') // 기록이 남아 있는 칸으로 돌아왔다
    const liveId = h.spawned.at(-1)!.id
    // 자동 프롬프트를 30초 폴백에서 붙잡아 둔다(화면에 인식 못한 대화상자가 떠 있는 모양) → 120초
    // 만료가 'stalled' 로 끝나고 프롬프트도 healthy 타이머도 없다. s3 의 statusLine 은 주지 않으므로
    // lastUsagePct 는 null 로 남는다 — 분기 ② 는 성립하지 않는다.
    h.coord.handleData({ sessionId: liveId, data: WAIT_DIALOG })
    await advanceIo(2 * MIN + 10_000)
    expect(h.sent.at(-1)?.payload.state).toBe('stalled')
    expect(h.written.filter((w) => w.id === liveId)).toEqual([]) // 자동 프롬프트는 나가지 않았다
    // 이제 정지가 이어진다 → 근거는 남은 차단 기록 하나뿐이다
    h.coord.onHookEvent(liveId, idleHook)
    await advanceIo(11 * MIN)
    await vi.advanceTimersByTimeAsync(200) // 150ms 엔터 타이머
    expect(h.written.filter((w) => w.id === liveId).map((w) => w.data)).toEqual([
      '이어서 작업 진행해 줘',
      '\r'
    ])
  })
})

// 코디네이터는 진짜 transcript 파일을 읽는다(ClaudeTranscriptTail → JsonlTail). fake timer가 걸린
// 동안에는 실제 fs I/O 완료 콜백이 돌지 않아, 타이머만 진행시키면 폴링이 파일을 못 본 채로 끝난다 —
// 롤 복사 진행 중 dispose 가드. 복사 await 중에 unregister가 체인을 폐기했으면 roll은
// kill과 respawn을 하지 않고 반환한다. 폐기된 체인을 맵에 다시 집어넣지 않으므로 좀비 프로세스가 생기지 않는다.
describe('roll() disposed 가드', () => {
  it('복사 진행 중 unregister 호출하면 kill·spawn하지 않고 반환한다', async () => {
    let copyResolve: () => void = () => {}
    const copyPromise = new Promise<void>((r) => (copyResolve = r))
    let copied = false
    const h = harness({
      copy: () => {
        copied = true
        return copyPromise
      },
      probeActivity: () => Promise.resolve(null) // 무출력 폴백 회피
    })
    h.payloads.set('s1', payload(97))
    h.coord.register(h.info1)
    // 롤 시작 — copy await에 진입한다
    void h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    // 이벤트 루프가 진행되면 handleData가 비동기 경로(onLimitCandidate)를 시작하고
    // 그것이 roll을 차이기에 roll도 들어간다. copy가 pending이므로 거기서 멈춘다.
    await flush()
    expect(copied).toBe(true) // copy는 호출됐다
    expect(h.events).not.toContain('kill:s1') // 아직 kill은 없다
    expect(h.spawned).toEqual([]) // respawn도 없다
    // 복사 진행 중에 unregister 호출
    h.coord.unregister('s1')
    expect(h.events).not.toContain('kill:s1') // 이 시점에도 kill은 여전히 없다
    // 복사가 마지막으로 완료된다
    copyResolve()
    await flush()
    // kill과 spawn이 없다 — disposed 가드가 kill을 막았다
    expect(h.events).not.toContain('kill:s1')
    expect(h.spawned).toEqual([])
    // 새 세션 id를 받지 않으므로 s1은 여전히 live (다만 폐기됨으로 표시)
    expect(h.coord.findLiveByClaudeSession('claude-sess')).toBeNull()
  })
})

// codexRolling.test.ts가 같은 문제(진짜 rollout 파일 + fake timer)에서 쓴 것과 동일한 처방이다.
// fake 타이머를 진행시킨 뒤 실제 타이머로 이벤트 루프에 시간을 줘서 I/O를 정착시킨다.
const realSetTimeout = setTimeout
// 하네스가 등록하는 "지금까지 기록된 이벤트 수" 프로브. 여러 하네스가 살아 있을 수 있으니 배열이다
const ioProbes: (() => number)[] = []
const ioActivity = (): number => ioProbes.reduce((n, p) => n + p(), 0)

/** 지금 떠 있는 실제 fs 작업의 수. `settleIo` 가 기다릴 대상이다.
 *
 *  **기록 수로는 이것을 알 수 없다.** ioActivity() 는 코디네이터가 남긴 *출력*(이벤트·전송·복사·
 *  spawn)을 세는데, 읽기가 출력을 만들지 않는 호출이 있다 — 예를 들어 rollout 매핑 폴링은 파일을
 *  읽어 매핑만 세우므로 어느 배열도 늘어나지 않는다. 그런 자리에서 출력을 기준으로 기다리면
 *  기다릴 대상이 없어 곧바로 나가고, 정확히 그 읽기가 늦을 때 다음 단언이 무너진다.
 *
 *  그래서 출력이 아니라 **I/O 자체**를 본다. fs/promises 의 각 작업은 FSREQPROMISE 비동기 자원을
 *  만들고, async_hooks 로 그 생성과 완료를 세면 "지금 읽는 중인가"를 직접 물어볼 수 있다. */
const fsInFlight = new Set<number>()
createHook({
  init(id, type) {
    if (type.startsWith('FSREQ')) fsInFlight.add(id)
  },
  after(id) {
    fsInFlight.delete(id)
  },
  destroy(id) {
    fsInFlight.delete(id)
  }
}).enable()

/** 실제 fs I/O가 정착할 때까지 이벤트 루프에 실제 시간을 준다.
 *
 *  두 번의 처방이 이 자리에서 실패했다. 처음에는 30ms(5ms×6) 고정 예산이었다 — 한가한 머신에서만
 *  충분해서, 워커가 붐비면 폴링이 파일을 못 본 채로 끝났다. 다음에는 "기록이 늘어나는 동안 더
 *  기다린다"로 바꿨는데 **아직 시작하지 않은 I/O 는 조용한 것과 구별되지 않아** 첫 콜백 전에 조건이
 *  차 버렸다. 계측으로 확인했다: 유휴 머신에서 모든 호출이 예외 없이 최소 라운드에서 끝나고, 상한도
 *  활동 대기도 한 번도 발동하지 않는다 — 없애려던 고정 예산이 그대로 남아 있었다. Windows CI(2코어)에서
 *  세 테스트가 그렇게 실패했다.
 *
 *  이제 기다리는 대상은 기록이 아니라 **떠 있는 fs 작업**이다(fsInFlight). 그것이 비어야 나가므로
 *  대기가 부하에 맞춰 늘어나고, 출력을 만들지 않는 읽기까지 덮는다.
 *
 *  **연속으로 비어 있기를 요구하는 이유**는 체인 중간의 일시적 0 이다. open → stat → read → close 는
 *  각 단계 사이에 떠 있는 작업이 없는 순간이 있고, 그 순간이 라운드 경계와 겹치면 다 끝난 것으로
 *  보인다. 다음 단계는 같은 턴 안에서 뜨므로 연속 IDLE_ROUNDS 라운드를 요구하면 그 착시가 걸러진다.
 *
 *  상한을 시간이 아니라 라운드 수로 세는 이유: fake timer가 걸린 동안 Date.now()는 얼어 있어
 *  경과 시간을 물어봐야 늘 0이다. 라운드는 실제 setTimeout으로 도니 실제 시간에 비례한다. */
const SETTLE_MIN_ROUNDS = 6 // 종전의 5ms×6 — 부정 단언의 하한을 유지한다
const SETTLE_MAX_ROUNDS = 400 // 5ms×400 = 2초. 부하가 아무리 심해도 여기서 멈춘다 — 넘으면 진짜 실패다
const SETTLE_IDLE_ROUNDS = 3 // 이만큼 연속으로 fs 가 비어 있어야 정말 끝난 것으로 본다
const settleIo = async (): Promise<void> => {
  let last = ioActivity()
  let quiet = 0
  let idle = 0
  for (let round = 1; round <= SETTLE_MAX_ROUNDS; round++) {
    await new Promise((r) => realSetTimeout(r, 5))
    const now = ioActivity()
    quiet = now === last ? quiet + 1 : 0
    last = now
    idle = fsInFlight.size === 0 ? idle + 1 : 0
    if (round >= SETTLE_MIN_ROUNDS && quiet >= 2 && idle >= SETTLE_IDLE_ROUNDS) return
  }
}
const advanceIo = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
  await settleIo()
  await vi.advanceTimersByTimeAsync(0) // I/O 완료로 새로 예약된 타이머 실행
  await settleIo()
}

describe('transcript 한도 감지', () => {
  const MIN = 60_000
  let dir: string
  let tPath: string

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'astera-rt-'))
    tPath = path.join(dir, 'claude-sess.jsonl')
  })
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  /** 실제 transcript 경로를 가리키는 statusline 페이로드 */
  const payloadAt = (p: string, pct = 20): unknown => ({
    session_id: 'claude-sess',
    transcript_path: p,
    rate_limits: { five_hour: { used_percentage: pct } }
  })

  // 소스에 통짜 트리거를 두지 않으려는 분할
  const limitLine = (tsMs: number): string =>
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: "You've hit your " + 'weekly limit' }]
      },
      error: 'rate_limit',
      apiErrorStatus: 429,
      timestamp: new Date(tsMs).toISOString()
    })

  it('transcript의 rate_limit 항목으로 롤한다 (다계정)', async () => {
    const h = harness()
    h.payloads.set('s1', payloadAt(tPath))
    h.coord.register(h.info1)
    await advanceIo(20_000) // 첫 틱 — 경로 학습 + tail 생성
    await fsp.writeFile(tPath, limitLine(Date.now() + 1000) + '\n', 'utf8')
    await advanceIo(20_000) // 다음 틱 — tail이 읽는다
    expect(h.events).toEqual(['copy', 'kill:s1', 'spawn:s2:a2'])
  })

  it('폴백 트리거 로그에 전사 식별자와 tail 상태를 담는다 — ①의 커버리지 사후 측정용', async () => {
    // tickChain이 이제 limitTailCheck(①)를 await한 뒤에야 폴백을 평가하므로(rolling.ts의
    // 수정, rolling.ts) ②가 발화했다는 것은 그 시점 ①이 잡지 못했다는 뜻이 실제로 보장된다. 그
    // "못 잡음"이 놓친 것인지(기록이 이미 있었는데 못 읽음) 아직 없던 것인지(기록이 몇 초 뒤에
    // 쓰임) 갈리려면 어느 전사를 보던 체인인지 알아야 한다 — 로그의 session=은 앱 내부 id라 사후
    // 대조가 불가능하다.
    //
    // 아래 tail=ok 단언이 의미를 가지려면 이 로그 실행 시점에 이미 실제
    // read()가 한 번 이상 완결돼 있어야 한다 — 그렇지 않으면 readFailed의 클래스 필드 기본값(false,
    // "아직 확인 안 함")과 "확인했고 성공함"이 구분되지 않는다(claudeSignal.ts의 readFailed 주석이
    // 스스로 인정하는 모호함). Finding 1의 순서 보장이 바로 그 전제를 만든다: 위에서 limitTailCheck를
    // await했고, 그 안에서 chain.limitTail이 non-null이면 실제 read()를 호출한다 — 이 틱의 read()가
    // 히트 없이 성공했기 때문에 아래에서 tail=ok가 나온다(readFailed=true였다면 read failed 문자열이
    // 나왔을 것이다). ClaudeTranscriptTail.prototype.read를 계측해 이 로그 실행 시점에 실제로 몇 번의
    // read()가 완결돼 있었는지 확인했다 — Finding 1 수정 전에는 0회(로그가 남는 시점에 어떤 실제
    // read()도 아직 안 끝나 있었다), 수정 후에는 1회 이상이다.
    const logs: string[] = []
    const h = harness({ log: (m) => logs.push(m) })
    await fsp.writeFile(tPath, '', 'utf8') // 빈 전사 — read()는 성공하고 hit은 없다 → tail=ok
    h.payloads.set('s1', payloadAt(tPath, 100)) // 5시간 창 100% → 폴백 조건 성립
    h.coord.register(h.info1)
    await advanceIo(20_000) // 틱1 — claudeSessionId·limitTail 학습 (무출력 15초, 아직 30초 미만)
    await advanceIo(40_000) // 무출력 30초 경과 → 폴백 트리거 발화
    const line = logs.find((m) => m.includes('fallback trigger'))
    expect(line).toBeDefined()
    expect(line).toContain('claudeSession=claude-sess') // 전사 파일명 — 사후에 429 시각과 맞춰본다
    expect(line).toContain('tail=ok') // none이면 경로 미학습, readFailed면 ①이 죽어 있던 것
  })

  it('경로 학습과 폴백 발화가 같은 틱에 겹치면 tail=none이다 — 읽지 않은 tail을 ok로 보고하지 않는다', async () => {
    // Finding 2의 잔여 갭(재리뷰가 실증): tickChain은 ①을 await한 뒤 applyMeta를 부르는데, applyMeta는
    // 전사 경로를 처음 학습할 때 limitTail을 새로 만든다. 그 객체는 read()가 한 번도 불린 적이 없으면서
    // readFailed가 초기값 false이므로, 그 상태를 로그하면 'ok'가 "아직 확인 안 함"을 뜻해버린다.
    // 재현 조건: statusline이 늦게 쓰이기 시작해 경로를 처음 배우는 틱이 곧 침묵 30초를 넘긴 틱이다.
    const logs: string[] = []
    const h = harness({ log: (m) => logs.push(m) })
    await fsp.writeFile(tPath, '', 'utf8')
    h.coord.register(h.info1) // payloads를 비워 둔 채 시작 — 경로를 배울 수 없다
    await advanceIo(40_000) // 침묵 30초 경과. 아직 payload가 없어 폴백도 평가되지 않는다
    h.payloads.set('s1', payloadAt(tPath, 100)) // 이제 처음 statusline이 쓰인다 — 학습과 폴백이 같은 틱
    await advanceIo(20_000)
    const line = logs.find((m) => m.includes('fallback trigger'))
    expect(line).toBeDefined()
    // 이 틱의 limitTailCheck는 tail이 아직 null이어서 첫 줄에서 돌아갔다 — 즉 ①은 아무것도 읽지 않았다.
    // applyMeta가 그 뒤에 tail을 만들지만 그것을 ok로 보고하면 커버리지 측정이 거짓이 된다.
    expect(line).toContain('tail=none')
    expect(line).toContain('claudeSession=claude-sess')
  })

  // 중요: 위 테스트는 ①이 "볼 것이 없는" 경우(빈 전사)만 본다. 그
  // 조건에서는 ①·②의 순서가 어긋나도 관측 결과가 같아(둘 다 최종적으로 같은 계정으로 롤) 레이스
  // 자체를 드러내지 못한다 — 이 레이스를 드러냈다면 Finding 1을 이 테스트가 먼저 잡았을 것이다.
  // 진짜 위험한 경우는 ①이 아직 못 읽은 진짜 히트가 있고 폴백 조건도 "동시에" 성립하는 순간이다.
  // 아래는 그 경합 순간을 재현해 ①이 이기는지(전사 감지 로그가 있고 폴백 로그는 없음, 그 근거로
  // 롤이 일어남) 확인한다. Finding 1 수정 전 코드에서 이 테스트를 돌리면 실패한다 — 전사 감지
  // 로그가 아예 남지 않고(①이 chain.rolling 가드에 막혀 조용히 끝남) 롤은 폴백이 구동한다.
  it('①에 아직 읽지 않은 진짜 히트가 있고 폴백 조건도 동시에 성립하면 ①이 이긴다', async () => {
    const logs: string[] = []
    const h = harness({ log: (m) => logs.push(m) })
    h.payloads.set('s1', payloadAt(tPath, 100)) // 5시간 창 100% → 폴백 조건도 성립
    h.coord.register(h.info1)
    await advanceIo(20_000) // 틱1 — claudeSessionId·limitTail 학습 (무출력 15초, 아직 30초 미만)
    await fsp.writeFile(tPath, limitLine(Date.now() + 1000) + '\n', 'utf8') // ①이 잡을 진짜 히트
    await advanceIo(40_000) // 무출력 30초 경과 → 폴백 조건도 성립하지만 ①이 먼저 완결돼야 한다
    expect(h.events).toEqual(['copy', 'kill:s1', 'spawn:s2:a2']) // ①이 롤을 구동했다
    expect(logs.some((m) => m.includes('limit detected via transcript'))).toBe(true) // ①이 발화
    expect(logs.some((m) => m.includes('fallback trigger'))).toBe(false) // ②는 rolling 가드에 막혀 조용
  })

  // 소스에 통짜 트리거를 두지 않으려는 분할 (limitLine과 동일 관례) — reset 시각까지 담은 항목
  const limitLineWithReset = (tsMs: number, tail: string): string =>
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: "You've hit your " + `session limit · resets ${tail} (Asia/Seoul)` }]
      },
      error: 'rate_limit',
      apiErrorStatus: 429,
      timestamp: new Date(tsMs).toISOString()
    })

  // CRITICAL: limitTailCheck는 이 기록 자신의 타임스탬프(hit.at)를 기준으로
  // 문구를 해석해야 한다 — this.now()(감지 틱의 순간)를 기준으로 쓰면, 실측처럼 기록이 자기 reset
  // 시각보다 몇 초 전에 쓰인 경우 "이미 지났다"고 오판해 하루를 더한 대기를 만든다. 아래는 그 정확한
  // 시나리오를 재현한다: 기록은 stated 11am보다 7초 전에 쓰이고, 코디네이터가 실제로 그 기록을
  // 처리하는 시점(두 번째 틱)은 이미 11am을 지나 있다.
  it('limitTailCheck는 hit.at(기록 시각)을 기준으로 문구를 해석한다 — 감지 틱이 아니다', async () => {
    const statedAt = Date.UTC(2026, 7, 3, 2, 0, 0) // 11:00:00 KST
    const hitAt = statedAt - 7_000 // 기록이 stated 시각보다 7초 전에 쓰였다 — 실측 7.2s·9s 사례
    // 첫 틱(T_reg+15s)에서 tail이 생성되고 since=그 시각으로 잡힌다. hitAt이 그 since보다 뒤에
    // 오도록(필터에 안 걸리도록) 100ms 여유를 두고, 두 번째 틱(T_reg+30s)이 stated 시각을 이미
    // 지나 있도록(버그가 발화할 조건) T_reg를 역산한다.
    const since = hitAt - 100
    const tReg = since - 15_000
    vi.setSystemTime(new Date(tReg))
    const h = harness()
    h.payloads.set('s1', payloadAt(tPath))
    h.coord.register({ ...h.info1, rollAccountIds: ['a1'] }) // 단일 계정 → 대기 시각을 직접 관측
    await advanceIo(20_000) // 첫 틱 — 경로 학습 + tail 생성(since=hitAt-100)
    await fsp.writeFile(tPath, limitLineWithReset(hitAt, '11am') + '\n', 'utf8')
    await advanceIo(20_000) // 두 번째 틱 — this.now()는 이미 11am을 지나 있다; tail이 hitAt을 읽는다

    expect(resumeCount(h)).toBe(0) // 아직 재개 없음
    // hit.at 기준(수정)이면 대기가 짧다(RETRY_MIN_FLOOR_MS=60s 하한 근처) — 70초 뒤엔 재개돼 있어야
    // 한다. this.now() 기준(버그)이면 day-roll이 트리거돼 Finding 1b의 5시간 상한에 걸려 null로
    // 거부되고 스냅샷 게이트(pct=20 < GATE_PCT)도 못 넘어 15분 폴백으로 떨어진다 — 70초로는
    // 절대 재개가 관측되지 않는다.
    await vi.advanceTimersByTimeAsync(70_000)
    expect(resumeCount(h)).toBe(1)
  })

  // Finding 5: rolling.log에 한도 원문 발췌를 그대로 쓰면 로그 자신이 새 트리거 소스가 된다 —
  // source=main의 발췌는 실제 사용자 대면 문구 그대로라, 나중에 이 로그를 cat/grep/tail하면
  // 터미널 스캐너와 (1)의 서브에이전트 규칙이 다시 발화할 수 있다. 로그가 문구를 담지 않고도
  // source·시각·길이는 여전히 남기는지 확인한다.
  it('transcript 한도 로그는 원문 발췌 문구를 담지 않는다 (Finding 5)', async () => {
    const logs: string[] = []
    const h = harness({ log: (m) => logs.push(m) })
    h.payloads.set('s1', payloadAt(tPath))
    h.coord.register(h.info1)
    await advanceIo(20_000) // 첫 틱 — 경로 학습 + tail 생성
    await fsp.writeFile(tPath, limitLine(Date.now() + 1000) + '\n', 'utf8')
    await advanceIo(20_000) // 다음 틱 — tail이 읽는다
    const detectLog = logs.find((l) => l.includes('limit detected via transcript'))
    expect(detectLog).toBeDefined()
    expect(detectLog).not.toContain("You've hit")
    expect(detectLog).not.toContain('weekly limit')
    expect(detectLog).toContain('source=main')
    expect(detectLog).toMatch(/textLen=\d+/) // 문구 대신 길이만 남는다
  })

  // 기본 harness()의 copy는 {src,dest}만 기록할 뿐 실제로 쓰지 않고, dest도 D:\cfg\a2\...라
  // 실제 fs에 손대면 안 된다. 롤 이후 "대상 계정 소유의 복사본"에서 재감지를 검증하려면 실제로
  // 파일이 그 자리에 있어야 하므로, 계정 configDir을 이 테스트의 tmp dir 밑으로 재정의하고 copy를
  // 실제 복사로 오버라이드한다. 두 테스트가 이 변형을 공유한다.
  const harnessWithRealCopy = (): ReturnType<typeof harness> & { accounts: Record<string, Account> } => {
    const acc2 = (id: string): Account => ({
      id,
      label: id,
      configDir: path.join(dir, id),
      color: '#fff',
      createdAt: '2026-07-22T00:00:00Z'
    })
    const accounts: Record<string, Account> = { a1: acc2('a1'), a2: acc2('a2'), a3: acc2('a3') }
    const h = harness({
      getAccount: (id) => accounts[id] ?? null,
      copy: async (src, dest) => {
        await fsp.mkdir(path.dirname(dest), { recursive: true })
        await fsp.copyFile(src, dest)
      }
    })
    return { ...h, accounts }
  }

  // roll()이 tail을 재생성하지 않으면 이 테스트가 실패한다: applyMeta만 믿으면 새 계정의
  // statusLine이 (copy 직후 이미 dest로 맞춰진) 같은 경로를 보고할 때 "경로 안 바뀜"으로 보고
  // 옛 tail(옛 계정 파일)을 유지한다 — 그 파일엔 아무도 안 쓰므로 두 번째 한도가 영원히 감지되지
  // 않는다. 위 첫 테스트는 첫 번째 롤만 보므로 이 회귀를 못 잡는다(직접 확인: roll()의 재생성 줄을
  // 지워도 위 테스트는 그대로 통과했다) — 그래서 두 번째 롤까지 보는 이 테스트를 추가한다.
  it('롤 이후 대상 계정에 복사된 transcript에서 또 한도를 감지해 다시 롤한다 — roll()의 tail 재생성 검증', async () => {
    const h = harnessWithRealCopy()
    h.payloads.set('s1', payloadAt(tPath))
    h.coord.register(h.info1)
    await advanceIo(20_000) // 첫 틱 — 경로 학습 + tail 생성
    await fsp.writeFile(tPath, limitLine(Date.now() + 1000) + '\n', 'utf8')
    await advanceIo(20_000) // tail이 읽어 a1→a2 롤 (복사가 실제로 dest에 파일을 만든다)
    expect(h.spawned.at(-1)?.accountId).toBe('a2')
    const dest = claudeHistoryStrategy.mapTargetPath(tPath, h.accounts.a2.configDir)
    // a2용 statusline도 실제 재개 시나리오처럼 그 dest를 그대로 보고한다
    h.payloads.set('s2', payloadAt(dest))
    await advanceIo(1_000) // 준비 폴링 → applyMeta("경로 안 바뀜") → 프롬프트 전송
    // 대상 계정 소유의 복사본에 새 한도가 다시 나타난다
    await fsp.appendFile(dest, limitLine(Date.now() + 1000) + '\n', 'utf8')
    await advanceIo(20_000) // 다음 틱 — a2용 tail이 새 항목을 읽어 a2→a3로 다시 롤해야 한다
    expect(h.spawned.at(-1)?.accountId).toBe('a3')
  })

  // 위 테스트는 "재생성됨"만 보여준다 — read()가 한 배치 안의 여러 hit 중 가장 늦은 것만 돌려주므로,
  // 복사된 옛 hit과 새로 append한 hit이 같은 read()에서 함께 걸리면 since가 틀려도(0으로 굳었거나
  // 복사 이전 시각이어도) 새 hit이 max 비교에서 항상 이겨 테스트가 우연히 통과한다. since가 실제로
  // "복사된 옛 에러를 배제"하는지는 그 옛 hit만 있는 상태에서 몇 틱을 더 돌려도 재롤이 없어야
  // 확인된다 — 격리해서 검증한다 (리뷰 지적).
  it('롤 이후 아무것도 새로 쓰지 않으면 복사된 옛 한도로 다시 롤하지 않는다 — since 배제 격리 검증', async () => {
    const h = harnessWithRealCopy()
    h.payloads.set('s1', payloadAt(tPath))
    h.coord.register(h.info1)
    await advanceIo(20_000) // 첫 틱 — 경로 학습 + tail 생성
    await fsp.writeFile(tPath, limitLine(Date.now() + 1000) + '\n', 'utf8')
    await advanceIo(20_000) // tail이 읽어 a1→a2 롤 (복사가 실제로 dest에 옛 hit을 그대로 옮긴다)
    expect(h.spawned).toHaveLength(1)
    expect(h.spawned.at(-1)?.accountId).toBe('a2')
    const dest = claudeHistoryStrategy.mapTargetPath(tPath, h.accounts.a2.configDir)
    h.payloads.set('s2', payloadAt(dest))
    await advanceIo(1_000) // 준비 폴링 → 프롬프트 전송 (awaitingReady 해제)
    // 아무것도 새로 쓰지 않고 여러 틱을 보낸다 — since가 옳다면 dest의 옛 hit은 계속 무시된다
    await advanceIo(60_000)
    expect(h.spawned).toHaveLength(1) // 재롤 없음 — a2에 그대로 머문다
  })

  it('tail 생성 이전 시각의 항목은 무시한다 — 복사본 재감지 방지', async () => {
    const h = harness()
    const old = Date.now() - 60 * MIN
    await fsp.writeFile(tPath, limitLine(old) + '\n', 'utf8')
    h.payloads.set('s1', payloadAt(tPath))
    h.coord.register(h.info1)
    await advanceIo(60_000) // 여러 틱을 돌려도
    expect(h.events).toEqual([]) // 옛 항목이므로 발화하지 않는다
  })

  it('같은 항목을 두 번 발화하지 않는다', async () => {
    const h = harness()
    h.payloads.set('s1', payloadAt(tPath))
    h.coord.register(h.info1)
    await advanceIo(20_000)
    await fsp.writeFile(tPath, limitLine(Date.now() + 1000) + '\n', 'utf8')
    await advanceIo(20_000)
    const after = h.events.length
    expect(after).toBeGreaterThan(0) // 위 두 테스트와 달리 여기서는 실제로 발화했는지까지 확인한다
    await advanceIo(60_000)
    expect(h.events.length).toBe(after)
  })

  it('transcript 경로를 모르면 조용히 넘어간다 (statusline 미기록)', async () => {
    const h = harness() // payloads 비움 → 경로 학습 없음
    h.coord.register(h.info1)
    await advanceIo(60_000)
    expect(h.events).toEqual([])
  })

  // Finding 4: 경로는 학습됐지만(statusline이 값을 보고) 그 파일에 접근할 수 없으면(권한 등) 종전
  // 코드는 히트가 없을 때와 똑같이 조용했다 — rolling.log에 아무 근거도 남지 않아 감지가 죽었는지
  // 그냥 한도가 없는 건지 구분할 수 없었다. readFailed로 구분해 체인당 1회 로그하는지 확인한다.
  it('transcript 경로가 있어도 읽기에 실패하면 체인당 1회만 로그한다 — 히트 없음과 구분 (Finding 4)', async () => {
    const logs: string[] = []
    const h = harness({ log: (m) => logs.push(m) })
    h.payloads.set('s1', payloadAt(path.join(dir, 'nope.jsonl'))) // 학습은 되지만 파일이 없다
    h.coord.register(h.info1)
    await advanceIo(20_000) // 첫 틱 — tail 생성 + 첫 읽기 실패 → 로그 1회
    await advanceIo(20_000) // 두 번째 틱 — 계속 실패하지만 로그는 늘지 않는다
    const failLogs = logs.filter((l) => l.includes('read failed'))
    expect(failLogs).toHaveLength(1)
    expect(h.events).toEqual([]) // 읽기 실패는 롤을 유발하지 않는다
  })

  it('경로가 바뀌면 읽기 실패 경고를 다시 낼 수 있다', async () => {
    // codexRolling의 unmappedWarned는 remap마다 false로 되돌린다 — 같은 관례를 따른다.
    // 되돌리지 않으면 체인 생애 중 어느 경로가 한 번 실패한 뒤 다른 경로의 실패가 영구히 침묵한다.
    const logs: string[] = []
    const h = harness({ log: (m) => logs.push(m) })
    h.payloads.set('s1', payload(50, 'claude-sess', 'D--work-p'))
    h.coord.register(h.info1)
    await advanceIo(20_000) // 첫 틱 → applyMeta → limitTail 생성 (없는 파일)
    await advanceIo(20_000) // 두 번째 틱 → 읽기 실패 1회 로그
    const first = logs.filter((m) => m.includes('transcript tail read failed')).length
    expect(first).toBe(1)

    // 다른 슬러그로 경로를 바꾼다 → applyMeta가 limitTail을 재생성한다
    h.payloads.set('s1', payload(50, 'claude-sess', 'D--work-other'))
    await advanceIo(20_000) // 재생성
    await advanceIo(20_000) // 새 경로의 실패
    const second = logs.filter((m) => m.includes('transcript tail read failed')).length
    expect(second).toBe(2)
  })
})

// 화면 문구는 Claude가 낸 배너인지 화면에 뜬 문서 내용인지 구분하지 못한다 — 실측 오탐 4건이 전부
// 이 경로였고 그중 2건이 백그라운드 워크플로를 죽였다. 문구는 트리거로만 쓰고 롤·대기를 시작할지는
// 계정 사용량을 직접 조회해 정한다(statusLine 스냅샷과 달리 얼지 않는다).
describe('한도 증거 게이트 — 계정 사용량 직접 조회', () => {
  it('문구를 물어도 사용량이 100% 미만이면 롤도 대기도 시작하지 않는다', async () => {
    const h = harness({ readUsage: () => Promise.resolve(40) })
    h.payloads.set('s1', payload(97))
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    expect(h.events).toEqual([])
    expect(h.sent).toEqual([]) // waiting 배너도 없다 → 스케줄러 억제도 없다
  })

  it('사용량이 100% 이상이면 인정하고 롤한다 — 스냅샷이 낮아도 직접 조회가 판정한다', async () => {
    const h = harness({ readUsage: () => Promise.resolve(100) })
    h.payloads.set('s1', payload(3))
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    expect(h.events).toEqual(['copy', 'kill:s1', 'spawn:s2:a2'])
  })

  // **대화상자는 CLI 자신의 판정이다.** 게이트가 막으려는 것(문서·도구 출력에 우연히 든 문구)은
  // 대화상자를 그리지 않으므로, 대화상자의 존재는 계정 조회 수치보다 강한 증거다.
  //
  // 실측이 이 예외를 요구했다(2026-08-26): 관리자 통제 플랜의 한도가 5시간·주간 창에 나타나지 않아
  // `maxPercent` 가 73% 로 읽혔고, 문구가 두 번 기각되어 세션이 대화상자 앞에서 밤새 멈춰 있었다.
  it('사용량이 100% 미만이어도 한도 선택 대화상자가 떠 있으면 인정한다', async () => {
    const logs: string[] = []
    const h = harness({ readUsage: () => Promise.resolve(40), log: (m) => logs.push(m) })
    h.payloads.set('s1', payload(3))
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: `${LIMIT_TEXT}\n${WAIT_DIALOG}` })
    await flush()
    expect(h.events).toEqual(['copy', 'kill:s1', 'spawn:s2:a2'])
    // 어느 증거로 통과했는지 로그가 말해야 한다 — 수치로 적으면 게이트가 고장 난 것으로 읽힌다
    expect(logs.some((l) => l.includes('wait-choice dialog on screen (usage 40%)'))).toBe(true)
  })

  // 예외를 좁게 유지한다: 라벨만으로는 부족하고 실제로 입력을 기다리는 목록이어야 한다.
  it('라벨만 인용됐고 입력 대기 목록이 아니면 기각을 유지한다', async () => {
    const h = harness({ readUsage: () => Promise.resolve(40) })
    h.payloads.set('s1', payload(97))
    h.coord.register(h.info1)
    h.coord.handleData({
      sessionId: 's1',
      data: `${LIMIT_TEXT}\n문서 인용: Wait for ` + 'limit to reset'
    })
    await flush()
    expect(h.events).toEqual([])
  })

  it('조회가 불가하면 종전 동작으로 폴백해 인정한다 — 감지를 죽이지 않는다', async () => {
    const logs: string[] = []
    const h = harness({ readUsage: () => Promise.resolve(null), log: (m) => logs.push(m) })
    h.payloads.set('s1', payload(97))
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    expect(h.events).toEqual(['copy', 'kill:s1', 'spawn:s2:a2'])
    expect(logs.some((l) => l.includes('usage unavailable'))).toBe(true)
  })

  it('기각은 체인을 잠그지 않는다 — 사용량이 오르면 다음 문구는 인정된다', async () => {
    const usage = [40, 100]
    const h = harness({ readUsage: () => Promise.resolve(usage.shift() ?? 0) })
    h.payloads.set('s1', payload(97))
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    expect(h.events).toEqual([])
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    expect(h.events).toEqual(['copy', 'kill:s1', 'spawn:s2:a2'])
  })

  it('기각 로그는 창 안에서 반복되지 않는다 — 문구는 청크마다 다시 물린다', async () => {
    const logs: string[] = []
    const h = harness({ readUsage: () => Promise.resolve(40), log: (m) => logs.push(m) })
    h.payloads.set('s1', payload(97))
    h.coord.register(h.info1)
    for (let i = 0; i < 3; i++) {
      h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
      await flush()
    }
    expect(logs.filter((l) => l.includes('limit phrase rejected'))).toHaveLength(1)
  })

  // 조회는 네트워크 왕복(최대 10초)이라 그 사이 다른 경로가 롤을 끝낼 수 있다. liveId를 보지
  // 않으면 옛 세션의 문구로 새 세션에 차단 기록을 찍고 곧바로 또 롤한다.
  it('조회가 도는 사이 롤이 끝났으면 그 판정을 새 세션에 적용하지 않는다', async () => {
    let resolveUsage: (v: number) => void = () => {}
    const h = harness({ readUsage: () => new Promise<number>((r) => (resolveUsage = r)) })
    h.payloads.set('s1', payload(97))
    h.payloads.set('s2', payload(5, 'claude-sess'))
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT }) // 조회 시작 — 아직 안 끝난다
    await flush()
    expect(h.events).toEqual([]) // 조회가 미결이라 아직 아무 일도 없다
    await h.coord.forceRoll('s1') // 다른 경로가 먼저 롤을 끝낸다
    await vi.advanceTimersByTimeAsync(1_200) // 준비 폴링 → 자동 프롬프트 → awaitingReady 해제
    const after = h.events.length
    resolveUsage(100) // 뒤늦게 도착한 옛 세션의 판정
    await flush()
    expect(h.events.length).toBe(after) // 두 번째 롤이 일어나지 않는다
  })

  it('사용량 폴백 트리거(창 100% + 30초 무출력)는 게이트를 거치지 않는다', async () => {
    let calls = 0
    const h = harness({
      readUsage: () => {
        calls++
        return Promise.resolve(0) // 게이트를 탔다면 기각됐을 값
      }
    })
    h.payloads.set('s1', payloadEx({ five: 3, weekly: 100 }))
    h.coord.register(h.info1)
    // tickChain이 limitTailCheck를 await하는데 더미 transcript 경로의 open() 실패에도 실제 fs I/O
    // 완료 콜백이 필요하다 — 순수 fake-timer 진행으로는 돌지 않는다(advanceIo 주석 참조).
    await advanceIo(46_000)
    expect(h.spawned.at(-1)?.accountId).toBe('a2')
    expect(calls).toBe(0)
  })
})

// 같은 계정으로 재개하는데 프로세스를 죽일 이유가 없다 — 백그라운드 Dynamic Workflow는 claude CLI의
// 자식이라 그 kill로만 죽는다. "지금 일하고 있는가"는 판단하지 않는다: 증거 게이트가 오탐을 걸러낸
// 뒤로 대기는 진짜 한도일 때만 걸리고, Claude Code는 한도가 풀려도 스스로 시작하지 않으므로 그 시점
// 세션은 반드시 멈춰 있다. 판별할 것은 "선택지가 걸려 있는가" 하나뿐이다.
describe('같은 계정 재개는 kill 하지 않는다', () => {
  // 라벨은 있는데 번호가 없는 화면 — 앱이 선택지를 못 걷어낸 상태 (실측 0/53이지만 가능한 형태)
  const LABEL_ONLY = [
    "You've hit your " + 'session limit',
    '❯ Wait for ' + 'limit to reset'
  ].join('\n')

  it('대기가 끝나면 kill·spawn 없이 살아 있는 PTY에 프롬프트만 보낸다', async () => {
    const h = harness()
    h.payloads.set(
      's1',
      payloadEx({ five: 95, weekly: 20, fiveReset: new Date(Date.now() + 10 * MIN).toISOString() })
    )
    h.coord.register(infoSelf())
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    expect(h.written).toEqual([]) // 리셋 전에는 보내지 않는다
    await vi.advanceTimersByTimeAsync(11 * MIN + 30_000)
    expect(h.events).toEqual([]) // copy·kill·spawn 어느 것도 없다
    expect(h.written.map((w) => w.data)).toEqual([RESUME_PROMPT, '\r'])
  })

  it('선택지를 못 걷어낸 채 대기했으면 기존 방식(껐다 켜기)으로 폴백한다', async () => {
    const h = harness()
    h.payloads.set(
      's1',
      payloadEx({ five: 95, weekly: 20, fiveReset: new Date(Date.now() + 10 * MIN).toISOString() })
    )
    h.coord.register(infoSelf())
    h.coord.handleData({ sessionId: 's1', data: LABEL_ONLY })
    await flush()
    await vi.advanceTimersByTimeAsync(11 * MIN + 30_000)
    // 화면에 목록이 남아 있으면 눈먼 Enter가 하이라이트된 항목을 승인할 수 있다 — kill이 화면을 지운다
    expect(h.events).toEqual(['copy', 'kill:s1', 'spawn:s2:a1'])
  })

  it('다른 계정으로 넘어가는 대기 만료는 기존대로 복사→kill→spawn 한다 (회귀 가드)', async () => {
    const h = harness()
    const now = Date.now()
    h.payloads.set(
      's1',
      payloadEx({ five: 95, weekly: 20, fiveReset: new Date(now + 20 * MIN).toISOString() })
    )
    h.coord.register({ ...h.info1, rollAccountIds: ['a1', 'a2'] })
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush() // → a2
    h.payloads.set(
      's2',
      payloadEx({ five: 95, weekly: 20, fiveReset: new Date(now + 40 * MIN).toISOString() })
    )
    await settle() // 준비 폴링 → 자동 프롬프트 → awaitingReady 해제
    h.coord.handleData({ sessionId: 's2', data: LIMIT_TEXT })
    await flush() // 전부 차단 → 더 빨리 풀리는 a1이 타겟
    const before = h.events.length
    await vi.advanceTimersByTimeAsync(22 * MIN)
    expect(h.events.slice(before)).toEqual(['copy', 'kill:s2', 'spawn:s3:a1'])
  })

  it('제자리 재개 60초 뒤 차단 기록이 해제된다 — 롤 경로와 같은 정리', async () => {
    // idleNudgeCheck가 실제 fs를 stat하는데 fake timer 아래서는 그 완료 콜백이 돌지 않는다
    const h = harness({ probeActivity: () => Promise.resolve(null) })
    h.payloads.set(
      's1',
      payloadEx({ five: 95, weekly: 20, fiveReset: new Date(Date.now() + 10 * MIN).toISOString() })
    )
    h.coord.register(infoSelf())
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    await vi.advanceTimersByTimeAsync(11 * MIN + 30_000)
    const sentBefore = h.sent.length
    // 스냅샷 사용률을 낮춰 증거원을 차단 기록 하나로 좁힌다 — 그러지 않으면 lastUsagePct(95%)만으로
    // limitEvidence()가 참이 되어 기록 해제 여부와 무관하게 nudge가 뜬다.
    h.payloads.set('s1', payloadEx({ five: 20, weekly: 20 }))
    // 기록이 남아 있으면 limitEvidence()가 계속 true라 idle nudge가 무장 상태로 고정된다.
    // 해제되면 "한도 흔적 없음"으로 판정돼 개입하지 않는다.
    await vi.advanceTimersByTimeAsync(70_000)
    h.coord.onHookEvent('s1', { hook_event_name: 'Notification', notification_type: 'idle_prompt' })
    await vi.advanceTimersByTimeAsync(11 * MIN)
    expect(h.sent.slice(sentBefore).some((s) => s.payload.state === 'nudged')).toBe(false)
  })

  // 네 지우는 자리 중 **제자리 재개 쪽**을 못박는다. 위 테스트는 자기 체인의 기록만 보므로 그 한 줄을
  // 지워도 통과한다 — 공유 기록까지 함께 풀리는지는 다른 체인이 적은 기록으로만 볼 수 있다.
  it('제자리 재개 60초 뒤 다른 체인이 적은 공유 기록도 함께 풀린다 (오탐 안전 밸브)', async () => {
    // resetAnchorCheck(단일 계정 3-b)가 실제 fs를 stat한다 — fake timer 아래서 그 완료 콜백은 안 돈다
    const h = harness({ probeActivity: () => Promise.resolve(null) })
    const t0 = Date.now()
    // 체인 1: 단일 계정 a1, reset은 2분 뒤 → 판정 시점의 계획은 3분 뒤 제자리 재개다
    h.payloads.set('s1', payloadEx({ five: 95, weekly: 20, fiveReset: new Date(t0 + 2 * MIN).toISOString() }))
    h.coord.register(infoSelf())
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    expect(lastWaiting(h.sent)).toBeDefined()
    // 체인 2: 같은 a1 에서 주간 소진(60분)을 적는다 — 체인 1 의 대기(3분)보다 오래 남는 기록이다.
    // 체인 1 의 판정 **뒤에** 적히므로 그 대기 시각은 늘어나지 않는다.
    h.payloads.set('s10', payloadEx({
      sid: 'claude-sess-2', five: 20, weekly: 97, weeklyReset: new Date(t0 + 60 * MIN).toISOString()
    }))
    h.coord.register({ ...h.info1, id: 's10', cwd: 'D:\\work\\q', rollAccountIds: ['a1', 'a2'] })
    h.coord.handleData({ sessionId: 's10', data: LIMIT_TEXT })
    await flush()
    // 중간 체크포인트: 지금은 기록이 살아 있어야 한다. 체인 3 은 a1 을 한 번도 만진 적이 없는데도
    // 갈 곳이 없어 대기한다 — 이 단언이 없으면 마지막 단언이 "애초에 공유가 없었다"로도 통과한다.
    h.payloads.set('s20', payloadEx({ sid: 'claude-sess-3', five: 95, weekly: 20 }))
    h.coord.register({ ...h.info1, id: 's20', accountId: 'a2', cwd: 'D:\\work\\r', rollAccountIds: ['a2', 'a1'] })
    const spawnedBefore = h.spawned.length
    h.coord.handleData({ sessionId: 's20', data: LIMIT_TEXT })
    await flush()
    expect(h.spawned.length).toBe(spawnedBefore) // a1 으로 옮기지 않았다
    // 체인 1 의 대기 만료 → 제자리 재개 → 그 뒤 60초 무사 → 공유 기록이 지워진다
    await vi.advanceTimersByTimeAsync(3 * MIN + 70_000)
    // resumeCount 는 모든 체인의 문장을 센다(롤의 자동 프롬프트도 같은 문장이다) — 체인 1 은
    // kill 되지 않으니 여전히 s1 이다. 그 세션에 들어간 문장만 세서 제자리 재개를 확인한다.
    expect(h.written.filter((w) => w.id === 's1' && w.data === RESUME_PROMPT)).toHaveLength(1)
    // 체인 4: a1 이 다시 후보다. 기록이 남아 있었다면 갈 곳이 없어 대기한다
    h.payloads.set('s30', payloadEx({ sid: 'claude-sess-4', five: 95, weekly: 20 }))
    h.coord.register({ ...h.info1, id: 's30', accountId: 'a2', cwd: 'D:\\work\\s', rollAccountIds: ['a2', 'a1'] })
    h.coord.handleData({ sessionId: 's30', data: LIMIT_TEXT })
    await flush()
    expect(h.spawned.at(-1)?.accountId).toBe('a1')
  })
})

// fix round 2 — 이 describe 가 없던 동안 배선 계층에 테스트가 아예 없었다. 기존 테스트는 전부
// `?? chain.prompt` 폴백(주입 없음)만 지나가므로, 훅이 실제로 무엇을 물어보고 그 값이 정말 세션에
// 써지는지는 검증되지 않았다 — 즉 성공 경로가 미검증이었다.
describe('resumeText 훅 배선 — 어느 모양을 묻고 그 값이 어디로 가는가', () => {
  const MIN = 60_000
  /** 물어본 form 을 모두 기록하고 지정한 텍스트를 돌려주는 훅 */
  const hook = (
    text: string | null
  ): { fn: RollingDeps['resumeText']; forms: string[] } => {
    const forms: string[] = []
    return {
      fn: (_sessionId, form) => {
        forms.push(form)
        return Promise.resolve(text)
      },
      forms
    }
  }

  it('롤 뒤의 auto-prompt 는 handover 를 묻고 그 값을 그대로 세션에 쓴다', async () => {
    const h0 = hook('RE-READ YOUR SPEC FILE')
    const h = harness({ resumeText: h0.fn })
    h.payloads.set('s1', payload(97))
    h.payloads.set('s2', payload(20))
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await settle()
    expect(h0.forms).toEqual(['handover'])
    // handover 는 **대체**다 — 전체 인계가 chain.prompt 자리를 차지한다
    expect(h.written.some((w) => w.id === 's2' && w.data === 'RE-READ YOUR SPEC FILE')).toBe(true)
    expect(h.written.some((w) => w.data === '이어서 작업 진행해 줘')).toBe(false)
  })

  it('같은 계정 in-place 재개는 update 를 묻고 기존 문장에 덧붙인다', async () => {
    const h0 = hook('While you waited the worktree did not move.')
    const h = harness({ resumeText: h0.fn })
    h.payloads.set(
      's1',
      payloadEx({ five: 100, weekly: 20, fiveReset: new Date(Date.now() + 10 * MIN).toISOString() })
    )
    h.coord.register(infoSelf())
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    await vi.advanceTimersByTimeAsync(10 * MIN + 2 * MIN)
    expect(h0.forms).toEqual(['update'])
    expect(h.spawned).toEqual([]) // 죽이지도 다시 띄우지도 않는다
    // update 는 **덧붙임**이다 — 사용자가 지정할 수 있는 chain.prompt 를 버리지 않는다
    expect(h.written[0]?.data).toBe(
      '이어서 작업 진행해 줘 While you waited the worktree did not move.'
    )
  })

  it('idle nudge 도 update 를 묻는다 — 세션이 살아 있다', async () => {
    const h0 = hook('While you waited the worktree did not move.')
    const h = harness({
      resumeText: h0.fn,
      probeActivity: () => Promise.resolve(Date.now() - 20 * MIN),
      readPending: () => Promise.resolve(null)
    })
    h.payloads.set('s1', payload(95))
    h.coord.register(h.info1)
    h.coord.onHookEvent('s1', { hook_event_name: 'Notification', notification_type: 'idle_prompt' })
    await advanceIo(11 * MIN)
    await vi.advanceTimersByTimeAsync(200)
    expect(h0.forms).toEqual(['update'])
    expect(h.written[0]?.data).toBe(
      '이어서 작업 진행해 줘 While you waited the worktree did not move.'
    )
  })

  it('리셋 앵커 재개도 update 를 묻는다 — 세션이 살아 있다', async () => {
    const start = Date.now()
    const resetSec = Math.floor(start / 1000) + 600
    const h0 = hook('While you waited the worktree did not move.')
    const h = harness({
      resumeText: h0.fn,
      probeActivity: () => Promise.resolve(start - 60_000),
      readPending: () => Promise.resolve(1)
    })
    h.payloads.set('s1', payloadReset(95, resetSec))
    h.coord.register({ ...h.info1, rollAccountIds: ['a1'] })
    await vi.advanceTimersByTimeAsync(15 * MIN + 200)
    expect(h0.forms).toEqual(['update'])
    expect(h.written[0]?.data).toBe(
      '이어서 작업 진행해 줘 While you waited the worktree did not move.'
    )
  })

  it('훅이 null 을 돌리면 덧붙이지 않고 기존 문장만 쓴다', async () => {
    const h0 = hook(null)
    const h = harness({ resumeText: h0.fn })
    h.payloads.set(
      's1',
      payloadEx({ five: 100, weekly: 20, fiveReset: new Date(Date.now() + 10 * MIN).toISOString() })
    )
    h.coord.register(infoSelf())
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    await vi.advanceTimersByTimeAsync(10 * MIN + 2 * MIN)
    expect(h.written[0]?.data).toBe('이어서 작업 진행해 줘')
  })

  it('훅이 던져도 재개는 기존 문장으로 계속된다', async () => {
    const h = harness({ resumeText: () => Promise.reject(new Error('packet contract broke')) })
    h.payloads.set(
      's1',
      payloadEx({ five: 100, weekly: 20, fiveReset: new Date(Date.now() + 10 * MIN).toISOString() })
    )
    h.coord.register(infoSelf())
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    await vi.advanceTimersByTimeAsync(10 * MIN + 2 * MIN)
    expect(h.written[0]?.data).toBe('이어서 작업 진행해 줘')
  })
})

// 롤이 중간에 포기하면 예전에는 'none' 을 게시하고 반환했다 — 아무것도 예약하지 않는다. 세션은
// 한도에 그대로 막혀 있고 그 한도는 신호로 이미 소비됐으므로 다시 감지될 일이 없어, 사람이
// 알아챌 때까지 워커가 유휴로 남는다. 두 경로가 실측됐다: 체인의 계정이 돌아가는 중에 삭제된 것
// (가용성 판정은 id 만 보므로 해결되지 않는 계정을 roll() 에 넘긴다), 그리고 히스토리에서 다시 연
// 대화가 세션 메타를 배우지 못한 것(한도에 걸린 claude 는 statusLine 훅을 아예 부르지 않는다 —
// 88초 동안 0회 실측). 그래서 여기 단언의 핵심은 셋이다: 'waiting' 이 게시된다, nextRetryAt 이
// 실려 있다, **그 시각에 실제로 다시 시도한다**. 세 번째가 요점이다 — 상태만 게시하고 타이머를
// 안 걸면 고치기 전과 똑같다.
describe('중단된 롤이 다음 시도를 예약한다', () => {
  // 계정을 가릴 수 있게 문구가 reset 시각을 싣는다. 그래야 recovery[a1] 이 15분 폴백보다 뒤로
  // 밀려 planRetry 가 a2 를 겨냥하고, 재시도가 실제로 roll() 을 다시 부른다 — statusLine 이 얼어
  // 있어도 문구는 시각을 담는다는 것이 실측이고(resetTime.ts), 이 파일의 선례도 그것이다.
  // 문구의 11am 이 5시간 창 안에 들어오도록 시계를 고정한다.
  const T0 = Date.UTC(2026, 7, 3, 0, 0) // 11am(Asia/Seoul) = 02:00Z → +2시간
  const LIMIT_WITH_RESET = limitWithReset('session', '11am')

  /** 게시된 대기의 재시도 시각까지 이동한다. 반환값은 그 시각. */
  const jumpToRetry = async (h: {
    sent: { channel: string; payload: Record<string, unknown> }[]
  }): Promise<number> => {
    const at = Date.parse(String(lastWaiting(h.sent)?.nextRetryAt))
    await vi.advanceTimersByTimeAsync(at - Date.now() + 1_000)
    return at
  }
  const retryAtOf = (h: { sent: { channel: string; payload: Record<string, unknown> }[] }): number =>
    Date.parse(String(lastWaiting(h.sent)?.nextRetryAt))

  it('계정이 사라져 롤을 포기하면 다시 시도할 시각을 잡는다 (영구 유휴 방지)', async () => {
    vi.setSystemTime(new Date(T0))
    const h = harness({ getAccount: (id) => (id === 'a1' ? acc('a1', '계정A') : null) })
    h.payloads.set('s1', payload(97)) // 세션 메타는 배웠다 — 중단 사유는 사라진 계정이다
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_WITH_RESET })
    await flush()
    expect(h.events).toEqual([]) // 롤 중단 — copy/kill/spawn 없음
    expect(h.sent.at(-1)?.payload.state).toBe('waiting') // 'none' 이 아니다
    expect(retryAtOf(h)).toBeGreaterThan(Date.now())
    // (c) 그 시각에 실제로 다시 시도한다. 계정은 여전히 없으므로 또 포기하고 또 예약한다 —
    // 새 'waiting' 이 더 뒤의 시각으로 게시되는 것이 재시도가 돌았다는 증거다.
    const first = await jumpToRetry(h)
    expect(retryAtOf(h)).toBeGreaterThan(first)
  })

  it('statusLine 을 못 배워 롤을 포기해도 다시 시도할 시각을 잡는다', async () => {
    vi.setSystemTime(new Date(T0))
    const h = harness() // payload 없음 → claudeSessionId·transcriptPath 를 배우지 못한다
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_WITH_RESET })
    await flush()
    expect(h.events).toEqual([])
    expect(h.sent.at(-1)?.payload.state).toBe('waiting')
    expect(retryAtOf(h)).toBeGreaterThan(Date.now())
    // (c) 그 사이에 statusLine 이 도착하면 그 시각의 재시도는 성공한다
    h.payloads.set('s1', payload(97))
    await jumpToRetry(h)
    expect(h.events).toEqual(['copy', 'kill:s1', 'spawn:s2:a2'])
  })

  it('롤이 예외로 실패해도 다시 시도할 시각을 잡는다', async () => {
    vi.setSystemTime(new Date(T0))
    const h = harness({ copy: () => Promise.reject(new Error('transcript copy blew up')) })
    h.payloads.set('s1', payload(97))
    h.coord.register(h.info1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_WITH_RESET })
    await flush()
    expect(h.events).toEqual([]) // 복사가 던졌으므로 kill·spawn 은 없다
    expect(h.sent.at(-1)?.payload.state).toBe('waiting')
    const first = await jumpToRetry(h)
    expect(retryAtOf(h)).toBeGreaterThan(first)
  })
})

// 제자리 재개가 실제로 턴을 시작했는지 판정하는 자리. 여기서 판정을 하지 않으면 — 실측(2026-08-27):
// 세션 메타를 못 배운 단일 계정이 대기 뒤 제자리 재개를 하고, 60초 뒤 healthyTimer 가 무조건
// "건강하다"를 선언한 다음, **45분 동안 아무 일도 일어나지 않았다**. limitTail 이 없어 ①이 죽고,
// 페이로드가 없어 fallback 트리거가 죽고, Notification 이 없어 idle nudge 도 뜨지 않는다.
// 메타를 배운 경우는 얼어붙은 페이로드가 fallback 을 다시 살려 스스로 복구되므로(실측) 여기서
// 묻는 것은 "그동안 메타가 도착했는가" 하나다.
describe('제자리 재개의 정착 판정', () => {
  const T0 = Date.UTC(2026, 7, 3, 0, 0) // 문구의 11am(Asia/Seoul)이 5시간 창 안에 들어오도록 고정
  const LIMIT_WITH_RESET = limitWithReset('session', '11am')
  const retryAtOf = (h: { sent: { channel: string; payload: Record<string, unknown> }[] }): number =>
    Date.parse(String(lastWaiting(h.sent)?.nextRetryAt))

  it('메타를 여전히 못 배웠으면 respawn 으로 넘겨 영구 침묵을 끝낸다', async () => {
    vi.setSystemTime(new Date(T0))
    const h = harness() // 페이로드 없음 → claudeSessionId·transcriptPath 를 못 배운다
    h.coord.register({ ...h.info1, rollAccountIds: ['a1'] }) // 단일 계정 — 대기 뒤 제자리 재개 경로
    h.coord.handleData({ sessionId: 's1', data: LIMIT_WITH_RESET })
    await flush()
    const firstRetry = retryAtOf(h)
    await vi.advanceTimersByTimeAsync(firstRetry - Date.now() + 1_000)
    expect(resumeCount(h)).toBe(1) // 제자리 재개가 일어났다
    const sentBefore = h.sent.length
    // 정착 판정까지 이동한다. 메타는 여전히 없으므로 roll 로 넘어가고, roll 은 메타 부재로 중단한 뒤
    // 다시 대기를 예약한다 — 새 'waiting' 이 더 뒤의 시각으로 게시되는 것이 침묵이 끝났다는 증거다.
    await vi.advanceTimersByTimeAsync(61_000)
    await flush()
    expect(h.sent.slice(sentBefore).map((s) => s.payload.state)).toContain('waiting')
    expect(retryAtOf(h)).toBeGreaterThan(firstRetry)
  })

  // **페이로드를 100 이 아니라 20 으로 두는 이유.** 100 이면 제자리 재개 30초 뒤 fallback 트리거가
  // 먼저 발화하고, onLimit 이 판정 전에 healthyTimer 를 지우므로 정착 판정이 아예 실행되지
  // 않는다 — 그 갈래는 이 테스트가 확인하려는 것이 아니다. 20 은 "statusLine 이 신선한 낮은 값으로
  // 돌아왔다" 는 정상 복구를 나타내고, 한도 문구 자체는 사용량 게이트 없이 감지되므로(detect 경로에서
  // 게이트가 제거된 이유) 첫 한도는 그대로 잡힌다.
  it('메타를 배운 뒤라면 정착 판정이 respawn 하지 않는다', async () => {
    vi.setSystemTime(new Date(T0))
    const h = harness()
    h.payloads.set('s1', payload(20))
    h.coord.register({ ...h.info1, rollAccountIds: ['a1'] })
    h.coord.handleData({ sessionId: 's1', data: LIMIT_WITH_RESET })
    await flush()
    await vi.advanceTimersByTimeAsync(retryAtOf(h) - Date.now() + 1_000)
    expect(resumeCount(h)).toBe(1)
    const eventsBefore = h.events.length
    await vi.advanceTimersByTimeAsync(61_000)
    await flush()
    expect(h.events.slice(eventsBefore).filter((e) => e.startsWith('spawn') || e.startsWith('kill'))).toEqual([])
  })

  // 정착 판정만 있으면 이렇게 돈다: 대기 → 제자리 재개(입력) → 60초 → 메타 없음 → roll 중단 →
  // 대기(리셋이 지났으므로 60초 바닥) → 제자리 재개(또 입력) → … 약 2분마다 PTY 로 영구히
  // 타이핑한다. codex 는 같은 것을 inPlaceUsed 로 묶는다 — 한 차단 에피소드에 제자리 재개는 한 번.
  it('정착에 실패한 에피소드는 두 번째부터 제자리 재개를 쓰지 않는다', async () => {
    vi.setSystemTime(new Date(T0))
    const h = harness()
    h.coord.register({ ...h.info1, rollAccountIds: ['a1'] })
    h.coord.handleData({ sessionId: 's1', data: LIMIT_WITH_RESET })
    await flush()
    await vi.advanceTimersByTimeAsync(retryAtOf(h) - Date.now() + 1_000)
    expect(resumeCount(h)).toBe(1)
    // 정착 실패 → roll 중단 → 재예약. 그 뒤 세 라운드를 더 돈다.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(61_000)
      await flush()
      await vi.advanceTimersByTimeAsync(retryAtOf(h) - Date.now() + 1_000)
      await flush()
    }
    // 라운드가 실제로 돌았다(재예약이 계속된다)…
    expect(retryAtOf(h)).toBeGreaterThan(T0)
    // …그러나 프롬프트는 첫 라운드의 한 번뿐이다
    expect(resumeCount(h)).toBe(1)
  })

  // payload(20) 인 이유는 바로 위 테스트의 주석과 같다 — 100 이면 fallback 이 정착 판정보다 먼저
  // 발화해 healthyTimer 를 지우고, inPlaceUsed 가 해제되지 않아 이 테스트가 확인하려는 것이 사라진다.
  it('정착에 성공하면 다음 에피소드는 다시 제자리 재개를 쓴다', async () => {
    vi.setSystemTime(new Date(T0))
    const h = harness()
    h.payloads.set('s1', payload(20))
    h.coord.register({ ...h.info1, rollAccountIds: ['a1'] })
    h.coord.handleData({ sessionId: 's1', data: LIMIT_WITH_RESET })
    await flush()
    await vi.advanceTimersByTimeAsync(retryAtOf(h) - Date.now() + 1_000)
    expect(resumeCount(h)).toBe(1)
    await vi.advanceTimersByTimeAsync(61_000) // 정착 성공 → inPlaceUsed 해제
    await flush()
    // 두 번째 에피소드: 새 한도 → 대기 → 제자리 재개가 다시 쓰인다
    h.coord.handleData({ sessionId: 's1', data: LIMIT_WITH_RESET })
    await flush()
    await vi.advanceTimersByTimeAsync(retryAtOf(h) - Date.now() + 1_000)
    expect(resumeCount(h)).toBe(2)
  })

  // 재현 시나리오: 페이로드가 전혀 없다가 정착 창(60초)이 끝나기 몇 초 전에야 도착한다 — tickChain은
  // 15초마다만 캐시를 새로 쓰므로 이 몇 초는 마지막 tick 간격 안에 들어가 그 tick으로는 못 본다.
  // settleInPlace가 스스로 refreshMeta 하지 않으면 낡은 캐시만 보고 kill·spawn(respawn)해 버린다.
  it('정착 창 막바지에 도착한 메타는 kill·spawn 없이 정착된다', async () => {
    // 초 단위를 어긋나게 둬 정착 마감이 정기 tick 경계와 겹치지 않게 한다 — 겹치면 그 tick이 먼저
    // 캐시를 새로 써서 이 테스트가 재현하려는 "마지막 tick 간격 안" 자체가 사라진다.
    vi.setSystemTime(new Date(T0 + 8_000))
    const h = harness() // 페이로드 없음 → 초기에는 메타를 못 배운다
    h.coord.register({ ...h.info1, rollAccountIds: ['a1'] })
    h.coord.handleData({ sessionId: 's1', data: LIMIT_WITH_RESET })
    await flush()
    const firstRetry = retryAtOf(h)
    await vi.advanceTimersByTimeAsync(firstRetry - Date.now() + 1_000)
    expect(resumeCount(h)).toBe(1) // 제자리 재개가 일어났다
    const eventsBefore = h.events.length
    // 정착 마감(제자리 재개 + 60초) 6초 전, 마지막 정기 tick이 지나간 직후에야 페이로드가 도착한다.
    await vi.advanceTimersByTimeAsync(53_000)
    h.payloads.set('s1', payload(20))
    await vi.advanceTimersByTimeAsync(7_000)
    await flush()
    expect(h.events.slice(eventsBefore).filter((e) => e.startsWith('spawn') || e.startsWith('kill'))).toEqual([])
  })

  // 레이스 재현: 정착 판정이 메타를 다시 읽는 동안, 같은 세션에서 진짜 한도가 다시 걸려 liveId 를
  // 바꾸지 않는 대기를 세운다(onLimit 의 재키 없는 갈래 — 단일 계정 체인이라 그 갈래만 존재한다).
  // 고치기 전에는 그 읽기가 refreshMeta 안에서 곧바로 적용되어(가드보다 먼저) 건강하다고 선언하고,
  // 방금 세운 대기가 막 남긴 차단 기록을 지웠다.
  it('정착 판정의 늦은 메타 읽기가 그 사이에 다시 걸린 한도의 대기를 지우지 않는다', async () => {
    // 정착 마감이 정기 tick 경계와 겹치지 않도록 초 단위를 어긋나게 둔다 — 위 테스트와 같은 이유.
    vi.setSystemTime(new Date(T0 + 8_000))
    const blocks = new BlockRegistry()
    const payloads = new Map<string, unknown>()
    let armed = false
    // 객체에 담는다 — 클로저 안에서 대입된 let 변수를 나중에 호출하면 TS 의 흐름 분석이 그 사이의
    // 다른 호출(같은 클로저를 다시 태울 수 있는 handleData 등)을 반영하지 못해 타입을 never 로
    // 좁혀 버린다.
    const late: { resolve: ((v: unknown) => void) | null } = { resolve: null }
    const h = harness({
      blocks,
      readStatusPayload: (id) => {
        if (armed) {
          armed = false // 다음 한 번만 붙잡는다 — 정착 판정 자신의 읽기여야 한다
          return new Promise<unknown>((resolve) => {
            late.resolve = resolve
          })
        }
        return Promise.resolve(payloads.get(id) ?? null)
      }
    })
    // 페이로드 없음 — statusLine 을 못 배운 채로 대기·정착 창을 지난다("메타를 여전히 못 배웠으면"
    // 테스트와 같은 조건). limitTail 이 생기지 않으므로 정기 tick 이 실제 fs 를 건드리지 않고, 그
    // 사이의 tick 이 언제 정착 판정 자신의 읽기와 같은 순간에 겹칠지 신경 쓸 필요가 없어진다.
    h.coord.register({ ...h.info1, rollAccountIds: ['a1'] })
    h.coord.handleData({ sessionId: 's1', data: LIMIT_WITH_RESET })
    await flush()
    const firstRetry = retryAtOf(h)
    await vi.advanceTimersByTimeAsync(firstRetry - Date.now() + 1_000)
    expect(resumeCount(h)).toBe(1) // 제자리 재개가 일어났다

    // 정착 마감(60초) 6초 전까지는 정상 진행.
    await vi.advanceTimersByTimeAsync(53_000)
    armed = true
    await vi.advanceTimersByTimeAsync(7_000) // healthyTimer 발화 — 이 읽기만 붙잡아 둔다
    expect(late.resolve).not.toBeNull() // 정착 판정 자신의 읽기가 실제로 붙잡혔다는 확인

    // 같은 세션에서 진짜 한도가 다시 걸린다. 이번에는 statusLine 이 살아 있다 — liveId 는 그대로다
    // (재키 없음) — onLimit 이 대기를 세우고 차단 기록을 남긴다.
    payloads.set('s1', payload(20))
    h.coord.handleData({ sessionId: 's1', data: LIMIT_WITH_RESET })
    await flush()
    expect(lastWaiting(h.sent)).toBeTruthy() // 대기가 실제로 섰다
    expect(blocks.get('a1', Date.now())).not.toBeNull() // 그 대기가 막 남긴 차단 기록

    // 붙잡아 둔 읽기가 이제야 돌아온다 — 세션이 이미 다른 판정으로 넘어간 뒤에 도착한 낡은 메타다.
    // 고치기 전에는 이 적용이 정착 판정의 가드보다 먼저 끝나 버려, 방금 세운 차단 기록을
    // blocks.clear 가 지웠다 — pushState 를 부르지 않는 갈래라 h.sent 로는 드러나지 않으므로
    // 판별은 공유 차단 레지스트리(blocks)로만 가능하다.
    late.resolve?.(payload(20))
    await flush()
    expect(blocks.get('a1', Date.now())).not.toBeNull()
  })
})

// 히스토리에서 이미 한도에 걸린 대화를 다시 열면 statusLine 이 오지 않는다(한도가 그 호출을 멈춘다).
// 예전에는 그래서 계정을 갈아탈 수 없었다 — 넘길 대화 파일이 무엇인지 몰라 roll 이 중단됐다.
// 그런데 앱은 그 두 값을 이미 알고 있다: 사용자가 목록에서 고른 대화 id, 그리고 대상 계정 폴더로
// 복사해 둔 경로. 등록할 때 그것을 받아 두면 statusLine 없이도 전환이 성립한다.
describe('등록 시점의 재개 정보', () => {
  const T0 = Date.UTC(2026, 7, 3, 0, 0)
  const LIMIT_WITH_RESET = limitWithReset('session', '11am')
  const DEST = path.join('D:\\cfg', 'a1', 'projects', 'D--work-p', 'hist-sess.jsonl')

  it('statusLine 이 없어도 히스토리 재개 정보로 계정을 갈아탄다', async () => {
    vi.setSystemTime(new Date(T0))
    const h = harness() // 페이로드 없음 — statusLine 은 끝내 오지 않는다
    h.coord.register({ ...h.info1, resumeSessionId: 'hist-sess' }, DEST)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_WITH_RESET })
    await flush()
    // 예전에는 여기서 events 가 비어 있었다(중단). 이제 복사하고 갈아탄다.
    expect(h.events).toEqual(['copy', 'kill:s1', 'spawn:s2:a2'])
    expect(h.copied[0]?.src).toBe(DEST)
    expect(h.spawned.at(-1)?.resumeSessionId).toBe('hist-sess')
  })

  it('재개 정보가 없으면 예전처럼 빈 칸으로 시작한다', async () => {
    vi.setSystemTime(new Date(T0))
    const h = harness()
    h.coord.register(h.info1) // 새 세션 — 재개가 아니다
    h.coord.handleData({ sessionId: 's1', data: LIMIT_WITH_RESET })
    await flush()
    expect(h.events).toEqual([]) // statusLine 을 못 배웠으므로 중단
    expect(h.sent.at(-1)?.payload.state).toBe('waiting')
  })

  // register 는 학습된 값이 아니라 별도의 시드 필드(resumeSeedSessionId/resumeSeedTranscriptPath)를
  // 채운다 — claudeSessionId·transcriptPath 는 여기서 여전히 null 로 시작한다. statusLine 이 tick
  // 한 번을 통해 진짜 값을 배우면, roll() 은 그 학습된 값을 쓰고 시드는 쓰지 않는다.
  it('statusLine 이 학습되면 roll 은 시드가 아니라 학습된 값을 쓴다', async () => {
    vi.setSystemTime(new Date(T0))
    const h = harness()
    h.coord.register({ ...h.info1, resumeSessionId: 'hist-sess' }, DEST)
    h.payloads.set('s1', payload(20)) // statusLine 이 살아났다 — 다른 세션 id 를 싣는다
    await vi.advanceTimersByTimeAsync(16_000) // tick 한 번 — claudeSessionId·transcriptPath 를 학습한다
    h.coord.handleData({ sessionId: 's1', data: LIMIT_WITH_RESET })
    await flush()
    // payload() 가 싣는 값이 쓰인다 — 시드 'hist-sess' 가 아니다
    expect(h.spawned.at(-1)?.resumeSessionId).toBe('claude-sess')
  })

  // 이 재설계의 이유. 시드는 roll() 의 폴백일 뿐 "statusLine 이 돌아왔는가"의 증거가 아니다 —
  // settleInPlace 는 claudeSessionId·transcriptPath 만 보고, 시드는 절대 읽지 않는다. 그래서
  // 히스토리 재개 정보가 있어도 statusLine 이 끝내 오지 않으면 정착 판정은 여전히 "메타 없음"으로
  // 읽어 respawn 시도(roll)로 넘어가야 한다 — 건강하다고 잘못 선언해 아무 일도 하지 않으면 안 된다.
  // 누군가 나중에 학습된 필드를 시드로 미리 채우면 이 테스트가 깨진다.
  it('시드는 정착 판정의 건강 증거로 쓰이지 않는다', async () => {
    vi.setSystemTime(new Date(T0))
    const logs: string[] = []
    const h = harness({ log: (m) => logs.push(m) })
    h.coord.register({ ...h.info1, rollAccountIds: ['a1'], resumeSessionId: 'hist-sess' }, DEST)
    // 페이로드 없음 — statusLine 은 끝내 오지 않는다. 단일 계정이므로 대기 → 제자리 재개 경로.
    h.coord.handleData({ sessionId: 's1', data: LIMIT_WITH_RESET })
    await flush()
    const firstRetry = Date.parse(String(lastWaiting(h.sent)?.nextRetryAt))
    await vi.advanceTimersByTimeAsync(firstRetry - Date.now() + 1_000)
    expect(resumeCount(h)).toBe(1) // 제자리 재개가 일어났다
    logs.length = 0
    // 정착 마감(60초). 시드가 있어도 statusLine 이 오지 않았으므로 판정은 "메타 없음" 그대로다.
    await vi.advanceTimersByTimeAsync(61_000)
    await flush()
    expect(logs.some((l) => l.includes('no session metadata'))).toBe(true)
    // roll() 은 그 시드를 폴백으로 써서 실제로 전환한다(같은 계정으로 재개) — 판정이 "건강하다"로
    // 잘못 선언해 아무 일도 하지 않는 것과는 다른 결과다.
    expect(h.events).toEqual(['copy', 'kill:s1', 'spawn:s2:a1'])
  })
})
