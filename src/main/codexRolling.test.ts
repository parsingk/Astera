import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHook } from 'node:async_hooks'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Account, SessionInfo } from '../core/types'
import { BlockRegistry } from '../core/rolling/blockRegistry'
import { CodexRollingCoordinator, type CodexRollingDeps } from './codexRolling'

let tmp: string

const acc = (id: string, label: string): Account => ({
  id,
  label,
  configDir: path.join(tmp, id),
  color: '#fff',
  createdAt: '2026-07-29T00:00:00Z',
  provider: 'codex'
})

interface Snapshot {
  primary?: number
  secondary?: number
  reached?: string | null
  primaryReset?: number // epoch 초
}

/** 실측 형태를 본뜬 token_count 한 줄 — rate_limits 는 payload 바로 아래다 (codexSignal.ts 의 rateLimitsOf 주석) */
const tokenCountLine = (opts: Snapshot): string =>
  JSON.stringify({
    timestamp: new Date(Date.now()).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { total_tokens: 100 } },
      rate_limits: {
        primary: { used_percent: opts.primary ?? 0, window_minutes: 300, resets_at: opts.primaryReset ?? 0 },
        secondary: { used_percent: opts.secondary ?? 0, window_minutes: 10080, resets_at: 0 },
        rate_limit_reached_type: opts.reached ?? null
      }
    }
  })

/** 이미 있는 rollout에 스냅숏 한 줄을 덧붙인다 — 재개된 codex가 기존 파일에 이어 쓰는 상황 */
const appendTokenCount = (file: string, opts: Snapshot): Promise<void> =>
  fs.appendFile(file, tokenCountLine(opts) + '\n', 'utf8')

/** 실제로 발화하는 한도 신호 한 줄 — `task_complete` 이 싣는 구조 에러다(codexSignal.ts 의
 *  limitErrorOf). reachedType 은 실측 1288건 전부 null 이라 화면 문구 없이 판정을 내는 것은 이
 *  레코드뿐이고, **CodexRolloutTail 의 캐시에 남는 것도 이것**이다. 문구는 LIMIT_TEXT 와 같은
 *  이유로 접합한다 — 통짜면 이 파일이 롤링 세션의 화면으로 흐를 때 스캐너가 문다. */
const appendLimitError = (file: string): Promise<void> =>
  fs.appendFile(
    file,
    JSON.stringify({
      timestamp: new Date(Date.now()).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        error: {
          message: "You've hit your " + 'usage limit.',
          codex_error_info: 'usage_limit_exceeded'
        }
      }
    }) + '\n',
    'utf8'
  )

/** 실제 rollout 파일을 만든다 — 코디네이터가 findRollout·CodexRolloutTail로 진짜 읽는다 */
async function writeRollout(opts: {
  accountId: string
  uuid: string
  cwd: string
  primary?: number
  secondary?: number
  reached?: string | null
  primaryReset?: number // epoch 초
}): Promise<string> {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const dir = path.join(
    tmp, opts.accountId, 'sessions',
    String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())
  )
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `rollout-2026-07-29T00-00-00-${opts.uuid}.jsonl`)
  const lines = [
    JSON.stringify({ type: 'session_meta', payload: { session_id: opts.uuid, cwd: opts.cwd } })
  ]
  if (opts.primary !== undefined || opts.reached !== undefined) lines.push(tokenCountLine(opts))
  await fs.writeFile(file, lines.join('\n') + '\n', 'utf8')
  // fake timer의 Date.now()(고정)와 실제 파일시스템 시계가 섞이는 지점 — findRollout은 생성 시각이
  // since(=register 시각) 이후인 파일만 본다. birthtime은 조작할 수 없고 실제 '지금'이라 통과하지만,
  // birthtime을 못 주는 파일시스템에서는 mtime 폴백이 걸리므로 fake now 기준으로 함께 지정한다.
  const t = (Date.now() + 1_000) / 1000
  await fs.utimes(file, t, t)
  return file
}

function harness(overrides: Partial<CodexRollingDeps> = {}): {
  coord: CodexRollingCoordinator
  events: string[]
  sent: { channel: string; payload: Record<string, unknown> }[]
  copied: { src: string; dest: string }[]
  spawned: {
    info: SessionInfo
    resumePrompt?: string
    resumeSessionId?: string
    initialPrompt?: string
    orchEnv?: { cliPath: string; infoPath: string; skillsPath: string }
  }[]
  written: [string, string][]
  info1: SessionInfo
} {
  const accounts: Record<string, Account> = { c1: acc('c1', 'Codex A'), c2: acc('c2', 'Codex B') }
  const events: string[] = []
  const sent: { channel: string; payload: Record<string, unknown> }[] = []
  const copied: { src: string; dest: string }[] = []
  const spawned: {
    info: SessionInfo
    resumePrompt?: string
    resumeSessionId?: string
    initialPrompt?: string
    orchEnv?: { cliPath: string; infoPath: string; skillsPath: string }
  }[] = []
  const written: [string, string][] = []
  let seq = 1
  const coord = new CodexRollingCoordinator({
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
      spawned.push({
        info,
        resumePrompt: opts.resumePrompt,
        resumeSessionId: opts.resumeSessionId,
        initialPrompt: opts.initialPrompt,
        orchEnv: opts.orchEnv
      })
      events.push(`spawn:${info.id}:${opts.account.id}`)
      return info
    },
    kill: (id) => events.push(`kill:${id}`),
    write: (id, data) => {
      written.push([id, data])
    },
    getAccount: (id) => accounts[id] ?? null,
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
  } satisfies CodexRollingDeps)
  const info1: SessionInfo = {
    id: 's1',
    accountId: 'c1',
    cwd: path.join(tmp, 'work', 'p'),
    status: 'running',
    title: 'p',
    rollAccountIds: ['c1', 'c2']
  }
  // settleIo가 "아직 뭔가 도착하는 중인가"를 판단할 근거 — 자세한 이유는 settleIo 위 주석에
  ioProbes.push(() => events.length + sent.length + copied.length + spawned.length + written.length)
  return { coord, events, sent, copied, spawned, written, info1 }
}

// codex 0.146.0에서 관찰한 한도 문구.
// 접합으로 쪼갠다 — 통짜면 이 파일이 롤링 세션의 화면으로 흐를 때 CodexLimitScanner가 물어
// 실제 롤을 유발한다. 런타임 값은 같다.
const LIMIT_TEXT = "You’ve hit your " + 'usage limit. Upgrade to Plus to continue'

// 한도 임박 모델 전환 프롬프트(codex 0.149.1). 머리말은 같은 이유로 접합한다 — 이쪽은 발화하면
// 롤이 아니라 세션에 키 입력이 들어간다.
const MODEL_PROMPT = [
  '  Approaching rate ' + 'limits',
  '  Switch to gpt-5.6-luna for lower credit usage?',
  '  1. Switch to gpt-5.6-luna              Fast and affordable agentic coding model.',
  '❯ 2. Keep current model',
  '  3. Keep current model (never show again)',
  '  Press enter to confirm or esc to go back'
].join('\n')

// 코디네이터는 진짜 파일을 읽는다(findRollout·CodexRolloutTail). fake timer가 걸린 동안에는 실제
// fs I/O 완료 콜백이 돌지 않아, 타이머만 진행시키면 폴링이 파일을 못 본 채로 끝난다. 그래서 fake
// 타이머를 진행시킨 뒤 실제 타이머로 이벤트 루프에 시간을 줘서 I/O를 정착시킨다.
const realSetTimeout = setTimeout
// 하네스가 등록하는 "지금까지 기록된 이벤트 수" 프로브 — rolling.test.ts와 같은 처방이다
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

/** 폴링·타이머를 진행시키고 대기 중인 Promise(실제 fs I/O 포함)를 소화한다 */
const advance = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
  await settleIo()
  await vi.advanceTimersByTimeAsync(0) // I/O 완료로 새로 예약된 타이머 실행
  await settleIo()
}

/** 대기 만료가 **제자리 재개**로 이어지는 자리에서 advance 대신 쓴다.
 *
 *  `resumeInPlace` 는 rollout 기준 크기를 await 한 뒤에야 ENTER_DELAY_MS 엔터 타이머를 건다. 그 순서가
 *  안전의 핵심이다 — 기준선이 제출 기록보다 늦게 읽히면 삼켜진 입력이 살아 있는 것처럼 보인다. 대신 그
 *  await 는 advance 의 마지막 `advanceTimersByTimeAsync(0)` 뒤에 풀릴 수 있어, 엔터 타이머가 그 라운드
 *  밖에 걸린다. 한 라운드를 더 줘야 엔터까지 관찰된다 — 없으면 `written` 이 문장 하나로 끝나고, 그것도
 *  부하에 따라 들쭉날쭉해진다(같은 커밋에서 6건과 5건이 번갈아 실패했다). */
const advanceIntoResume = async (ms: number): Promise<void> => {
  await advance(ms)
  await advance(200) // 150ms 엔터 타이머 + 여유
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-cxroll-'))
  vi.useFakeTimers()
  ioProbes.length = 0 // 지난 테스트의 하네스는 settleIo의 판단 근거가 될 수 없다
})
afterEach(async () => {
  vi.useRealTimers()
  await fs.rm(tmp, { recursive: true, force: true }) // 실행마다 임시 디렉터리가 쌓이지 않게
})

