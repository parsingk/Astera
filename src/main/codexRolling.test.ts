import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHook } from 'node:async_hooks'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Account, SessionInfo } from '../core/types'
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
  if (opts.primary !== undefined || opts.reached !== undefined) {
    lines.push(
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            rate_limits: {
              primary: { used_percent: opts.primary ?? 0, window_minutes: 300, resets_at: opts.primaryReset ?? 0 },
              secondary: { used_percent: opts.secondary ?? 0, window_minutes: 10080, resets_at: 0 },
              rate_limit_reached_type: opts.reached ?? null
            }
          }
        }
      })
    )
  }
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
    orchEnv?: { cliPath: string; infoPath: string; skillsPath: string }
  }[]
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
    orchEnv?: { cliPath: string; infoPath: string; skillsPath: string }
  }[] = []
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
        orchEnv: opts.orchEnv
      })
      events.push(`spawn:${info.id}:${opts.account.id}`)
      return info
    },
    kill: (id) => events.push(`kill:${id}`),
    getAccount: (id) => accounts[id] ?? null,
    send: (channel, p) => sent.push({ channel, payload: p as Record<string, unknown> }),
    log: () => {},
    lang: () => 'ko', // 기존 한국어 기대값을 유지
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
  ioProbes.push(() => events.length + sent.length + copied.length + spawned.length)
  return { coord, events, sent, copied, spawned, info1 }
}

