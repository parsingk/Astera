import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeLimitProbe, type LimitProbeDeps } from './limitProbe'
import type { Dispatch } from '../../core/orchestration/types'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-limitprobe-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
})

const STARTED_AT = '2026-08-03T06:00:00.000Z'

const baseDispatch = (overrides: Partial<Dispatch> = {}): Dispatch => ({
  id: 'dsp_1',
  taskId: 'tsk_1',
  provider: 'claude',
  accountId: 'acc1',
  sessionId: 'sess1',
  cwd: 'D:/work/p',
  specPath: '',
  startedAt: STARTED_AT,
  workerState: 'ready',
  retained: false,
  ...overrides
})

function makeDeps(overrides: Partial<LimitProbeDeps> = {}): LimitProbeDeps & { logs: string[] } {
  const logs: string[] = []
  return {
    statusLinePayload: async () => null,
    configDirOf: () => null,
    log: (m: string): void => {
      logs.push(m)
    },
    logs,
    ...overrides
  }
}

// 소스에 통짜 트리거를 두지 않으려는 분할 (claudeSignal.test.ts·resetTime.test.ts와 같은 관례)
const HIT = "You've hit your "
const weeklyReset = (tail: string): string => HIT + 'weekly' + ` limit · resets ${tail} (Asia/Seoul)`

/** claudeSignal.test.ts의 mainHit과 같은 형태 — 메인 루프 한도 항목 */
const mainHit = (ts: string, text: string): string =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    error: 'rate_limit',
    timestamp: ts
  })

describe('makeLimitProbe — claude', () => {
  it('한도 항목 + 해제 문구가 있으면 그 시각을 돌려준다', async () => {
    const file = path.join(dir, 'transcript.jsonl')
    const hitAt = '2026-08-03T06:50:57.017Z'
    const text = weeklyReset('7pm')
    await fs.writeFile(file, mainHit(hitAt, text) + '\n', 'utf8')
    const deps = makeDeps({ statusLinePayload: async () => ({ transcript_path: file }) })
    const result = await makeLimitProbe(deps)(baseDispatch())
    // 리뷰 M7: parseResetTime(...)를 다시 불러 기대값을 만들면 parseResetTime 자체의 회귀를
    // 못 잡는다 — 하드코딩한다. 7pm(Asia/Seoul, UTC+9) = 10:00 UTC, hitAt(06:50:57Z)보다
    // 늦으므로 당일 그대로(day-roll 없음).
    expect(result).toBe(Date.parse('2026-08-03T10:00:00.000Z'))
  })

  it('d.startedAt 이전의 한도 항목은 무시한다 — 옛 항목만 있는 파일은 null', async () => {
    const file = path.join(dir, 'transcript.jsonl')
    const oldAt = '2026-08-03T05:00:00.000Z' // startedAt(06:00)보다 이전
    await fs.writeFile(file, mainHit(oldAt, weeklyReset('7pm')) + '\n', 'utf8')
    const deps = makeDeps({ statusLinePayload: async () => ({ transcript_path: file }) })
    const result = await makeLimitProbe(deps)(baseDispatch())
    expect(result).toBeNull()
    // 리뷰 I5: 이 null이 정상적인 since 필터링에서 온 것이지, 파일을 못 읽어 조용히 null이 된
    // 것이 아님을 확인한다 — 로그가 없어야 한다.
    expect(deps.logs).toHaveLength(0)
  })

  it('한도 항목이 여러 개면 가장 늦은 것을 쓴다', async () => {
    const file = path.join(dir, 'transcript.jsonl')
    const at1 = '2026-08-03T06:10:00.000Z'
    const at2 = '2026-08-03T06:50:00.000Z' // 더 늦음
    const text1 = weeklyReset('7pm')
    const text2 = weeklyReset('9pm')
    await fs.writeFile(file, [mainHit(at1, text1), mainHit(at2, text2)].join('\n') + '\n', 'utf8')
    const deps = makeDeps({ statusLinePayload: async () => ({ transcript_path: file }) })
    const result = await makeLimitProbe(deps)(baseDispatch())
    // 리뷰 M7: 하드코딩 — 9pm(Asia/Seoul) = 12:00 UTC, at2(06:50Z)보다 늦으므로 당일.
    // at1(06:10Z, 7pm=10:00Z)이 아니라 at2(더 늦은 히트)의 reset이 나와야 한다.
    expect(result).toBe(Date.parse('2026-08-03T12:00:00.000Z'))
  })

  it('transcriptPath가 없으면(statusLine 페이로드가 null) null + log 1회', async () => {
    const deps = makeDeps({ statusLinePayload: async () => null })
    const result = await makeLimitProbe(deps)(baseDispatch())
    expect(result).toBeNull()
    expect(deps.logs).toHaveLength(1)
  })

  it('문구에 해제 시각이 없으면 null (parseResetTime 실패 경로)', async () => {
    const file = path.join(dir, 'transcript.jsonl')
    const at = '2026-08-03T06:10:00.000Z'
    await fs.writeFile(file, mainHit(at, 'rate limit — no reset info in this text') + '\n', 'utf8')
    const deps = makeDeps({ statusLinePayload: async () => ({ transcript_path: file }) })
    const result = await makeLimitProbe(deps)(baseDispatch())
    expect(result).toBeNull()
    expect(deps.logs.length).toBeGreaterThanOrEqual(1)
  })
})