describe('CodexRollingCoordinator', () => {
  it('rollout을 찾아 매핑한 뒤 한도 문구+게이트로 복사→kill→resume 롤한다', async () => {
    const h = harness()
    const src = await writeRollout({ accountId: 'c1', uuid: 'cx-1', cwd: h.info1.cwd, primary: 95 })
    h.coord.register(h.info1)
    await advance(1_500) // 매핑 폴링
    // 구조화 신호를 setup 이 아니라 문구 바로 앞에 덧붙이는 이유: tick 도 limitReached 를 부르고 구조화
    // 신호는 문구 없이도 참이므로, setup 에 두면 15초 tick 이 문구보다 먼저 발화해 이 테스트의 타이밍이
    // 달라진다. 문구가 방아쇠라는 이 테스트의 성격을 유지하려면 덧붙이는 시점이 그 직전이어야 한다.
    await appendLimitError(src)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    expect(h.events).toEqual(['copy', 'kill:s1', 'spawn:s2:c2'])
    expect(h.copied[0].src).toBe(src)
    expect(h.copied[0].dest).toContain(path.join('c2', 'sessions'))
    expect(h.spawned[0].resumeSessionId).toBe('cx-1')
    expect(h.spawned[0].resumePrompt).toBe('이어서 작업 진행해 줘')
    expect(h.sent.some((s) => s.channel === 'session:rolled')).toBe(true)
    h.coord.stop()
  })

  // fix round 2: 배선 계층에 테스트가 없어서, 훅이 실제로 무엇을 묻고 그 값이 정말 spawn 인자로
  // 가는지가 미검증이었다(기존 테스트는 전부 `?? chain.prompt` 폴백만 지나간다).
  it('resumeText 에 handover 를 묻고 그 값을 resumePrompt 로 실어 보낸다', async () => {
    const forms: string[] = []
    const h = harness({
      resumeText: (_sessionId, form) => {
        forms.push(form)
        return Promise.resolve('RE-READ YOUR SPEC FILE')
      }
    })
    const file = await writeRollout({ accountId: 'c1', uuid: 'cx-hook', cwd: h.info1.cwd, primary: 95 })
    h.coord.register(h.info1)
    await advance(1_500) // 매핑 폴링
    await appendLimitError(file)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    // codex 롤은 계정 수와 무관하게 항상 kill + --resume 이므로 늘 전체 인계다(SPEC §11.5)
    expect(forms).toEqual(['handover'])
    expect(h.spawned[0].resumePrompt).toBe('RE-READ YOUR SPEC FILE')
    h.coord.stop()
  })

  // fix round 2: 이 호출은 roll() 바깥 try 안에 있고 그 catch 는 kill·respawn 앞에서 돈다 —
  // 가드가 없으면 깨진 packet 계약이 롤 자체를 중단시켜 워커를 한도에 멈춘 채로 남긴다.
  it('resumeText 가 던져도 롤은 계속되고 기존 문장으로 재개한다', async () => {
    const h = harness({ resumeText: () => Promise.reject(new Error('packet contract broke')) })
    const file = await writeRollout({ accountId: 'c1', uuid: 'cx-throw', cwd: h.info1.cwd, primary: 95 })
    h.coord.register(h.info1)
    await advance(1_500) // 매핑 폴링
    await appendLimitError(file)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    expect(h.events).toEqual(['copy', 'kill:s1', 'spawn:s2:c2'])
    expect(h.spawned[0].resumePrompt).toBe('이어서 작업 진행해 줘')
    h.coord.stop()
  })

  // Task 3 (Phase 2c): resumeStrategy 가 'smart' 이고 브리핑을 실제로 만들 수 있을 때만 백지
  // 재개다 — rollout 복사도 `--resume` 도 하지 않고 새 codex 프로세스를 브리핑 하나만 들려 띄운다.
  // 브리핑을 못 만들면(dep 이 없거나 null 을 돌리면) 이 스위치가 켜져 있어도 오늘의 경로 그대로다
  // (계획의 지배 제약). resumePrompt 가 아니라 initialPrompt 로 싣는 이유는 spawn dep 의 JSDoc 참고
  // — resumePrompt 는 `codex resume <id>` 뒤에만 붙는 인자라 resumeSessionId 없이는 조용히
  // 버려진다(commands.ts 의 buildCodexCommand).
  describe('Smart Resume — 백지 재개', () => {
    it('전략이 smart 이고 브리핑이 있으면 복사 없이 --resume 없이 백지로 띄운다', async () => {
      const h = harness({
        resumeStrategy: () => 'smart',
        resumeText: () => Promise.resolve('BRIEFING TEXT')
      })
      const file = await writeRollout({ accountId: 'c1', uuid: 'cx-smart-1', cwd: h.info1.cwd, primary: 95 })
      h.coord.register(h.info1)
      await advance(1_500) // 매핑 폴링
      await appendLimitError(file)
      h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
      await advance(100)
      expect(h.copied).toEqual([])
      expect(h.events).toEqual(['kill:s1', 'spawn:s2:c2']) // 'copy' 가 없다
      expect(h.spawned.at(-1)?.resumeSessionId).toBeUndefined()
      expect(h.spawned.at(-1)?.resumePrompt).toBeUndefined()
      expect(h.spawned.at(-1)?.initialPrompt).toBe('BRIEFING TEXT')
      h.coord.stop()
    })

    // 이 테스트가 계획의 지배 제약("브리핑을 만들 수 없으면 백지 재개를 하지 않는다")을 지키는 자리다.
    it('전략이 smart 이어도 브리핑이 null 이면 기존 경로로 롤한다', async () => {
      const h = harness({
        resumeStrategy: () => 'smart',
        resumeText: () => Promise.resolve(null)
      })
      const file = await writeRollout({ accountId: 'c1', uuid: 'cx-smart-2', cwd: h.info1.cwd, primary: 95 })
      h.coord.register(h.info1)
      await advance(1_500)
      await appendLimitError(file)
      h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
      await advance(100)
      expect(h.events).toEqual(['copy', 'kill:s1', 'spawn:s2:c2'])
      expect(h.copied[0]?.src).toBe(file)
      expect(h.spawned.at(-1)?.resumeSessionId).toBe('cx-smart-2')
      expect(h.spawned.at(-1)?.initialPrompt).toBeUndefined()
      h.coord.stop()
    })

    it('전략이 original 이면 브리핑이 있어도 기존 경로로 롤한다', async () => {
      const h = harness({
        resumeStrategy: () => 'original',
        resumeText: () => Promise.resolve('BRIEFING TEXT')
      })
      const file = await writeRollout({ accountId: 'c1', uuid: 'cx-smart-3', cwd: h.info1.cwd, primary: 95 })
      h.coord.register(h.info1)
      await advance(1_500)
      await appendLimitError(file)
      h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
      await advance(100)
      expect(h.events).toEqual(['copy', 'kill:s1', 'spawn:s2:c2'])
      expect(h.spawned.at(-1)?.resumeSessionId).toBe('cx-smart-3')
      expect(h.spawned.at(-1)?.resumePrompt).toBe('BRIEFING TEXT')
      expect(h.spawned.at(-1)?.initialPrompt).toBeUndefined()
      h.coord.stop()
    })

    it('백지 재개 뒤에는 신원 필드가 비어, 재-locate 전 두 번째 한도가 옛 rollout 을 복사하지 않는다', async () => {
      const h = harness({
        resumeStrategy: () => 'smart',
        resumeText: () => Promise.resolve('BRIEFING TEXT')
      })
      const file = await writeRollout({ accountId: 'c1', uuid: 'cx-smart-4', cwd: h.info1.cwd, primary: 95 })
      h.coord.register(h.info1)
      await advance(1_500)
      await appendLimitError(file)
      h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
      await advance(100)
      expect(h.copied).toEqual([]) // 백지 재개 자체는 아무것도 복사하지 않는다
      const newLiveId = h.spawned.at(-1)?.info.id
      expect(newLiveId).toBeDefined()
      const spawnedBefore = h.spawned.length
      // 관측 방법: 새 rollout 파일은 아직 없다(재-locate 가 아직 끝나지 않았다). 이 상태에서 옛
      // (버려진) 파일에 두 번째 한도 기록을 남기고 새 liveId 로 같은 문구를 흘려 본다. 신원 필드
      // (codexSessionId·rolloutPath·tail)가 정말 비었다면 이 체인은 더 이상 그 파일을 tail 하지
      // 않으므로(tick 은 tail 이 없는 체인을 건너뛴다 — private tick()) 아무 것도 복사되거나 다시
      // spawn 되지 않는다. 지워지지 않았다면 옛 tail 이 살아 있어 이 기록을 판정하고 그 파일을
      // 복사했을 것이다.
      await appendLimitError(file)
      h.coord.handleData({ sessionId: newLiveId!, data: LIMIT_TEXT })
      await advance(15_000) // tick 한 바퀴 — 매핑 타임아웃(60초)에는 못 미친다
      expect(h.copied).toEqual([])
      expect(h.spawned.length).toBe(spawnedBefore)
      h.coord.stop()
    })
  })

  it('롤로 띄운 세션에 orchEnv를 실어 보낸다', async () => {
    const env = { cliPath: 'C:/astera/cli.js', infoPath: 'C:/astera/info.json', skillsPath: 'C:/astera/skills' }
    const h = harness({ orchEnv: () => env })
    const file = await writeRollout({ accountId: 'c1', uuid: 'cx-orchenv', cwd: h.info1.cwd, primary: 95 })
    h.coord.register(h.info1)
    await advance(1_500) // 매핑 폴링
    await appendLimitError(file)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    expect(h.spawned[0].orchEnv).toEqual(env)
    h.coord.stop()
  })

  it('orchEnv dep이 주입되지 않으면 실리지 않는다', async () => {
    const h = harness() // 주입 없음
    const file = await writeRollout({ accountId: 'c1', uuid: 'cx-noorchenv', cwd: h.info1.cwd, primary: 95 })
    h.coord.register(h.info1)
    await advance(1_500) // 매핑 폴링
    await appendLimitError(file)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    expect(h.spawned[0].orchEnv).toBeUndefined()
    h.coord.stop()
  })

  it('롤 respawn 시 slackNotify를 그대로 전달한다', async () => {
    const h = harness()
    const file = await writeRollout({ accountId: 'c1', uuid: 'cx-slack', cwd: h.info1.cwd, primary: 95 })
    h.coord.register({ ...h.info1, slackNotify: true })
    await advance(1_500) // 매핑 폴링
    await appendLimitError(file)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    expect(h.spawned[0].info.slackNotify).toBe(true)
    h.coord.stop()
  })

  it('rate_limit_reached_type이 있으면 문구 없이도 롤한다 (판정 ①)', async () => {
    const h = harness()
    await writeRollout({ accountId: 'c1', uuid: 'cx-2', cwd: h.info1.cwd, primary: 40, reached: 'primary' })
    h.coord.register(h.info1)
    await advance(1_500) // 매핑
    await advance(15_000) // 틱 — 문구 없이 상태만으로 감지
    expect(h.events).toContain('spawn:s2:c2')
    h.coord.stop()
  })

  // 폐지(2026-08-28): 문구 단독 분기는 실측 8건에서 진짜를 한 번도 잡지 못했다(0/4) — 진짜 4건은
  // 전부 구조화 신호 + 사용량 99~100% 였고, 문구 단독 4건은 전부 사용량 0~1% 의 화면 재생이었다.
  it('사용률 스냅샷이 낮고 구조화 신호가 없으면 문구가 와도 롤하지 않는다', async () => {
    const logs: string[] = []
    const h = harness({ log: (m) => logs.push(m) })
    await writeRollout({ accountId: 'c1', uuid: 'cx-3', cwd: h.info1.cwd, primary: 42, secondary: 7 })
    h.coord.register(h.info1)
    await advance(1_500)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    expect(h.events).toEqual([])
    expect(logs.some((l) => l.includes('limit-text ignored') && l.includes('primary=42%, secondary=7%'))).toBe(
      true
    )
    h.coord.stop()
  })

  it('한도 문구가 아닌 출력은 사용률이 높아도 롤하지 않는다', async () => {
    const h = harness()
    await writeRollout({ accountId: 'c1', uuid: 'cx-3b', cwd: h.info1.cwd, primary: 97 })
    h.coord.register(h.info1)
    await advance(1_500)
    h.coord.handleData({ sessionId: 's1', data: 'Rate limits    5h  97% used' }) // TUI 패널 출력
    await advance(100)
    expect(h.events).toEqual([])
    h.coord.stop()
  })

  it('rollout을 못 찾으면 롤하지 않는다 (매핑 실패 — 세션은 유지)', async () => {
    const h = harness()
    h.coord.register(h.info1) // rollout 파일을 만들지 않음
    await advance(65_000) // 매핑 타임아웃(60초) 경과
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    expect(h.events).toEqual([])
    h.coord.stop()
  })

  it('단일 계정은 reset 뒤 세션을 죽이지 않고 PTY 로 이어간다 (제자리 재개)', async () => {
    const h = harness()
    const single: SessionInfo = { ...h.info1, rollAccountIds: ['c1'] }
    const resetSec = Math.floor((Date.now() + 300_000) / 1000) // 5분 뒤
    const file = await writeRollout({
      accountId: 'c1', uuid: 'cx-inplace-1', cwd: single.cwd, primary: 99, primaryReset: resetSec
    })
    h.coord.register(single)
    await advance(1_500)
    await appendLimitError(file)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    expect(h.sent.at(-1)?.payload.state).toBe('waiting')
    await advanceIntoResume(400_000) // reset + 여유 경과
    // 죽이지도 띄우지도 않는다 — 복사도 없다(복사는 다른 계정으로 옮길 때만 필요하다)
    expect(h.events).toEqual([])
    // 살아 있는 세션에 문장과 엔터가 들어간다
    expect(h.written).toEqual([['s1', '이어서 작업 진행해 줘'], ['s1', '\r']])
    // 계정 전환이 아니라 순간 이벤트다 — 렌더러 배너는 이것을 남기지 않는다
    expect(h.sent.map((s) => s.payload.state)).toContain('nudged')
    expect(h.sent.at(-1)?.payload.state).toBe('none')
    h.coord.stop()
  })

  it('제자리 재개는 update 형태로 물어 기존 문장에 덧붙인다 (SPEC §11.5)', async () => {
    const forms: string[] = []
    const h = harness({
      resumeText: (_sessionId, form) => {
        forms.push(form)
        return Promise.resolve('git: 3 files changed on branch feature/x')
      }
    })
    const single: SessionInfo = { ...h.info1, rollAccountIds: ['c1'] }
    const resetSec = Math.floor((Date.now() + 300_000) / 1000)
    const file = await writeRollout({
      accountId: 'c1', uuid: 'cx-inplace-2', cwd: single.cwd, primary: 99, primaryReset: resetSec
    })
    h.coord.register(single)
    await advance(1_500)
    await appendLimitError(file)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    await advanceIntoResume(400_000)
    expect(forms).toEqual(['update']) // 세션이 살아 있으므로 인계가 아니다
    expect(h.written[0]).toEqual([
      's1',
      '이어서 작업 진행해 줘 git: 3 files changed on branch feature/x'
    ])
    h.coord.stop()
  })

  // 이 테스트의 픽스처는 화면 문구가 아니라 **rollout 의 구조 에러**로 대기를 만든다. 그것이 실제로
  // 발화하는 신호이고(appendLimitError), 동시에 resumeInPlace 의 ①·② 가 막는 재발화의 재료다:
  // CodexRolloutTail.read() 는 새 줄이 없으면 **캐시된 상태를 그대로 돌려주고** refresh 는 non-null
  // 일 때만 대입한다. 그래서 ①(tail 재부착)이나 ②(state=null) 어느 하나만 지워도 재개 직후 첫 틱이
  // 그 판정을 다시 읽어 두 번째 'waiting' 을 게시한다. 사용률 스냅숏만으로 만든 픽스처
  // (primary=99, reached=null)는 error 판정이 없고 maxedOut(99<100)도 아니라서 두 줄을 다 지워도
  // 통과했다 — 그것이 이 테스트가 다시 쓰인 이유다.
  it('제자리 재개 뒤 캐시된 한도 판정을 다시 읽지 않는다 (tail 재부착 + state 초기화)', async () => {
    const h = harness()
    const single: SessionInfo = { ...h.info1, rollAccountIds: ['c1'] }
    const resetSec = Math.floor((Date.now() + 120_000) / 1000)
    const file = await writeRollout({
      accountId: 'c1', uuid: 'cx-inplace-3', cwd: single.cwd, primary: 99, primaryReset: resetSec
    })
    h.coord.register(single)
    await advance(1_500)
    await appendLimitError(file)
    await advance(15_000) // 틱 → 구조 에러로 판정 → 대기
    expect(h.sent.at(-1)?.payload.state).toBe('waiting')
    const waitingBefore = h.sent.filter((s) => s.payload.state === 'waiting').length
    await advanceIntoResume(180_000) // 대기 만료(reset+60초) → 제자리 재개, 그리고 그 뒤의 틱들
    expect(h.written.length).toBe(2) // 살아 있는 세션에 문장+엔터가 들어갔다
    // 재개 직후의 틱이 대기를 만든 그 레코드를 다시 읽으면 여기서 무너진다
    expect(h.sent.filter((s) => s.payload.state === 'waiting').length).toBe(waitingBefore)
    // 재개된 세션이 턴을 돌린 흔적 — settleInPlace 의 마감 시각 판정이 성장으로 읽는 바이트다
    await appendTokenCount(file, { primary: 50 })
    await advance(15_000)
    expect(h.sent.filter((s) => s.payload.state === 'waiting').length).toBe(waitingBefore)
    // 이어서 진짜 두 번째 한도가 오면 감지한다
    await appendLimitError(file)
    await advance(15_000)
    expect(h.sent.filter((s) => s.payload.state === 'waiting').length).toBe(waitingBefore + 1)
    h.coord.stop()
  })

  // 첫 한도는 다른 계정이 비어 있어 pickAvailable 이 즉시 전환한다 — 즉 이 테스트는 resumeAfterWait
  // 까지 가지 않고, 그 앞의 즉시 전환 경로가 제자리 재개로 바뀌지 않았음을 지킨다. 대기가 만료된
  // 뒤 계정이 바뀌는 갈래(resumeAfterWait 의 전환 분기)는 아래 '롤 이후에도 재개된 세션의 두 번째
  // 한도를 감지한다' 가 지난다 — 두 계정이 한 바퀴 막힌 뒤의 spawn:s3:c1 이 그것이다.
  it('다계정 체인의 첫 한도는 제자리 재개가 아니라 즉시 복사→kill→spawn 이다 (회귀 방지)', async () => {
    const h = harness()
    const resetSec = Math.floor((Date.now() + 120_000) / 1000)
    const file = await writeRollout({
      accountId: 'c1', uuid: 'cx-inplace-4', cwd: h.info1.cwd, primary: 99, primaryReset: resetSec
    })
    h.coord.register(h.info1)
    await advance(1_500)
    await appendLimitError(file)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    expect(h.events).toEqual(['copy', 'kill:s1', 'spawn:s2:c2']) // 첫 한도는 즉시 전환
    expect(h.written).toEqual([]) // PTY 로 아무것도 쓰지 않는다
    h.coord.stop()
  })

  it('응답 못한 선택 목록이 남아 있으면 제자리 재개 대신 kill 경로로 간다', async () => {
    const h = harness()
    const single: SessionInfo = { ...h.info1, rollAccountIds: ['c1'] }
    const resetSec = Math.floor((Date.now() + 300_000) / 1000)
    const file = await writeRollout({
      accountId: 'c1', uuid: 'cx-inplace-5', cwd: single.cwd, primary: 99, primaryReset: resetSec
    })
    h.coord.register(single)
    await advance(1_500)
    // 머리말만 온 프롬프트 — 번호가 없어 응답할 수 없다(화면에 남는다)
    h.coord.handleData({ sessionId: 's1', data: '  Approaching rate ' + 'limits\n  Switch?\n' })
    await appendLimitError(file)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    await advance(400_000)
    expect(h.events).toEqual(['copy', 'kill:s1', 'spawn:s2:c1']) // 화면을 지우는 경로
    expect(h.written).toEqual([]) // 목록 위에 문장을 타이핑하지 않는다
    h.coord.stop()
  })

  it('제자리 재개가 회복시키지 못하면 두 번째에는 kill 경로로 간다', async () => {
    const h = harness()
    const single: SessionInfo = { ...h.info1, rollAccountIds: ['c1'] }
    const resetSec = Math.floor((Date.now() + 120_000) / 1000)
    const file = await writeRollout({
      accountId: 'c1', uuid: 'cx-inplace-6', cwd: single.cwd, primary: 99, primaryReset: resetSec
    })
    h.coord.register(single)
    await advance(1_500)
    await appendLimitError(file)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    // planRetry는 실측 reset에 RETRY_MARGIN_MS(60초)를 더하므로 첫 대기는 120초가 아니라 실제로는
    // ~180초(120+60) 뒤에 만료된다 — 그 지점을 지나 healthy 구간(60초) 안쪽 ~10초까지 진행한다.
    // 첫 대기 만료 → 제자리 재개
    await advanceIntoResume(188_400)
    expect(h.events).toEqual([]) // 첫 번째는 죽이지 않는다
    expect(h.written.length).toBe(2)
    // healthy 구간 안에서 다시 한도 — 즉 제자리 재개가 회복시키지 못했다. onLimit은 healthyTimer를
    // 먼저 지우므로(자체 clearTimeout) inPlaceUsed 플래그는 여기까지 살아남는다.
    await appendTokenCount(file, { primary: 99, primaryReset: resetSec })
    await appendLimitError(file)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    await advance(70_000) // 두 번째 대기 만료(reset이 이미 과거라 planRetry의 60초 하한이 적용된다)
    expect(h.events).toEqual(['copy', 'kill:s1', 'spawn:s2:c1']) // 이번에는 프로세스를 새로 띄운다
    h.coord.stop()
  })

  // 위 테스트가 막는 것은 "두 번째 한도가 오는" 경우뿐이다. composer 가 우리 한 줄을 그냥 먹으면
  // 세션은 아무것도 출력하지 않고 rollout 에도 아무것도 쓰지 않는다 → 한도가 다시 감지될 일이
  // 없으므로 resumeAfterWait 에 다시 오지도 않고, 워커는 알림 하나 없이 영원히 유휴가 된다.
  // **출력으로는 이것을 알 수 없다** — TUI 가 우리 키 입력을 그대로 에코해서 lastOutputAt 이 전진한다.
  // 그래서 마감 시각의 판정 근거는 rollout 파일의 성장이다.
  it('제자리 재개가 턴을 만들지 못하면 마감 시각에 재spawn 한다 (영구 유휴 방지)', async () => {
    const h = harness()
    const single: SessionInfo = { ...h.info1, rollAccountIds: ['c1'] }
    const resetSec = Math.floor((Date.now() + 120_000) / 1000)
    const file = await writeRollout({
      accountId: 'c1', uuid: 'cx-inplace-stall', cwd: single.cwd, primary: 99, primaryReset: resetSec
    })
    h.coord.register(single)
    await advance(1_500)
    await appendLimitError(file)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    await advanceIntoResume(188_400) // 첫 대기 만료(reset+60초) → 제자리 재개, 마감 시각까지 ~50초 남았다
    expect(h.written.length).toBe(2) // 문장+엔터는 들어갔다
    expect(h.events).toEqual([]) // 아직 아무것도 죽이지 않았다
    // rollout 은 자라지 않는다 — 세션이 그 한 줄을 받아들이지 않았다는 뜻이다
    await advance(60_000) // 마감 시각 경과
    expect(h.events).toEqual(['copy', 'kill:s1', 'spawn:s2:c1']) // 체인이 받아야 했던 재spawn
    h.coord.stop()
  })

  it('제자리 재개가 턴을 만들면 재spawn 하지 않고, 다음 한도는 다시 제자리 재개를 받는다', async () => {
    const h = harness()
    const single: SessionInfo = { ...h.info1, rollAccountIds: ['c1'] }
    const resetSec = Math.floor((Date.now() + 120_000) / 1000)
    const file = await writeRollout({
      accountId: 'c1', uuid: 'cx-inplace-ok', cwd: single.cwd, primary: 99, primaryReset: resetSec
    })
    h.coord.register(single)
    await advance(1_500)
    await appendLimitError(file)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    await advanceIntoResume(188_400) // 첫 대기 만료 → 제자리 재개
    expect(h.written.length).toBe(2)
    // 재개된 세션이 실제로 턴을 돌렸다 — codex 는 받아들인 메시지의 레코드를 즉시 append 한다
    await appendTokenCount(file, { primary: 50 })
    await advance(60_000) // 마감 시각 경과 → 성장했으므로 건강 판정
    expect(h.events).toEqual([]) // 죽이지 않는다
    // 그리고 '에피소드당 한 번' 플래그가 풀렸다 — 다음 한도는 다시 제자리 재개를 받는다
    await appendTokenCount(file, { primary: 99, primaryReset: Math.floor((Date.now() + 120_000) / 1000) })
    await appendLimitError(file)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    await advanceIntoResume(188_400) // 두 번째 대기 만료
    expect(h.events).toEqual([]) // 여전히 프로세스를 죽이지 않는다
    expect(h.written.length).toBe(4) // 두 번째 제자리 재개
    h.coord.stop()
  })

  // roll() 의 healthy 타이머도 같은 플래그를 푼다. 그 한 줄이 없으면 롤 뒤 정상 동작한 세션이 다음
  // 한도에서도 제자리 재개 자격을 못 받아, 계정이 하나인 워커는 리셋마다 프로세스를 새로 띄운다.
  it('롤 뒤 60초 무사하면 제자리 재개 자격이 돌아온다 (에피소드당 한 번 규칙의 해제)', async () => {
    const h = harness()
    const single: SessionInfo = { ...h.info1, rollAccountIds: ['c1'] }
    const resetSec = Math.floor((Date.now() + 120_000) / 1000)
    const file = await writeRollout({
      accountId: 'c1', uuid: 'cx-inplace-8', cwd: single.cwd, primary: 99, primaryReset: resetSec
    })
    h.coord.register(single)
    await advance(1_500)
    await appendLimitError(file)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    await advanceIntoResume(188_400) // 첫 대기 만료 → 제자리 재개(플래그가 선다)
    // healthy 구간 안의 두 번째 한도 → 위 테스트가 지키는 성질에 따라 이번에는 kill 경로다
    await appendTokenCount(file, { primary: 99, primaryReset: resetSec })
    await appendLimitError(file)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    await advance(70_000)
    expect(h.events).toEqual(['copy', 'kill:s1', 'spawn:s2:c1'])
    await advance(60_000) // 롤의 healthy 타이머 만료 — 여기서 플래그가 풀린다
    // 세 번째 한도. 단일 계정 체인은 dest === src 라 롤 뒤에도 같은 파일을 읽는다
    await appendTokenCount(file, { primary: 99, primaryReset: Math.floor((Date.now() + 120_000) / 1000) })
    await appendLimitError(file)
    h.coord.handleData({ sessionId: 's2', data: LIMIT_TEXT })
    await advance(100)
    await advanceIntoResume(188_400) // 세 번째 대기 만료
    expect(h.events).toEqual(['copy', 'kill:s1', 'spawn:s2:c1']) // 두 번째 롤은 없다
    expect(h.written.length).toBe(4) // 첫 제자리 재개 2 + 이번 제자리 재개 2
    h.coord.stop()
  })

  // 아래 두 테스트가 codex 의 **지우는 자리 두 곳**을 각각 못박는다. 위 테스트들은 자기 체인의 기록만
  // 보므로 그 한 줄을 지워도 통과한다 — 공유 기록까지 함께 풀리는지는 다른 체인이 적은 기록으로만
  // 볼 수 있다. 네 체인을 **등록만 먼저** 해 두는 이유: findRollout 은 register 시각 이후에 만들어진
  // 파일만 후보로 보는데, fake 시계를 몇 분 진행시킨 뒤 등록하면 실제 birthtime 이 그보다 앞서서
  // 매핑이 영구히 실패한다(codexLocate 의 since 규칙).
  it('제자리 재개가 턴을 만들면 다른 체인이 적은 공유 기록도 함께 풀린다 (settleInPlace 안전 밸브)', async () => {
    const h = harness()
    const t0 = Date.now()
    const sec = (ms: number): number => Math.floor((t0 + ms) / 1000)
    // 체인 1: 단일 계정 c1, reset 2분 뒤 → 판정 시점의 계획은 3분 뒤 제자리 재개다
    const single: SessionInfo = { ...h.info1, rollAccountIds: ['c1'] }
    const file = await writeRollout({
      accountId: 'c1', uuid: 'cx-clear-a', cwd: single.cwd, primary: 99, primaryReset: sec(120_000)
    })
    h.coord.register(single)
    // 체인 2: 같은 c1 에서 60분짜리 기록을 적는다 — 체인 1 의 대기(3분)보다 오래 남는다
    const cwd2 = path.join(tmp, 'work', 'q')
    const file2 = await writeRollout({
      accountId: 'c1', uuid: 'cx-clear-b', cwd: cwd2, primary: 99, primaryReset: sec(3_600_000)
    })
    h.coord.register({ ...h.info1, id: 's10', cwd: cwd2, rollAccountIds: ['c1', 'c2'] })
    // 체인 3(체크포인트)과 체인 4(마지막 판정): c2 에서 시작하고 c1 은 한 번도 만진 적이 없다
    const cwd3 = path.join(tmp, 'work', 'r')
    const file3 = await writeRollout({
      accountId: 'c2', uuid: 'cx-clear-c', cwd: cwd3, primary: 99, primaryReset: sec(600_000)
    })
    h.coord.register({ ...h.info1, id: 's20', accountId: 'c2', cwd: cwd3, rollAccountIds: ['c2', 'c1'] })
    const cwd4 = path.join(tmp, 'work', 's')
    const file4 = await writeRollout({
      accountId: 'c2', uuid: 'cx-clear-d', cwd: cwd4, primary: 99, primaryReset: sec(600_000)
    })
    h.coord.register({ ...h.info1, id: 's30', accountId: 'c2', cwd: cwd4, rollAccountIds: ['c2', 'c1'] })
    await advance(1_500) // 네 체인의 매핑 폴링
    await appendLimitError(file)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    await appendLimitError(file2)
    h.coord.handleData({ sessionId: 's10', data: LIMIT_TEXT }) // 체인 1 판정 뒤에 적힌다
    await advance(100)
    // 중간 체크포인트: 지금은 기록이 살아 있어야 한다. 체인 3 은 c1 을 만진 적이 없는데도 갈 곳이
    // 없어 대기한다 — 이 단언이 없으면 마지막 단언이 "애초에 공유가 없었다"로도 통과한다.
    const spawnedBefore = h.spawned.length
    await appendLimitError(file3)
    h.coord.handleData({ sessionId: 's20', data: LIMIT_TEXT })
    await advance(100)
    expect(h.spawned.length).toBe(spawnedBefore) // c1 으로 옮기지 않았다
    // 체인 1 의 대기 만료 → 제자리 재개
    await advanceIntoResume(188_400)
    expect(h.written.filter(([id]) => id === 's1')).toHaveLength(2) // 문장 + 엔터
    // 재개된 세션이 실제로 턴을 돌렸다 → settleInPlace 가 건강 판정을 내리고 공유 기록을 지운다
    await appendTokenCount(file, { primary: 50 })
    await advance(60_000) // 마감 시각 경과
    // 체인 4: c1 이 다시 후보다. 기록이 남아 있었다면 여기서도 대기한다
    const spawnedBeforeLast = h.spawned.length
    await appendLimitError(file4)
    h.coord.handleData({ sessionId: 's30', data: LIMIT_TEXT })
    await advance(100)
    // 개수까지 본다 — 마지막 항목만 보면 이전 체인이 남긴 spawn 으로 헛도는 단언이 된다.
    // cwd 까지 보는 이유: 개수는 "누가" 띄웠는지를 말해 주지 않는다. 지금 그 귀속이 맞는 것은 다른
    // 체인들의 재시도가 이 창 밖에 있기 때문일 뿐이라, 픽스처를 손대면 조용히 풀린다.
    expect(h.spawned.length).toBe(spawnedBeforeLast + 1)
    expect(h.spawned.at(-1)?.info.accountId).toBe('c1')
    expect(h.spawned.at(-1)?.info.cwd).toBe(cwd4) // 체인 4 가 띄운 것이다
    h.coord.stop()
  })

  it('롤 뒤 60초 무사하면 다른 체인이 적은 공유 기록도 함께 풀린다 (roll 안전 밸브)', async () => {
    const h = harness()
    const t0 = Date.now()
    const sec = (ms: number): number => Math.floor((t0 + ms) / 1000)
    // 체인 1: [c2, c1] — c2 에서 한도 → c1 로 롤. 이제 c1 에서 정상으로 돌고, healthy 타이머가 걸린다
    const file1 = await writeRollout({
      accountId: 'c2', uuid: 'cx-roll-a', cwd: h.info1.cwd, primary: 99, primaryReset: sec(600_000)
    })
    h.coord.register({ ...h.info1, accountId: 'c2', rollAccountIds: ['c2', 'c1'] })
    // 체인 2: c1 에서 60분짜리 기록을 적는다(오탐이든 진짜든). 갈 곳이 없어 대기로 끝난다
    const cwd2 = path.join(tmp, 'work', 'q')
    const file2 = await writeRollout({
      accountId: 'c1', uuid: 'cx-roll-b', cwd: cwd2, primary: 99, primaryReset: sec(3_600_000)
    })
    h.coord.register({ ...h.info1, id: 's10', cwd: cwd2, rollAccountIds: ['c1', 'c2'] })
    // 체인 3(체크포인트)과 체인 4(마지막 판정)
    const cwd3 = path.join(tmp, 'work', 'r')
    const file3 = await writeRollout({
      accountId: 'c2', uuid: 'cx-roll-c', cwd: cwd3, primary: 99, primaryReset: sec(600_000)
    })
    h.coord.register({ ...h.info1, id: 's20', accountId: 'c2', cwd: cwd3, rollAccountIds: ['c2', 'c1'] })
    const cwd4 = path.join(tmp, 'work', 's')
    const file4 = await writeRollout({
      accountId: 'c2', uuid: 'cx-roll-d', cwd: cwd4, primary: 99, primaryReset: sec(600_000)
    })
    h.coord.register({ ...h.info1, id: 's30', accountId: 'c2', cwd: cwd4, rollAccountIds: ['c2', 'c1'] })
    await advance(1_500) // 네 체인의 매핑 폴링
    await appendLimitError(file1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    expect(h.spawned.at(-1)?.info.accountId).toBe('c1') // 체인 1 이 c1 에 도착했다
    await appendLimitError(file2)
    h.coord.handleData({ sessionId: 's10', data: LIMIT_TEXT }) // c1 을 공유 기록에 올린다
    await advance(100)
    const spawnedBefore = h.spawned.length
    await appendLimitError(file3)
    h.coord.handleData({ sessionId: 's20', data: LIMIT_TEXT })
    await advance(100)
    expect(h.spawned.length).toBe(spawnedBefore) // 체크포인트: c1 으로 옮기지 않고 대기한다
    await advance(65_000) // 체인 1 의 롤 healthy 타이머 만료 → 공유 기록이 지워진다
    const spawnedBeforeLast = h.spawned.length
    await appendLimitError(file4)
    h.coord.handleData({ sessionId: 's30', data: LIMIT_TEXT })
    await advance(100)
    // **개수가 핵심이다.** 이 하네스의 마지막 spawn 은 체인 1 이 c1 으로 롤한 그것이므로,
    // 마지막 항목의 계정만 보면 체인 4 가 아무 데도 가지 않고 대기해도 그대로 통과한다.
    // 그래도 개수는 "누가" 띄웠는지를 말해 주지 않는다 — 지금 그 귀속이 맞는 것은 다른 체인들의
    // 재시도가 이 창 밖에 있기 때문일 뿐이라, cwd 까지 못박는다.
    expect(h.spawned.length).toBe(spawnedBeforeLast + 1)
    expect(h.spawned.at(-1)?.info.accountId).toBe('c1')
    expect(h.spawned.at(-1)?.info.cwd).toBe(cwd4) // 체인 4 가 띄운 것이다
    h.coord.stop()
  })

  // rolling.test.ts 의 '상태 세대 가드' 두 테스트와 같은 성질. codex 는 제자리 재개가 생기면서
  // 처음으로 **지연 게시**를 갖게 됐다 — 엔터 뒤의 'none' 이 150ms 타이머 안에 있으므로, 그 사이에
  // 게시된 'waiting'·'switching' 을 덮어쓴다. 덮으면 스케줄러의 억제가 풀리고 오케스트레이션 정지
  // 표식이 일찍 지워진다.
  it('제자리 재개 엔터 대기(150ms) 중 방해가 있으면 지연된 none을 건너뛴다', async () => {
    const h = harness()
    const single: SessionInfo = { ...h.info1, rollAccountIds: ['c1'] }
    const resetSec = Math.floor((Date.now() + 120_000) / 1000)
    const file = await writeRollout({
      accountId: 'c1', uuid: 'cx-inplace-seq', cwd: single.cwd, primary: 99, primaryReset: resetSec
    })
    h.coord.register(single)
    await advance(1_500)
    await appendLimitError(file)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    // 대기 만료 시각으로 **정확히** 이동한다 — 그러면 문장은 들어갔고 엔터 타이머는 아직 예약 상태다
    const retryAt = Date.parse(String(h.sent.at(-1)?.payload.nextRetryAt))
    await advance(retryAt - Date.now())
    expect(h.written).toEqual([['s1', '이어서 작업 진행해 줘']]) // 엔터는 아직이다
    // 엔터 대기 중 방해: rollout 에 구조 에러가 도착해 두 번째 한도가 잡힌다 → 'waiting' (세대 전진)
    await appendLimitError(file)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100) // 150ms 전 — 판정은 끝났고 엔터는 아직이다
    const waiting = h.sent.at(-1)
    expect(waiting?.payload.state).toBe('waiting')
    await advance(100) // 원래 엔터 타이머 발화 시점 통과
    expect(h.written.at(-1)).toEqual(['s1', '\r']) // 엔터는 세대와 무관하게 그대로 전송된다
    expect(h.sent.at(-1)).toBe(waiting) // 지연된 none 이 최신 'waiting' 을 덮지 않았다
    h.coord.stop()
  })

  it('forceRoll은 게이트를 건너뛰고 즉시 롤한다 (dev 훅)', async () => {
    const h = harness()
    await writeRollout({ accountId: 'c1', uuid: 'cx-5', cwd: h.info1.cwd, primary: 3 })
    h.coord.register(h.info1)
    await advance(1_500)
    await h.coord.forceRoll('s1')
    await advance(100)
    expect(h.events).toContain('spawn:s2:c2')
    h.coord.stop()
  })

  // 아래 unregister 테스트의 대조군. 그 테스트와 setup 이 같고 unregister 한 줄만 없다 — 그것이
  // 부정 단언의 근거다(이 테스트가 통과하는 동안에만 아래가 무언가를 증명한다).
  // **하네스마다 테스트를 나눈다**: findRollout 은 파일의 실제 생성 시각을 register 시각(가짜 시계)과
  // 비교하므로, 한 테스트 안에서 가짜 시간을 45초 흘린 뒤 두 번째 체인을 등록하면 그 체인은 rollout
  // 을 영원히 못 찾는다(그러면 부정 단언이 헛돈다 — 실제로 그렇게 한 번 헛돌았다).
  it('maxed+silent 폴백 틱은 100%+30초 침묵으로 롤한다', async () => {
    const h = harness()
    await writeRollout({ accountId: 'c1', uuid: 'cx-unreg-ctl', cwd: h.info1.cwd, primary: 100 })
    h.coord.register(h.info1)
    await advance(1_500) // 매핑 폴링
    await advance(45_000) // 100% + 30초 침묵 → 폴백 판정 ③
    expect(h.events).toContain('spawn:s2:c2')
    h.coord.stop()
  })

  // Dispatch 가 닫힌 워커 세션. 워커에게 유휴 알림 같은 입력은 필요 없다 — codex 쪽 진입점은
  // 100%로 굳은 스냅숏과 30초 침묵만으로 도는 틱의 폴백 판정이고, 그 끝은 kill + 재spawn 이다.
  it('unregister한 세션은 maxed+silent 틱에도 롤하지 않는다', async () => {
    const h = harness()
    await writeRollout({ accountId: 'c1', uuid: 'cx-unreg', cwd: h.info1.cwd, primary: 100 })
    h.coord.register(h.info1)
    await advance(1_500)
    h.coord.unregister('s1') // Dispatch 가 닫혔다 — 세션은 살아 있다
    await advance(45_000)
    expect(h.events).toEqual([]) // kill 도 spawn 도 없다
    h.coord.stop()
  })

  it('unregister는 등록되지 않은 id에 무해하다 — 다른 체인도 건드리지 않는다', async () => {
    const h = harness()
    await writeRollout({ accountId: 'c1', uuid: 'cx-unreg-2', cwd: h.info1.cwd, primary: 100 })
    h.coord.register(h.info1)
    await advance(1_500)
    expect(() => h.coord.unregister('s-nope')).not.toThrow()
    await advance(45_000)
    expect(h.events).toContain('spawn:s2:c2') // s1 의 체인은 그대로 살아 있다
    h.coord.stop()
  })

  it('handleExit은 체인을 정리한다', async () => {
    const h = harness()
    await writeRollout({ accountId: 'c1', uuid: 'cx-6', cwd: h.info1.cwd, primary: 95 })
    h.coord.register(h.info1)
    await advance(1_500)
    h.coord.handleExit({ sessionId: 's1' })
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    expect(h.events).toEqual([])
    h.coord.stop()
  })

  // reachedType이 계속 non-null인 최악 시나리오(신호 고착)에서도 폭주하지 않는지.
  // 별도 서킷 브레이커를 두지 않기로 한 근거가 이것이다 — RollCycle이 healthy 없이 전 계정을 한
  // 바퀴 돌면 roll 대신 wait을 반환하고, recovery가 reset 미상 계정을 RETRY_FALLBACK_MS 동안
  // 차단한다. 두 겹이 이미 경계를 만든다. 이 테스트는 그 경계가 사라지면 깨진다.
  it('reachedType이 계속 붙어 있어도 롤이 폭주하지 않는다 (RollCycle·recovery 경계)', async () => {
    const h = harness()
    // 롤할 때마다 codex가 새 rollout을 만들고 거기에도 reachedType이 붙어 있는 상황을 흉내낸다.
    let seq = 0
    const feed = async (): Promise<void> => {
      seq++
      for (const accountId of ['c1', 'c2'])
        await writeRollout({ accountId, uuid: `cx-cb-${accountId}-${seq}`, cwd: h.info1.cwd, reached: 'usage_limit' })
      await advance(1_500) // 재매핑 폴링
    }
    await feed()
    h.coord.register(h.info1)
    await advance(1_500)
    for (let i = 0; i < 8; i++) {
      // id 없이 호출 = 첫 활성 체인. 롤마다 세션 id가 바뀌므로 고정 id를 쓰면 안 된다.
      await h.coord.forceRoll().catch(() => {}) // 체인이 wait 상태면 롤하지 않는다
      await advance(100)
      await feed()
    }
    // 8회 강제 시도에도 실제 롤은 소수에 그친다 — 두 번째부터 RollCycle이 wait으로 막는다
    const spawns = h.events.filter((e) => e.startsWith('spawn:')).length
    expect(spawns).toBeGreaterThan(0)
    expect(spawns).toBeLessThanOrEqual(2)
    h.coord.stop()
  })

  it('findLiveByCodexSession으로 활성 체인을 찾는다 (히스토리 resume 가드)', async () => {
    const h = harness()
    await writeRollout({ accountId: 'c1', uuid: 'cx-7', cwd: h.info1.cwd, primary: 10 })
    h.coord.register(h.info1)
    await advance(1_500)
    expect(h.coord.findLiveByCodexSession('cx-7')?.id).toBe('s1')
    expect(h.coord.findLiveByCodexSession('nope')).toBeNull()
    h.coord.stop()
  })

  it('copy 대기 중 stop()하면 kill·spawn을 이어서 하지 않는다 (종료 시 좀비 방지)', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const h = harness({ copy: () => gate }) // 수동으로 풀 때까지 롤이 copy에서 멈춘다
    const file = await writeRollout({ accountId: 'c1', uuid: 'cx-8', cwd: h.info1.cwd, primary: 95 })
    h.coord.register(h.info1)
    await advance(1_500)
    await appendLimitError(file)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    // 롤에 진입해 copy에서 대기 중 — switching 배너는 이미 나갔고 kill/spawn 전이다
    expect(h.sent.some((s) => s.payload.state === 'switching')).toBe(true)
    expect(h.events).toEqual([])

    h.coord.stop() // 앱 종료
    release() // copy 완료
    await advance(100)
    expect(h.events).toEqual([]) // 폐기 후엔 kill도 spawn도 없다
    expect(h.coord.findLiveByCodexSession('cx-8')).toBeNull() // 체인이 되살아나지 않는다
  })

  // 리뷰 지적: 같은 폴더·같은 계정으로 두 롤링 탭을 띄우면 둘 다 같은 rollout을 후보로 본다.
  // 한 대화를 두 체인이 물면 둘 다 롤하고 findLiveByCodexSession도 엉뚱한 탭을 돌려준다.
  it('다른 활성 체인이 점유한 rollout은 물지 않는다 (같은 cwd·계정 동시 세션)', async () => {
    const h = harness()
    const file = await writeRollout({ accountId: 'c1', uuid: 'cx-10', cwd: h.info1.cwd, primary: 95 })
    h.coord.register(h.info1)
    h.coord.register({ ...h.info1, id: 's10' }) // 같은 폴더에서 띄운 두 번째 롤링 탭
    await advance(1_500) // 두 체인이 같은 rollout을 두고 경쟁한다
    await appendLimitError(file)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    h.coord.handleData({ sessionId: 's10', data: LIMIT_TEXT })
    await advance(100)
    expect(h.events.filter((e) => e.startsWith('spawn:'))).toHaveLength(1)
    h.coord.stop()
  })

  // 세 워커가 같은 계정들을 돌면 각자 모든 계정에서 한도를 다시 맞아야 했다 — 워커마다 계정마다
  // kill+respawn 한 번이 낭비였고, 그 낭비를 없애는 것이 공유 기록이다(SPEC §11.2/6).
  it('다른 체인이 막힌 계정을 알려 주면 그 계정을 건너뛴다 (몰림 방지)', async () => {
    // 세 계정이 필요하다 — 두 개면 "막힌 계정을 건너뛴 결과"와 "라운드 로빈이 원래 가리키던 계정"이
    // 같아서 무엇을 검증했는지 알 수 없다. 하네스의 계정 맵은 c1·c2뿐이므로 getAccount만 갈아 준다.
    const accounts: Record<string, Account> = {
      c1: acc('c1', 'Codex A'),
      c2: acc('c2', 'Codex B'),
      c3: acc('c3', 'Codex C')
    }
    const h = harness({ getAccount: (id) => accounts[id] ?? null })
    const resetSec = Math.floor((Date.now() + 300_000) / 1000) // 5분 뒤 — 기록이 살아 있는 창
    // 체인 1: [c1, c2, c3] — c1 에서 한도 → c2 로 롤. 그 순간 c1 이 공유 기록에 올라간다
    const file1 = await writeRollout({
      accountId: 'c1', uuid: 'cx-share-1', cwd: h.info1.cwd, primary: 99, primaryReset: resetSec
    })
    h.coord.register({ ...h.info1, rollAccountIds: ['c1', 'c2', 'c3'] })
    // 체인 2: 같은 계정들을 다른 순서로 도는 둘째 워커. 다른 폴더이므로 rollout 을 서로 물지 않는다.
    // c2 에서 한도를 만나면 라운드 로빈이 가리키는 다음 계정은 c1 이다 — 공유가 없으면 방금 막힌
    // 그 계정으로 그대로 옮겨 간다.
    const cwd2 = path.join(tmp, 'work', 'q')
    const file2 = await writeRollout({
      accountId: 'c2', uuid: 'cx-share-2', cwd: cwd2, primary: 99, primaryReset: resetSec
    })
    h.coord.register({
      ...h.info1,
      id: 's10',
      accountId: 'c2',
      cwd: cwd2,
      rollAccountIds: ['c2', 'c1', 'c3']
    })
    await advance(1_500) // 두 체인의 매핑 폴링
    await appendLimitError(file1)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    expect(h.spawned.at(-1)?.info.accountId).toBe('c2')
    await appendLimitError(file2)
    h.coord.handleData({ sessionId: 's10', data: LIMIT_TEXT })
    await advance(100)
    expect(h.spawned.at(-1)?.info.accountId).toBe('c3')
    h.coord.stop()
  })

  // 리뷰 지적: PTY 청크는 임의 위치에서 잘린다 (detect.ts OutputScanner와 같은 이유)
  it('한도 문구가 두 청크로 쪼개져 와도 감지한다 (청크 경계)', async () => {
    const h = harness()
    const file = await writeRollout({ accountId: 'c1', uuid: 'cx-11', cwd: h.info1.cwd, primary: 95 })
    h.coord.register(h.info1)
    await advance(1_500)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT.slice(0, 12) })
    await appendLimitError(file)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT.slice(12) + '\n' })
    await advance(100)
    expect(h.events).toContain('spawn:s2:c2')
    h.coord.stop()
  })

  it('매핑 전 한도 문구는 사유를 rollout 미매핑으로 남긴다 (캘리브레이션 로그)', async () => {
    const logs: string[] = []
    const h = harness({ log: (m) => logs.push(m) })
    h.coord.register(h.info1) // rollout 파일 없음 → 매핑 실패
    await advance(1_500)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    expect(logs.some((l) => l.includes('limit-text ignored') && l.includes('rollout unmapped'))).toBe(true)
    expect(logs.some((l) => l.includes('undefined%'))).toBe(false)
    h.coord.stop()
  })

  // reachedType 은 실측 1288건 전부 null 이라 이 판정으로 잡히는 일이 없다. 실제로 잡히는 것은
  // task_complete 의 usage_limit_exceeded 이고, 로그가 그것을 'text+gate'(=화면 문구)로 적으면
  // 다음 사람이 신호를 잘못 짚는다.
  it('구조 에러로 잡힌 한도는 판정 근거를 errorInfo로 남긴다', async () => {
    const logs: string[] = []
    const h = harness({ log: (m) => logs.push(m) })
    const file = await writeRollout({
      accountId: 'c1', uuid: 'cx-errreason', cwd: h.info1.cwd, primary: 40
    })
    h.coord.register(h.info1)
    await advance(1_500)
    await fs.appendFile(
      file,
      JSON.stringify({
        timestamp: new Date(Date.now()).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          error: { message: "You've hit your " + 'usage limit.', codex_error_info: 'usage_limit_exceeded' }
        }
      }) + '\n',
      'utf8'
    )
    await advance(15_000) // 틱 — 화면 문구 없이 구조 신호만으로 판정
    const line = logs.find((l) => l.includes('codex limit detected'))
    expect(line).toContain('reason=errorInfo')
    h.coord.stop()
  })

  it('한도 감지 로그에 판정 근거와 reachedType 원값을 남긴다 (미실측 전제 캘리브레이션)', async () => {
    const logs: string[] = []
    const h = harness({ log: (m) => logs.push(m) })
    await writeRollout({
      accountId: 'c1', uuid: 'cx-12', cwd: h.info1.cwd, primary: 40, reached: 'primary'
    })
    h.coord.register(h.info1)
    await advance(1_500)
    await advance(15_000) // 틱 → 판정 ①
    const line = logs.find((l) => l.includes('codex limit detected'))
    expect(line).toContain('reason=reachedType')
    expect(line).toContain('reachedType=primary')
    h.coord.stop()
  })

  // 크레딧이 얼마 안 남으면 codex 가 턴 사이에 "모델 바꿀래?" 선택지를 띄우고 입력을 기다린다.
  // 답하지 않으면 세션이 그 자리에서 멈춘다 — 무인 워커에게는 영구 정지다. 모델을 바꾸면 사용자가
  // 고른 모델이 아닌 것이 일하게 되고, 3번은 codex 설정을 영구히 바꾸므로 2번을 누른다.
  it('한도 임박 모델 전환 프롬프트에 "현재 모델 유지"로 답한다', async () => {
    const h = harness()
    await writeRollout({ accountId: 'c1', uuid: 'cx-choice', cwd: h.info1.cwd, primary: 80 })
    h.coord.register(h.info1)
    await advance(1_500) // 매핑
    h.coord.handleData({ sessionId: 's1', data: MODEL_PROMPT })
    await advance(300) // 숫자 → (150ms) → Enter
    expect(h.written).toEqual([
      ['s1', '2'],
      ['s1', '\r']
    ])
    expect(h.events).toEqual([]) // 한도가 아니라 경고다 — 롤하지 않는다
    h.coord.stop()
  })

  it('선택지 화면이 아닌 출력에는 아무것도 쓰지 않는다', async () => {
    const h = harness()
    await writeRollout({ accountId: 'c1', uuid: 'cx-choice-2', cwd: h.info1.cwd, primary: 80 })
    h.coord.register(h.info1)
    await advance(1_500)
    h.coord.handleData({ sessionId: 's1', data: '2. Keep current model 이라고 문서에 적혀 있다\n' })
    await advance(300)
    expect(h.written).toEqual([])
    h.coord.stop()
  })

  // codex 0.149.1 실측: `codex resume <id>` 는 새 rollout 을 만들지 않고 **기존 파일에 이어 쓴다**.
  // 그래서 '생성 시각이 spawn 이후'로 후보를 거르는 findRollout 은 재개 세션의 rollout 을 영원히 못
  // 찾는다 — 실측 로그가 그대로다: `limit-text ignored (rollout unmapped)` 두 번 뒤 `rollout not
  // found within 60000ms — rolling disabled`. 배선(ipc)은 재개할 파일을 이미 알고 있으므로 그 경로를
  // 넘겨 붙이면 탐색 자체가 필요 없다.
  it('resume 스폰은 넘겨받은 rollout 경로에 바로 붙는다 (findRollout이 못 찾는 파일)', async () => {
    const h = harness()
    // 스냅숏 없이 meta 만 — 재개된 세션이 쓰기 전의 상태다
    const file = await writeRollout({ accountId: 'c1', uuid: 'cx-resume', cwd: h.info1.cwd })
    h.coord.register({ ...h.info1, resumeSessionId: 'cx-resume' }, file)
    await advance(100) // 매핑 폴링(1초)을 기다리지 않는다 — 이미 붙어 있어야 한다
    await appendTokenCount(file, { primary: 95 }) // 재개된 세션이 이어 쓴 스냅숏
    await appendLimitError(file)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    expect(h.events).toEqual(['copy', 'kill:s1', 'spawn:s2:c2'])
    expect(h.spawned[0].resumeSessionId).toBe('cx-resume')
    h.coord.stop()
  })

  // 실측 로그(dev): `codex rolled …` 바로 뒤에 `codex rollout not found within 60000ms — rolling
  // disabled`. 롤의 respawn 도 `codex resume` 이라 새 rollout 이 생기지 않으니 재-locate 는 실패할
  // 수밖에 없고, 그 순간부터 그 체인은 두 번째 한도를 영영 보지 못한다. 단일 계정 체인에서는
  // dest === src 라 excludePaths 가 '지금 codex 가 쓰고 있는 바로 그 파일'을 후보에서 빼는 이중
  // 차단까지 걸린다.
  it('롤 이후에도 재개된 세션의 두 번째 한도를 감지한다 (재-locate 불필요)', async () => {
    let dest = ''
    const h = harness({
      copy: async (src, to) => {
        dest = to
        await fs.mkdir(path.dirname(to), { recursive: true })
        await fs.copyFile(src, to)
      }
    })
    const file = await writeRollout({ accountId: 'c1', uuid: 'cx-2nd', cwd: h.info1.cwd, primary: 95 })
    h.coord.register(h.info1)
    await advance(1_500) // 매핑 폴링
    await appendLimitError(file)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    expect(h.events).toContain('spawn:s2:c2')

    // 재개된 codex 는 새 파일을 만들지 않고 복사본(dest)에 이어 쓴다
    await appendTokenCount(dest, { primary: 96 })
    await appendLimitError(dest)
    h.coord.handleData({ sessionId: 's2', data: LIMIT_TEXT })
    await advance(100)
    expect(h.sent.at(-1)?.payload.state).toBe('waiting') // 두 계정이 한 바퀴 막혔다 → 대기
    await advance(120_000) // planRetry 하한(60초) 경과
    expect(h.events.filter((e) => e.startsWith('spawn:'))).toEqual(['spawn:s2:c2', 'spawn:s3:c1'])
    h.coord.stop()
  })

  // 롤은 이제 복사본에 그대로 붙는다(재-locate 없음). 그 복사본은 **옛 계정의** rate_limits 를
  // 담고 있으므로, 붙자마자 그것을 읽으면 새 계정이 멀쩡한데도 즉시 다시 롤한다. 그 오판을 막는
  // 것은 이제 후보 제외가 아니라 tail 의 startAtEnd 다 — 이 테스트가 지키는 성질은 그대로다.
  it('롤 직후 붙은 복사본의 옛 rate_limits로 오판하지 않는다 (오탐 재롤 방지)', async () => {
    const h = harness({
      copy: async (src, dest) => {
        await fs.mkdir(path.dirname(dest), { recursive: true })
        await fs.copyFile(src, dest)
      }
    })
    await writeRollout({
      accountId: 'c1', uuid: 'cx-9', cwd: h.info1.cwd, primary: 95, reached: 'primary'
    })
    h.coord.register(h.info1)
    await advance(1_500) // 매핑
    await advance(15_000) // 틱 → 판정 ① → 롤 (c2 폴더에 복사본이 생긴다)
    expect(h.events).toContain('spawn:s2:c2')
    const sentBefore = h.sent.length

    await advance(15_000) // 다음 틱 — 복사본의 옛 스냅숏을 읽었다면 여기서 오판한다
    expect(h.events.filter((e) => e.startsWith('spawn:'))).toEqual(['spawn:s2:c2'])
    expect(h.sent.slice(sentBefore).filter((s) => s.payload.state === 'waiting')).toEqual([])
    h.coord.stop()
  })

  // 아래 재개 테스트들이 register 에 넘기는 세 번째 인자는 "파일을 쓴 계정으로 다시 열었다"는 배선의
  // 답이다(ipc 의 resumeSameAccount). 파일에 물어도 되는 조건이 그것뿐이므로, 여기서 true 를 빼면
  // 픽스처가 검사하려는 판정 자체가 실행되지 않는다 — 계정이 바뀐 재개는 아래 전용 테스트가 맡는다.
  //
  // 실측(2026-08-27): 히스토리에서 대화를 다시 열면 코디네이터는 그 rollout 파일 **끝**에 붙으므로
  // 자기 사용량 스냅숏이 없다. 그런데 rate_limits 는 턴 완료에 실려서만 나오고 한도에 걸린 세션은
  // 턴을 끝낼 수 없다 — 자기 한도를 믿게 해 줄 증거를 영원히 만들 수 없다는 뜻이다. 로그에는 같은
  // 대화를 세 번 다시 열 때마다 문구가 무시된 기록이 남았다. 그래서 파일이 이미 적고 있는 것이 유일한
  // 증거다(codexSignal 의 priorLimitVerdict).
  it('다시 열린 세션이 한도에 걸린 상태였으면 문구 없이도 대기한다 (실측 2026-08-27)', async () => {
    const blocks = new BlockRegistry()
    const logs: string[] = []
    const h = harness({ blocks, log: (m) => logs.push(m) })
    const single: SessionInfo = { ...h.info1, rollAccountIds: ['c1'] }
    const resetSec = Math.floor((Date.now() + 3_600_000) / 1000) // 1시간 뒤 — 아직 막혀 있다
    // 한도에 걸린 채 끝난 대화 = 소진된 창과 미래 리셋에 **구조 신호**까지 남아 있는 파일이다.
    // 사용률만으로는 "막힌 채 끝났다"를 알 수 없다(priorBlockAt 주석) — 거부된 턴의 기록이 있어야 한다
    const file = await writeRollout({
      accountId: 'c1', uuid: 'cx-prior-1', cwd: single.cwd, primary: 99, primaryReset: resetSec
    })
    await appendLimitError(file)
    h.coord.register({ ...single, resumeSessionId: 'cx-prior-1' }, file, true)
    await advance(100) // 파일에 물어본 답이 도착한다 — 도착 전에는 판정을 묻지 않는다
    await advance(15_000) // 첫 틱. 화면 문구는 한 번도 흘리지 않았다
    expect(h.sent.at(-1)?.payload.state).toBe('waiting')
    expect(h.sent.at(-1)?.payload.nextRetryAt).toBe(
      new Date(resetSec * 1000 + 60_000).toISOString() // 실측 리셋 + RETRY_MARGIN_MS
    )
    expect(logs.find((l) => l.includes('codex limit detected'))).toContain('reason=priorBlock')
    // Phase 1d: 같은 계정을 쓰는 다른 체인도 이 차단을 알아야 한다(SPEC §11.2/6)
    expect(blocks.get('c1', Date.now())).not.toBeNull()
    h.coord.stop()
  })

  // 같은 복구가 **다른 계정으로** 다시 열 때에는 재앙이 된다. 재개 화면은 같은 provider 의 로그인된
  // 계정을 모두 내놓고 다른 것을 고르는 것은 평범한 조작인데, 그러면 배선이 rollout 을 그 계정 폴더로
  // 복사하고 체인은 그 계정에서 시작한다 — 파일 안의 거부 기록은 **다른 계정의** 것이다. 그것을 믿으면
  // 멀쩡한 계정에 차단이 붙고, onLimit 이 그것을 공유 레지스트리로 방송해 다른 체인 전부가 리셋(주간이면
  // 며칠)까지 그 계정을 피한다. 두 계정 체인이라면 방금 띄운 멀쩡한 세션을 죽여 소진된 계정으로
  // 되돌리기까지 한다. 문구는 한 줄도 필요 없고, 이 브랜치 전에는 아무 일도 없던 재개다.
  it('다른 계정으로 다시 열면 파일의 차단을 복구하지 않는다 (멀쩡한 계정을 재우지 않는다)', async () => {
    const blocks = new BlockRegistry()
    const logs: string[] = []
    const h = harness({ blocks, log: (m) => logs.push(m) })
    // 사용자가 재개 계정으로 c2 를 골랐다 — 체인은 c2 에서 시작하고 파일은 c2 폴더에 복사돼 있다
    const cross: SessionInfo = { ...h.info1, accountId: 'c2', rollAccountIds: ['c2', 'c1'] }
    const resetSec = Math.floor((Date.now() + 3_600_000) / 1000)
    const file = await writeRollout({
      accountId: 'c2', uuid: 'cx-prior-cross', cwd: cross.cwd, primary: 99, primaryReset: resetSec
    })
    await appendLimitError(file) // 복사본이 담고 온 c1 의 거부 기록이다
    h.coord.register({ ...cross, resumeSessionId: 'cx-prior-cross' }, file, false) // 계정이 바뀌었다
    await advance(100) // 물어봤다면 답이 도착할 시간
    await advance(15_000)
    await advance(15_000)
    expect(h.sent.filter((s) => s.payload.state === 'waiting')).toEqual([]) // 대기하지 않는다
    expect(blocks.get('c2', Date.now())).toBeNull() // 공유 레지스트리에 아무것도 쓰지 않았다
    expect(h.events).toEqual([]) // 멀쩡한 세션을 죽여 소진된 계정으로 되돌리지도 않았다
    expect(logs.filter((l) => l.includes('codex limit detected'))).toEqual([])
    h.coord.stop()
  })

  // `codex resume` 은 지난 대화를 PTY 로 다시 그리므로 옛 한도 에러 줄이 화면에 흐른다. 파일이 적고
  // 있는 리셋이 이미 지났으면 그 줄은 재생이지 지금의 한도가 아니다 — 믿으면 멀쩡한 세션을 롤한다.
  // (이 규칙이 덮는 것은 첫 스냅숏 이전 구간뿐이다. 사용률이 찍힌 오탐은 state 가 이미 non-null 이라는
  //  뜻이므로 게이트 없는 기존 문구 경로에서 나온 것이고, 여기서 막히지 않는다.)
  it('다시 열린 세션의 리셋이 이미 지났으면 재생된 문구를 무시한다', async () => {
    const logs: string[] = []
    const h = harness({ log: (m) => logs.push(m) })
    const single: SessionInfo = { ...h.info1, rollAccountIds: ['c1'] }
    const resetSec = Math.floor((Date.now() - 3_600_000) / 1000) // 1시간 전에 이미 풀렸다
    const file = await writeRollout({
      accountId: 'c1', uuid: 'cx-prior-2', cwd: single.cwd, primary: 99, primaryReset: resetSec
    })
    await appendLimitError(file) // 그때는 정말 막혔다 — 지금은 풀렸다
    h.coord.register({ ...single, resumeSessionId: 'cx-prior-2' }, file, true)
    await advance(100)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT }) // 재개가 다시 그린 옛 줄
    await advance(100)
    expect(h.sent.filter((s) => s.payload.state === 'waiting')).toEqual([])
    expect(h.events).toEqual([])
    const ignored = (): string[] => logs.filter((l) => l.includes('limit-text ignored'))
    expect(ignored()).toHaveLength(1)
    expect(ignored()[0]).toContain('replay')
    // 문구 래치가 내려갔다 — 다음 틱이 같은 문구로 다시 발화하지 않는다
    await advance(15_000)
    expect(ignored()).toHaveLength(1)
    h.coord.stop()
  })

  // 이 갈래는 설계에서 가장 약한 증거다 — 스캐너는 재개 화면 전체를 읽으므로 에이전트 자신의 출력이나
  // 인용된 로그에 한도 모양의 문장이 있으면 여기까지 온다. 그래서 대기는 이 체인 안에서만 하고 공유
  // 레지스트리에는 아무것도 쓰지 않는다(judgedByPriorBlock): 방송하면 그 한 줄로 다른 체인 전부가 15분간
  // 그 계정을 피한다. 대기 간격은 그대로다 — planRetry 는 빈 슬롯을 now+폴백으로 읽는다.
  it('한도 기록이 없는 대화는 문구만으로 대기한다 (사용량 스냅숏 없이, 공유 기록 없이)', async () => {
    const blocks = new BlockRegistry()
    const h = harness({ blocks })
    const single: SessionInfo = { ...h.info1, rollAccountIds: ['c1'] }
    // rate_limits 가 한 줄도 없는 파일 — 이 대화는 여기서 한 번도 막힌 적이 없다. 그러면 다시 그릴
    // 옛 줄도 없으므로 확정 문구가 유일한 증거고, 리셋 시각은 모른다
    const file = await writeRollout({ accountId: 'c1', uuid: 'cx-prior-3', cwd: single.cwd })
    h.coord.register({ ...single, resumeSessionId: 'cx-prior-3' }, file, true)
    await advance(100)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    expect(h.sent.at(-1)?.payload.state).toBe('waiting')
    expect(h.sent.at(-1)?.payload.scope).toBe('session')
    expect(blocks.get('c1', Date.now())).toBeNull() // 문구 한 줄은 다른 체인의 계정 선택을 바꾸지 못한다
    // 리셋을 모르므로 planRetry 의 폴백 간격(15분)이 덮는다
    await advance(14 * 60_000)
    expect(h.written).toEqual([]) // 아직 기다린다
    await advanceIntoResume(70_000) // 15분 경과 → 제자리 재개
    expect(h.written.length).toBe(2)
    h.coord.stop()
  })

  // 복구된 리셋은 자기 스냅숏이 없는 동안에만 답한다. 턴이 하나라도 끝나면 rate_limits 가 붙고, 그
  // 뒤로는 파일이 담고 있던 옛 차단이 판정에 끼어들면 안 된다 — 멀쩡히 일하는 세션이 지나간 대화의
  // 리셋을 기다리게 된다.
  it('턴이 하나라도 끝난 뒤로는 기존 판정 그대로다 (회귀 방지)', async () => {
    const logs: string[] = []
    const h = harness({ log: (m) => logs.push(m) })
    const single: SessionInfo = { ...h.info1, rollAccountIds: ['c1'] }
    const resetSec = Math.floor((Date.now() + 3_600_000) / 1000) // 파일에는 미래의 차단이 적혀 있다
    const file = await writeRollout({
      accountId: 'c1', uuid: 'cx-prior-4', cwd: single.cwd, primary: 99, primaryReset: resetSec
    })
    await appendLimitError(file)
    h.coord.register({ ...single, resumeSessionId: 'cx-prior-4' }, file, true)
    await advance(100)
    await appendTokenCount(file, { primary: 20 }) // 재개된 세션이 턴을 끝냈다 — 한도가 아니다
    await advance(15_000) // 자기 스냅숏이 들어온 뒤의 틱
    await advance(15_000)
    expect(h.sent.filter((s) => s.payload.state === 'waiting')).toEqual([])
    expect(logs.filter((l) => l.includes('codex limit detected'))).toEqual([])
    // 스냅숏이 생긴 뒤로는 문구만으로는 더 이상 롤이 나지 않는다 (문구 단독 판정 폐지)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    expect(h.sent.filter((s) => s.payload.state === 'waiting')).toEqual([])
    // 그리고 판정은 예전 그대로다 — 구조화 신호가 오면 일반 경로가 발화한다(복구된 리셋이 아니다)
    await appendLimitError(file)
    await advance(15_000)
    expect(h.sent.at(-1)?.payload.state).toBe('waiting')
    expect(logs.find((l) => l.includes('codex limit detected'))).toContain('reason=errorInfo')
    h.coord.stop()
  })

  // **이 판정의 근거는 사용률이 될 수 없다.** worstResetAt 의 게이트는 100 이 아니라 90 이라서,
  // 마지막 스냅숏이 91% 인 대화 — 막힌 게 아니라 바쁘던 대화 — 도 리셋을 돌려준다. 그것을 믿으면 다시
  // 여는 순간 문구 한 줄 없이 세션이 세 시간 대기에 처박힌다. 이 파일의 다른 픽스처들이 95% 를
  // '막히지 않음'으로 다루는 것과 같은 이유다. 게이트를 100 으로 올리는 반대 방향도 틀리다(한도로
  // 요청이 거부되면 새 token_count 가 안 나와 사용률이 낮은 값에 멈춘다) — 그래서 구조 신호를 쓴다.
  it('바쁘게 일하다 닫힌 대화(91%)는 다시 열어도 대기하지 않는다 (사용률은 근거가 아니다)', async () => {
    const h = harness()
    const single: SessionInfo = { ...h.info1, rollAccountIds: ['c1'] }
    const resetSec = Math.floor((Date.now() + 3 * 3_600_000) / 1000) // 3시간 뒤
    // 게이트(90)는 넘지만 거부된 턴의 기록은 없다 — 그냥 많이 쓴 대화다
    const file = await writeRollout({
      accountId: 'c1', uuid: 'cx-prior-busy', cwd: single.cwd, primary: 91, primaryReset: resetSec
    })
    h.coord.register({ ...single, resumeSessionId: 'cx-prior-busy' }, file, true)
    await advance(100)
    await advance(15_000)
    await advance(15_000)
    expect(h.sent.filter((s) => s.payload.state === 'waiting')).toEqual([])
    expect(h.events).toEqual([])
    h.coord.stop()
  })

  // 같은 해악의 더 좁은 모양: 구조 기록이 파일 '어딘가에' 있는 것과 '거기서 끝난' 것은 다른 질문이다.
  // 오전에 한도에 걸렸다가 리셋을 기다려 풀린 뒤 다시 95% 까지 일한 대화 — 그 파일에는 옛 거부 기록이
  // 그대로 남아 있다. 그것을 차단으로 읽으면 다시 여는 순간 문구 한 줄 없이 창 길이만큼 대기에
  // 처박히고, 건강한 계정에 공유 차단까지 붙는다.
  it('막혔다가 회복한 뒤 닫힌 대화는 다시 열어도 대기하지 않는다 (옛 거부 기록)', async () => {
    const blocks = new BlockRegistry()
    const h = harness({ blocks })
    const single: SessionInfo = { ...h.info1, rollAccountIds: ['c1'] }
    const file = await writeRollout({
      accountId: 'c1', uuid: 'cx-prior-recovered', cwd: single.cwd,
      primary: 100, primaryReset: Math.floor((Date.now() - 3_600_000) / 1000) // 그때 막혔다
    })
    await appendLimitError(file)
    // 리셋이 지난 뒤 다시 일했다 — 턴이 완료됐다는 뜻이고, 창은 다시 게이트 위로 올라갔다
    await appendTokenCount(file, {
      primary: 95, primaryReset: Math.floor((Date.now() + 3 * 3_600_000) / 1000)
    })
    h.coord.register({ ...single, resumeSessionId: 'cx-prior-recovered' }, file, true)
    await advance(100)
    await advance(15_000)
    await advance(15_000)
    expect(h.sent.filter((s) => s.payload.state === 'waiting')).toEqual([])
    expect(h.events).toEqual([])
    expect(blocks.get('c1', Date.now())).toBeNull()
    h.coord.stop()
  })

  // attachRollout 은 세 곳에서 불리고 **파일에 물어도 되는 곳은 히스토리 재개 하나뿐**이다.
  // 아래 세 테스트가 나머지 둘을 못박는다.
  //
  // 첫째, 지우는 값이 무엇이어야 하는가. 전환 직후의 세션은 자기 스냅숏이 없고, 그 상태에서 재개
  // 화면이 옛 한도 줄을 다시 그린다. 복구값을 null("차단 기록 없음")로 지워 두면 그 값 자체가
  // "문구만으로 충분하다"는 입력이 되어(priorLimitVerdict 의 마지막 갈래), 방금 옮겨 온 멀쩡한 계정에
  // 15분 대기와 **공유 차단 기록**이 붙는다 — 그 기록은 다른 체인 전부가 존중한다. 그래서 지우는 값은
  // undefined 여야 한다: 판정 자체를 묻지 않는다.
  it('전환 직후의 문구 한 줄은 아무것도 바꾸지 않는다 (복구값은 undefined 로 지운다)', async () => {
    const blocks = new BlockRegistry()
    const h = harness({ blocks })
    const file = await writeRollout({ accountId: 'c1', uuid: 'cx-prior-afterroll', cwd: h.info1.cwd, primary: 95 })
    h.coord.register(h.info1) // 두 계정 체인
    await advance(1_500) // 매핑 폴링
    await appendLimitError(file)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    expect(h.events).toEqual(['copy', 'kill:s1', 'spawn:s2:c2'])
    const sentBefore = h.sent.length
    h.coord.handleData({ sessionId: 's2', data: LIMIT_TEXT }) // 재개 화면이 다시 그린 옛 줄
    await advance(100)
    await advance(15_000)
    expect(h.sent.slice(sentBefore).filter((s) => s.payload.state === 'waiting')).toEqual([])
    expect(h.events.filter((e) => e.startsWith('spawn:'))).toEqual(['spawn:s2:c2'])
    expect(blocks.get('c2', Date.now())).toBeNull() // 멀쩡한 새 계정에 차단이 붙지 않았다
    h.coord.stop()
  })

  // 둘째, 롤의 respawn 은 **복사본**에 붙고 그 복사본은 옛 계정의 한도 기록을 담고 있다 — tail 이 파일
  // 끝에서 시작하는 이유가 그것이다. 그 자리에서 파일에 물으면 방금 계정을 바꾼 세션이 첫 틱에 그대로
  // 대기로 빠진다.
  it('롤 직후 붙은 복사본의 옛 차단을 복구하지 않는다 (대기로 빠지지 않는다)', async () => {
    const h = harness({
      copy: async (src, dest) => {
        await fs.mkdir(path.dirname(dest), { recursive: true })
        await fs.copyFile(src, dest) // 복사본에 옛 계정의 기록이 그대로 들어간다
      }
    })
    const resetSec = Math.floor((Date.now() + 3_600_000) / 1000) // 옛 계정은 1시간 뒤에 풀린다
    const file = await writeRollout({
      accountId: 'c1', uuid: 'cx-prior-roll', cwd: h.info1.cwd, primary: 99, primaryReset: resetSec
    })
    h.coord.register(h.info1) // 두 계정 체인
    await advance(1_500) // 매핑 폴링
    await appendLimitError(file) // 옛 계정이 한도로 턴을 거부당했다 — 복사본이 담고 갈 기록이다
    await advance(15_000) // 틱 → 구조 에러로 판정 → c2 로 롤
    expect(h.events).toContain('spawn:s2:c2')
    const sentBefore = h.sent.length
    // 새 계정에서의 첫 두 틱 — healthy 타이머(60초)가 기록을 풀기 전이다
    await advance(15_000)
    await advance(15_000)
    expect(h.sent.slice(sentBefore).filter((s) => s.payload.state === 'waiting')).toEqual([])
    expect(h.events.filter((e) => e.startsWith('spawn:'))).toEqual(['spawn:s2:c2'])
    h.coord.stop()
  })

  // 셋째, 제자리 재개의 재부착. 그 대기를 만든 한도 기록이 바로 그 파일에 있으므로, 그 자리에서 파일에
  // 물으면 방금 리셋을 기다린 세션을 그 즉시 다시 한도로 판정한다 — 대기가 스스로를 재생한다.
  //
  // 픽스처: 막혀 있는 동안 다시 제출했다가 또 거부당한다. 그러면 새 plan 스냅숏(5시간 창의 resets_at
  // 은 시간이 가면 뒤로 밀린다)과 두 번째 구조 에러가 함께 붙어, 파일은 **이 대기가 끝난 뒤에도 미래인
  // 리셋으로 막힌 채 끝난** 모양이 된다. 거부 없이 스냅숏만 붙이면 그것은 '턴이 완료됐다'는 뜻이라
  // priorBlockAt 이 애초에 차단으로 읽지 않는다 — 그것이 이 픽스처가 이 모양이어야 하는 이유다.
  it('제자리 재개의 재부착이 그 파일의 차단을 복구하지 않는다 (대기 재생 방지)', async () => {
    const h = harness()
    const single: SessionInfo = { ...h.info1, rollAccountIds: ['c1'] }
    const t0 = Date.now()
    const file = await writeRollout({
      accountId: 'c1', uuid: 'cx-prior-inplace', cwd: single.cwd,
      primary: 99, primaryReset: Math.floor((t0 + 120_000) / 1000)
    })
    h.coord.register(single)
    await advance(1_500) // 매핑 폴링
    await appendLimitError(file)
    await advance(15_000) // 틱 → 구조 에러로 판정 → 대기(reset+60초)
    const waiting = (): number => h.sent.filter((s) => s.payload.state === 'waiting').length
    expect(waiting()).toBe(1)
    // 막힌 채로 다시 제출했다가 또 거부당한다 — 창이 밀려 리셋이 더 멀어진 스냅숏 + 두 번째 구조 에러
    await appendTokenCount(file, { primary: 99, primaryReset: Math.floor((t0 + 7_200_000) / 1000) })
    await appendLimitError(file)
    await advanceIntoResume(180_000) // 대기 만료 → 제자리 재개
    expect(h.written.length).toBe(2)
    await advance(15_000) // 재개 뒤 첫 틱 — 파일에 다시 물었다면 여기서 두 번째 대기가 게시된다
    expect(waiting()).toBe(1)
    h.coord.stop()
  })
})