// codex 0.146.0에서 관찰한 한도 문구.
// 접합으로 쪼갠다 — 통짜면 이 파일이 롤링 세션의 화면으로 흐를 때 CodexLimitScanner가 물어
// 실제 롤을 유발한다. 런타임 값은 같다.
const LIMIT_TEXT = "You’ve hit your " + 'usage limit. Upgrade to Plus to continue'

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
    await writeRollout({ accountId: 'c1', uuid: 'cx-hook', cwd: h.info1.cwd, primary: 95 })
    h.coord.register(h.info1)
    await advance(1_500) // 매핑 폴링
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
    await writeRollout({ accountId: 'c1', uuid: 'cx-throw', cwd: h.info1.cwd, primary: 95 })
    h.coord.register(h.info1)
    await advance(1_500) // 매핑 폴링
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    expect(h.events).toEqual(['copy', 'kill:s1', 'spawn:s2:c2'])
    expect(h.spawned[0].resumePrompt).toBe('이어서 작업 진행해 줘')
    h.coord.stop()
  })

  it('롤로 띄운 세션에 orchEnv를 실어 보낸다', async () => {
    const env = { cliPath: 'C:/astera/cli.js', infoPath: 'C:/astera/info.json', skillsPath: 'C:/astera/skills' }
    const h = harness({ orchEnv: () => env })
    await writeRollout({ accountId: 'c1', uuid: 'cx-orchenv', cwd: h.info1.cwd, primary: 95 })
    h.coord.register(h.info1)
    await advance(1_500) // 매핑 폴링
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    expect(h.spawned[0].orchEnv).toEqual(env)
    h.coord.stop()
  })

  it('orchEnv dep이 주입되지 않으면 실리지 않는다', async () => {
    const h = harness() // 주입 없음
    await writeRollout({ accountId: 'c1', uuid: 'cx-noorchenv', cwd: h.info1.cwd, primary: 95 })
    h.coord.register(h.info1)
    await advance(1_500) // 매핑 폴링
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    expect(h.spawned[0].orchEnv).toBeUndefined()
    h.coord.stop()
  })

  it('롤 respawn 시 slackNotify를 그대로 전달한다', async () => {
    const h = harness()
    await writeRollout({ accountId: 'c1', uuid: 'cx-slack', cwd: h.info1.cwd, primary: 95 })
    h.coord.register({ ...h.info1, slackNotify: true })
    await advance(1_500) // 매핑 폴링
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

  // 예전에는 사용률 <90%면 문구를 무시했다. rate_limits는 턴이 완료돼야 갱신되므로
  // 한도로 요청이 거부된 순간에는 사용률이 낮은 값에 멈춰 있고, 그 게이트가 정당한 롤을 막았다.
  it('사용률 스냅샷이 낮아도 확정 한도 문구면 롤한다 (게이트 제거)', async () => {
    const h = harness()
    await writeRollout({ accountId: 'c1', uuid: 'cx-3', cwd: h.info1.cwd, primary: 42, secondary: 7 })
    h.coord.register(h.info1)
    await advance(1_500)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    expect(h.events).toEqual(['copy', 'kill:s1', 'spawn:s2:c2'])
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

  // 워커의 구성이 바로 이것이다 — 한 원소 체인. orchEnv 단언이 여기 붙어 있는 이유: 위의 orchEnv
  // 테스트 둘은 계정을 갈아타는 여러 원소 체인을 지나가고, 워커가 실제로 타는 경로는 이쪽이다.
  it('단일 계정은 전환 없이 reset 시각까지 대기 후 같은 계정으로 재개한다', async () => {
    const env = { cliPath: 'C:/astera/cli.js', infoPath: 'C:/astera/info.json', skillsPath: 'C:/astera/skills' }
    const h = harness({ orchEnv: () => env })
    const single: SessionInfo = { ...h.info1, rollAccountIds: ['c1'] }
    const resetSec = Math.floor((Date.now() + 300_000) / 1000) // 5분 뒤
    await writeRollout({
      accountId: 'c1', uuid: 'cx-4', cwd: single.cwd, primary: 99, primaryReset: resetSec
    })
    h.coord.register(single)
    await advance(1_500)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await advance(100)
    expect(h.sent.at(-1)?.payload.state).toBe('waiting')
    expect(h.events).toEqual([]) // 아직 롤 안 함
    await advance(400_000) // reset + 여유 경과
    expect(h.events).toContain('spawn:s2:c1') // 같은 계정으로 재개
    expect(h.spawned[0].orchEnv).toEqual(env) // 그 세션에서 astera 로 보고할 수 있어야 한다
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
    await writeRollout({ accountId: 'c1', uuid: 'cx-8', cwd: h.info1.cwd, primary: 95 })
    h.coord.register(h.info1)
    await advance(1_500)
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
    await writeRollout({ accountId: 'c1', uuid: 'cx-10', cwd: h.info1.cwd, primary: 95 })
    h.coord.register(h.info1)
    h.coord.register({ ...h.info1, id: 's10' }) // 같은 폴더에서 띄운 두 번째 롤링 탭
    await advance(1_500) // 두 체인이 같은 rollout을 두고 경쟁한다
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    h.coord.handleData({ sessionId: 's10', data: LIMIT_TEXT })
    await advance(100)
    expect(h.events.filter((e) => e.startsWith('spawn:'))).toHaveLength(1)
    h.coord.stop()
  })

  // 리뷰 지적: PTY 청크는 임의 위치에서 잘린다 (detect.ts OutputScanner와 같은 이유)
  it('한도 문구가 두 청크로 쪼개져 와도 감지한다 (청크 경계)', async () => {
    const h = harness()
    await writeRollout({ accountId: 'c1', uuid: 'cx-11', cwd: h.info1.cwd, primary: 95 })
    h.coord.register(h.info1)
    await advance(1_500)
    h.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT.slice(0, 12) })
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

  it('롤 이후 재-locate는 방금 복사한 옛 rollout을 물지 않는다 (오탐 재롤 방지)', async () => {
    const h = harness({
      copy: async (src, dest) => {
        await fs.mkdir(path.dirname(dest), { recursive: true })
        await fs.copyFile(src, dest)
        // 실제로는 copy 직후(kill+spawn 몇 ms 뒤)에 재-locate가 돌아 복사본의 생성 시각≈since다 —
        // 시각 비교로 우연히 걸러지지 않도록 최악 조건을 만든다
        const t = (Date.now() + 1_000) / 1000
        await fs.utimes(dest, t, t)
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

    await advance(2_000) // 재-locate 폴링
    await advance(15_000) // 다음 틱 — 복사본을 물었다면 여기서 옛 계정 데이터로 오판한다
    expect(h.events.filter((e) => e.startsWith('spawn:'))).toEqual(['spawn:s2:c2'])
    expect(h.sent.slice(sentBefore).filter((s) => s.payload.state === 'waiting')).toEqual([])
    h.coord.stop()
  })
})