/** codexSignal.test.ts의 tokenCount와 같은 형태 — 실측 rollout 라인 */
function tokenCount(opts: {
  primary?: number
  secondary?: number
  primaryReset?: number
  secondaryReset?: number
  reached?: string | null
}): string {
  return JSON.stringify({
    timestamp: '2026-07-09T04:32:12.064Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { total_tokens: 100 } },
      // payload 바로 아래다 — payload.info 안이 아니다 (codexSignal.ts 의 rateLimitsOf 주석)
      rate_limits: {
        limit_id: 'codex',
        limit_name: null,
        primary:
          opts.primary === undefined
            ? null
            : { used_percent: opts.primary, window_minutes: 300, resets_at: opts.primaryReset ?? 1_999_999_999 },
        secondary:
          opts.secondary === undefined
            ? null
            : {
                used_percent: opts.secondary,
                window_minutes: 10080,
                resets_at: opts.secondaryReset ?? 1_999_999_999
              },
        credits: null,
        individual_limit: null,
        plan_type: 'plus',
        rate_limit_reached_type: opts.reached ?? null
      }
    }
  })
}

/** codexLocate.test.ts의 makeRollout과 같은 형태. limitProbe.ts는 findRollout에 now를 넘기지
 *  않으므로(브리프 원문 그대로) 실제 오늘 날짜 폴더에 쓴다 — findRollout도 같은 실제 시각을 본다. */
function todayDir(configDir: string): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return path.join(configDir, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()))
}

async function writeRollout(
  configDir: string,
  cwd: string,
  uuid: string,
  extraLines: string[]
): Promise<string> {
  const dirPath = todayDir(configDir)
  await fs.mkdir(dirPath, { recursive: true })
  const file = path.join(dirPath, `rollout-x-${uuid}.jsonl`)
  const meta = JSON.stringify({ type: 'session_meta', payload: { session_id: uuid, cwd } })
  await fs.writeFile(file, [meta, ...extraLines].join('\n') + '\n', 'utf8')
  return file
}

/** 한도로 끝난 턴의 task_complete (실측 형태). 메시지는 접합해 둔다 — 통짜면 이 파일이 롤링 세션
 *  화면으로 흐를 때 CodexLimitScanner 가 물어 실제 롤을 유발한다 (codexSignal.test.ts 와 같은 처방). */
const taskComplete = (timestamp: string): string =>
  JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      error: {
        message: "You've hit your " + 'usage limit. Upgrade to Pro or try again at 7:17 PM.',
        codex_error_info: 'usage_limit_exceeded'
      }
    }
  })