// 롤이 중간에 포기하면 예전에는 'none' 을 게시하고 반환했다 — 아무것도 예약하지 않는다. 세션은
// 한도에 그대로 막혀 있고 그 한도는 신호로 이미 소비됐으므로 다시 감지될 일이 없어, 사람이
// 알아챌 때까지 워커가 유휴로 남는다. rolling.ts 의 같은 이름 describe 와 같은 성질이며, 단언의
// 핵심도 같은 셋이다: 'waiting' 이 게시된다, nextRetryAt 이 실려 있다, **그 시각에 실제로 다시
// 시도한다**. 세 번째가 요점이다 — 상태만 게시하고 타이머를 안 걸면 고치기 전과 똑같다.
//
// roll() 의 세 번째 중단(`rollout unmapped`)에는 테스트가 없다. onLimit 이 같은 조건을 먼저 막고
// roll() 로 오는 모든 경로가 그 뒤에 있어, 공개 표면으로는 그 분기에 닿을 수 없다.
describe('중단된 롤이 다음 시도를 예약한다', () => {
  /** 게시된 대기의 재시도 시각까지 이동한다. 반환값은 그 시각. */
  const jumpToRetry = async (h: {
    sent: { channel: string; payload: Record<string, unknown> }[]
  }): Promise<number> => {
    const at = Date.parse(String(h.sent.filter((s) => s.payload.state === 'waiting').at(-1)?.payload.nextRetryAt))
    await advance(at - Date.now() + 1_000)
    return at
  }
  const lastRetryAt = (h: { sent: { channel: string; payload: Record<string, unknown> }[] }): number =>
    Date.parse(String(h.sent.filter((s) => s.payload.state === 'waiting').at(-1)?.payload.nextRetryAt))

  it('계정이 사라져 롤을 포기하면 다시 시도할 시각을 잡는다 (영구 유휴 방지)', async () => {
    const h = harness({ getAccount: (id) => (id === 'c1' ? acc('c1', 'Codex A') : null) })
    const file = await writeRollout({
      accountId: 'c1', uuid: 'cx-gone', cwd: h.info1.cwd,
      primary: 95, primaryReset: Math.floor((Date.now() + 30 * 60_000) / 1000)
    })
    h.coord.register(h.info1)
    await advance(1_500) // 매핑 폴링
    await appendLimitError(file)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    expect(h.events).toEqual([]) // 롤 중단 — copy/kill/spawn 없음
    expect(h.sent.at(-1)?.payload.state).toBe('waiting') // 'none' 이 아니다
    expect(lastRetryAt(h)).toBeGreaterThan(Date.now())
    // (c) 그 시각에 실제로 다시 시도한다. 계정은 여전히 없으므로 또 포기하고 또 예약한다 —
    // 새 'waiting' 이 더 뒤의 시각으로 게시되는 것이 재시도가 돌았다는 증거다.
    const first = await jumpToRetry(h)
    expect(lastRetryAt(h)).toBeGreaterThan(first)
    h.coord.stop()
  })

  it('롤이 예외로 실패해도 다시 시도할 시각을 잡는다', async () => {
    const h = harness({ copy: () => Promise.reject(new Error('rollout copy blew up')) })
    const file = await writeRollout({
      accountId: 'c1', uuid: 'cx-copy-throw', cwd: h.info1.cwd,
      primary: 95, primaryReset: Math.floor((Date.now() + 30 * 60_000) / 1000)
    })
    h.coord.register(h.info1)
    await advance(1_500) // 매핑 폴링
    await appendLimitError(file)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    expect(h.events).toEqual([]) // 복사가 던졌으므로 kill·spawn 은 없다
    expect(h.sent.at(-1)?.payload.state).toBe('waiting')
    const first = await jumpToRetry(h)
    expect(lastRetryAt(h)).toBeGreaterThan(first)
    h.coord.stop()
  })
})