describe('makeLimitProbe — codex', () => {
  it('rate_limit_reached_type이 non-null이고 resets_at이 있으면 그 시각', async () => {
    const cwd = 'D:/work/codexp'
    const startedAt = new Date(Date.now() - 60_000).toISOString()
    await writeRollout(dir, cwd, 'uuid-1', [
      tokenCount({ primary: 95, primaryReset: 1_999_999_999, reached: 'primary' })
    ])
    const deps = makeDeps({ configDirOf: () => dir })
    const result = await makeLimitProbe(deps)(baseDispatch({ provider: 'codex', cwd, startedAt }))
    expect(result).toBe(1_999_999_999_000)
  })

  // 실측: reachedType 은 rollout 1288건 전부 null 이다. 한도가 났을 때 실제로 나오는 신호는
  // task_complete 의 codex_error_info 이며, 그때 창을 실은 기록은 그 직전 것이다.
  it('usage_limit_exceeded면 직전 창 스냅숏의 resets_at을 돌려준다', async () => {
    const cwd = 'D:/work/codexp-err'
    const startedAt = new Date(Date.now() - 60_000).toISOString()
    await writeRollout(dir, cwd, 'uuid-err', [
      tokenCount({ primary: 99, primaryReset: 1_999_999_999 }),
      tokenCount({}), // 한도 직후의 크레딧 기록 — 창이 전부 null
      taskComplete(new Date().toISOString())
    ])
    const deps = makeDeps({ configDirOf: () => dir })
    const result = await makeLimitProbe(deps)(baseDispatch({ provider: 'codex', cwd, startedAt }))
    expect(result).toBe(1_999_999_999_000)
  })

  // 재개된 대화의 rollout 에는 이전 턴들이 남긴 한도 에러가 그대로 들어 있다. 그것까지 이 Dispatch 의
  // 사망 원인으로 세면 멀쩡히 끝난 워커가 전부 '한도로 죽었다'가 된다 — claude 쪽 probe 가 hit.at 으로
  // 거르는 것과 같은 규칙이다.
  it('Dispatch 시작 이전의 한도 에러는 이 Dispatch의 것이 아니다', async () => {
    const cwd = 'D:/work/codexp-old'
    const startedAt = new Date(Date.now() - 60_000).toISOString()
    await writeRollout(dir, cwd, 'uuid-old', [
      tokenCount({ primary: 99, primaryReset: 1_999_999_999 }),
      taskComplete(new Date(Date.now() - 3_600_000).toISOString()) // 한 시간 전 턴의 에러
    ])
    const deps = makeDeps({ configDirOf: () => dir })
    const result = await makeLimitProbe(deps)(baseDispatch({ provider: 'codex', cwd, startedAt }))
    expect(result).toBeNull()
  })

  it('구조화 신호가 없으면 null — 사용률이 99%여도', async () => {
    const cwd = 'D:/work/codexp2'
    const startedAt = new Date(Date.now() - 60_000).toISOString()
    await writeRollout(dir, cwd, 'uuid-2', [tokenCount({ primary: 99, reached: null })])
    const deps = makeDeps({ configDirOf: () => dir })
    const result = await makeLimitProbe(deps)(baseDispatch({ provider: 'codex', cwd, startedAt }))
    expect(result).toBeNull()
    // 리뷰 I5: rollout을 정상적으로 읽었고 limitReached가 false를 낸 것이지, 읽기 실패로
    // 조용히 null이 된 것이 아니다 — 로그가 없어야 한다.
    expect(deps.logs).toHaveLength(0)
  })

  it('findRollout이 못 찾으면 null', async () => {
    const deps = makeDeps({ configDirOf: () => dir }) // dir엔 rollout이 하나도 없다
    const result = await makeLimitProbe(deps)(
      baseDispatch({ provider: 'codex', cwd: 'D:/work/nope' })
    )
    expect(result).toBeNull()
    // 리뷰 I5: 이 null이 "rollout 못 찾음"에서 온 것임을 로그 내용으로 확인한다.
    expect(deps.logs).toHaveLength(1)
    expect(deps.logs[0]).toContain('no rollout found')
  })

  it('configDirOf가 null이면 null + log 1회', async () => {
    const deps = makeDeps({ configDirOf: () => null })
    const result = await makeLimitProbe(deps)(baseDispatch({ provider: 'codex' }))
    expect(result).toBeNull()
    expect(deps.logs).toHaveLength(1)
  })
})

// tailLines는 limitProbe.ts 밖으로 내지 않는다(브리프 Step 2) — 공개 API(claude 경로)를 통해
// 간접 검증한다.
describe('tailLines (limitProbe.ts 내부 — 공개 API로 간접 검증)', () => {
  const CAP = 512 * 1024 // limitProbe.ts의 TAIL_CAP과 같은 값

  it('cap보다 큰 파일에서 앞이 잘린 첫 줄을 버린다', async () => {
    const file = path.join(dir, 'big.jsonl')
    const poisonAt = '2026-08-03T06:10:00.000Z'
    const poisonText = weeklyReset('7pm')
    const base = {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: poisonText }] },
      error: 'rate_limit',
      timestamp: poisonAt,
      _pad: ''
    }
    // poisonLine 길이를 정확히 CAP-1바이트로 맞춘다 — filler(5바이트)+'\n' 뒤에 이어지므로
    // tail 읽기 시작 offset(size-CAP)이 정확히 poisonLine의 첫 바이트와 일치하게 된다.
    const withoutPad = JSON.stringify(base)
    const targetLen = CAP - 1
    const pad = 'x'.repeat(Math.max(0, targetLen - withoutPad.length))
    const poisonLine = JSON.stringify({ ...base, _pad: pad })
    expect(poisonLine.length).toBe(targetLen)

    const filler = 'aaaaa' // 5바이트 — poisonLine 앞에 내용을 둬 start>0을 만든다
    await fs.writeFile(file, filler + '\n' + poisonLine + '\n', 'utf8')

    const deps = makeDeps({ statusLinePayload: async () => ({ transcript_path: file }) })
    const result = await makeLimitProbe(deps)(baseDispatch({ startedAt: '2026-08-03T00:00:00.000Z' }))
    // poisonLine은 그 자체로 완전하고 유효한 한도 항목이라 버려지지 않았다면 poisonText의 reset
    // 시각이 나왔을 것이다 — 그러나 cap 경계상 tail의 "첫 줄"로 읽히므로 무조건 버려진다.
    //
    // 리뷰 M2: 이름과 달리 이 poisonLine은 실제로 "중간이 잘린" 바이트열이 아니다 — 잘린 JSON은
    // 애초에 파싱에 성공할 수 없어(중간부터 시작하는 텍스트가 우연히도 유효한 JSON일 확률은
    // 사실상 0) 그 시나리오 자체를 결정적인 테스트로 구성할 수 없다. 대신 바이트 경계를 정확히
    // poisonLine의 첫 바이트와 일치하도록 맞춰, "완전하고 유효한 줄이라도 tail 읽기의 첫 줄이면
    // (start>0이라는 이유만으로) 무조건 버려진다"는 보수적 규칙을 검증한다 — 실제로 잘렸는지
    // 코드가 판별하지 않는다는 사실 자체가 이 테스트의 대상이다.
    expect(result).toBeNull()
  })

  it('cap보다 작은 파일은 첫 줄을 버리지 않는다', async () => {
    const file = path.join(dir, 'small.jsonl')
    const at = '2026-08-03T06:10:00.000Z'
    const text = weeklyReset('7pm')
    // 파일 전체가 이 한 줄뿐이다 — cap(512KB)보다 훨씬 작아 start===0이므로 이 유일한 항목도
    // 버려지면 안 된다.
    await fs.writeFile(file, mainHit(at, text) + '\n', 'utf8')
    const deps = makeDeps({ statusLinePayload: async () => ({ transcript_path: file }) })
    const result = await makeLimitProbe(deps)(baseDispatch({ startedAt: '2026-08-03T00:00:00.000Z' }))
    // 리뷰 M7: 하드코딩 — 7pm(Asia/Seoul) = 10:00 UTC, at(06:10Z)보다 늦으므로 당일.
    expect(result).toBe(Date.parse('2026-08-03T10:00:00.000Z'))
  })

  it('파일이 없으면 예외 없이 null을 낸다 (빈 tail) — 크래시가 아니라 내부에서 처리됐다는 것도 확인한다', async () => {
    const missing = path.join(dir, 'nope.jsonl')
    const deps = makeDeps({ statusLinePayload: async () => ({ transcript_path: missing }) })
    const result = await makeLimitProbe(deps)(baseDispatch())
    expect(result).toBeNull()
    // 리뷰 I5: tailLines의 try/catch·finally를 통째로 지워도(open()이 그냥 던지게 두면)
    // makeLimitProbe 안의 catch가 잡아 "limit probe threw ..."를 남기고 null을
    // 돌려주므로, result===null 단정만으로는 이 항목("파일이 없으면 [] — 던지지 않는다")이
    // 실제로 지켜지는지 구분하지 못한다. 로그 문구로 "tailLines 내부에서 처리됐다"(threw가
    // 아니다)는 것까지 확인한다.
    expect(deps.logs).toHaveLength(1)
    expect(deps.logs[0]).toContain('failed to read transcript tail')
    expect(deps.logs[0]).not.toContain('threw')
  })
})

describe('makeLimitProbe — 공통', () => {
  it('탐침 함수 자신은 절대 던지지 않는다 — 실패는 log로 남기고 null을 돌려준다', async () => {
    const deps = makeDeps({
      statusLinePayload: async () => {
        throw new Error('boom')
      }
    })
    await expect(makeLimitProbe(deps)(baseDispatch())).resolves.toBeNull()
    expect(deps.logs).toHaveLength(1)
  })
})
