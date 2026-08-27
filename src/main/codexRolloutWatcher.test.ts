import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CodexRolloutWatcher } from './codexRolloutWatcher'
import type { Account, SessionInfo } from '../core/types'

const TICK = 1_000

let dir: string
let now = 1_000_000

const account = (configDir: string): Account => ({
  id: 'acc1',
  label: 'codex1',
  configDir,
  color: '#000',
  createdAt: '2026-01-01T00:00:00.000Z',
  provider: 'codex'
})

const session = (id: string, cwd: string, slackNotify = true): SessionInfo =>
  ({ id, accountId: 'acc1', cwd, title: 't', status: 'running', slackNotify }) as SessionInfo

/** 실측한 token_count 레코드 (codex 0.149.1). info(토큰)와 rate_limits(한도)가 payload 의 서로 다른
 *  레벨에 있으므로 둘 다 실제 모양대로 담는다. */
const tokenCountLine = (opts: { last: number; window: number; primaryPct: number }): string =>
  JSON.stringify({
    timestamp: '2026-08-27T01:40:32.182Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { total_tokens: opts.last },
        last_token_usage: { total_tokens: opts.last },
        model_context_window: opts.window
      },
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: opts.primaryPct, window_minutes: 300, resets_at: 1_787_808_468 },
        secondary: { used_percent: 31, window_minutes: 10_080, resets_at: 1_788_326_258 },
        credits: { has_credits: false, unlimited: false, balance: '0' },
        rate_limit_reached_type: null
      }
    }
  }) + '\n'

/** <configDir>/sessions/<y>/<m>/<d>/rollout-<ts>-<uuid>.jsonl 하나를 만든다 */
async function makeRollout(configDir: string, uuid: string, sessionId: string, cwd: string): Promise<string> {
  const d = new Date(now)
  const y = String(d.getUTCFullYear())
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  const folder = path.join(configDir, 'sessions', y, m, day)
  await mkdir(folder, { recursive: true })
  const p = path.join(folder, `rollout-2026-08-02T00-00-00-${uuid}.jsonl`)
  await writeFile(
    p,
    JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd } }) + '\n'
  )
  return p
}

// 워쳐는 진짜 파일을 읽는다(findRollout·JsonlTail). fake timer가 걸린 동안에는 실제 fs I/O 완료
// 콜백이 돌지 않아, 타이머만 진행시키면 폴링이 파일을 못 본 채로 끝난다(codexRolling.test.ts와 같은
// 문제, 같은 해법). fake 타이머를 진행시킨 뒤 실제 타이머로 이벤트 루프에 시간을 줘서 I/O를 정착시킨다.
const realSetTimeout = setTimeout
const settleIo = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => realSetTimeout(r, 5))
}

/** 폴링·타이머를 진행시키고 대기 중인 Promise(실제 fs I/O 포함)를 소화한다 */
const advance = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
  await settleIo()
  await vi.advanceTimersByTimeAsync(0) // I/O 완료로 새로 예약된 타이머 실행
  await settleIo()
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'astera-codex-turn-'))
  vi.useFakeTimers()
})
afterEach(async () => {
  vi.useRealTimers()
  await rm(dir, { recursive: true, force: true })
})

describe('CodexRolloutWatcher', () => {
  it('task_complete를 만나면 콜백한다', async () => {
    const cwd = path.join(dir, 'proj')
    const p = await makeRollout(dir, '019f3f12-9c11-7cc1-9198-aeeaa6463dd2', 'sess-a', cwd)
    const onTurnComplete = vi.fn()
    const w = new CodexRolloutWatcher({
      getAccount: () => account(dir),
      onTurnComplete,
      log: () => {},
      now: () => now
    })
    w.register(session('live-1', cwd))

    await advance(TICK) // locate
    await appendFile(p, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n')
    await advance(TICK) // tail read

    expect(onTurnComplete).toHaveBeenCalledWith('live-1', p)
    w.stop()
  })

  it('같은 task_complete로 두 번 발화하지 않는다', async () => {
    const cwd = path.join(dir, 'proj')
    const p = await makeRollout(dir, '019f3f12-9c11-7cc1-9198-aeeaa6463dd2', 'sess-a', cwd)
    const onTurnComplete = vi.fn()
    const w = new CodexRolloutWatcher({ getAccount: () => account(dir), onTurnComplete, log: () => {}, now: () => now })
    w.register(session('live-1', cwd))
    await advance(TICK)
    await appendFile(p, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n')
    await advance(TICK)
    await advance(TICK) // 새 줄 없이 한 번 더
    expect(onTurnComplete).toHaveBeenCalledTimes(1)
    w.stop()
  })

  // `codex resume` 은 새 rollout 을 만들지 않고 기존 파일에 이어 쓴다(codexRolling 의 attachRollout
  // 주석에 실측 근거). 그래서 '생성 시각이 spawn 이후'로 후보를 거르는 findRollout 은 재개 세션의
  // rollout 을 영원히 못 찾고 — 히스토리 재개도, 롤 직후 재등록도 — 턴 알림이 조용히 죽는다.
  // 배선이 아는 경로를 넘겨 붙이면 탐색이 필요 없다. 다만 그 파일에는 이미 끝난 턴이 들어 있으므로
  // 붙은 시점 이후에 쓰인 것만 알려야 한다(예전에 excludePaths 가 막으려던 바로 그 오발이다).
  it('넘겨받은 rollout 경로에 바로 붙고, 붙기 전 턴으로는 오발하지 않는다', async () => {
    const cwd = path.join(dir, 'proj')
    const p = await makeRollout(dir, '019f3f12-9c11-7cc1-9198-aeeaa6463dd2', 'sess-a', cwd)
    const turn = JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })
    await appendFile(p, turn + '\n') // 재개 전에 이미 끝나 있던 턴
    const onTurnComplete = vi.fn()
    const w = new CodexRolloutWatcher({
      getAccount: () => account(dir),
      onTurnComplete,
      log: () => {},
      now: () => now
    })
    w.register(session('live-1', cwd), p)
    // 한 번에 2틱을 흘리면 그 사이 fs I/O 가 정착하지 않아 매핑만 두 번 돌고 읽기가 없다 —
    // 오발할 기회를 실제로 주려면 틱마다 나눠 흘려야 한다
    await advance(TICK) // 매핑
    await advance(TICK) // 읽기
    expect(onTurnComplete).not.toHaveBeenCalled()
    await appendFile(p, turn + '\n') // 재개된 세션이 끝낸 턴
    await advance(TICK)
    expect(onTurnComplete).toHaveBeenCalledWith('live-1', p)
    w.stop()
  })

  // 위 테스트만으로는 '탐색해서 찾았을 뿐'인 경우와 구분되지 않는다. 탐색이 절대 닿지 않는 자리에
  // 파일을 두면, 알림이 온다는 것 자체가 직접 붙었다는 증거다.
  it('탐색으로는 닿지 않는 경로도 넘겨받으면 붙는다', async () => {
    const cwd = path.join(dir, 'proj')
    const outside = path.join(dir, 'elsewhere', 'rollout-x.jsonl') // sessions/ 트리 밖
    await mkdir(path.dirname(outside), { recursive: true })
    await writeFile(outside, '')
    const onTurnComplete = vi.fn()
    const w = new CodexRolloutWatcher({
      getAccount: () => account(dir),
      onTurnComplete,
      log: () => {},
      now: () => now
    })
    w.register(session('live-1', cwd), outside)
    await advance(TICK)
    await appendFile(outside, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n')
    await advance(TICK)
    expect(onTurnComplete).toHaveBeenCalledWith('live-1', outside)
    w.stop()
  })

  it('같은 계정·같은 cwd의 두 세션이 서로 다른 rollout을 문다 (선점 방지)', async () => {
    const cwd = path.join(dir, 'proj')
    const a = await makeRollout(dir, '019f3f12-9c11-7cc1-9198-aeeaa6463dd2', 'sess-a', cwd)
    const b = await makeRollout(dir, '019f3f12-9c11-7cc1-9198-aeeaa6463dd3', 'sess-b', cwd)
    const seen: string[] = []
    const w = new CodexRolloutWatcher({
      getAccount: () => account(dir),
      onTurnComplete: (_id, p) => seen.push(p),
      log: () => {},
      now: () => now
    })
    w.register(session('live-1', cwd))
    w.register(session('live-2', cwd))
    await advance(TICK)
    for (const p of [a, b])
      await appendFile(p, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n')
    await advance(TICK)
    expect(new Set(seen).size).toBe(2) // 두 세션이 같은 파일을 물지 않았다
    w.stop()
  })

  it('unregister 후에는 콜백하지 않는다', async () => {
    const cwd = path.join(dir, 'proj')
    const p = await makeRollout(dir, '019f3f12-9c11-7cc1-9198-aeeaa6463dd2', 'sess-a', cwd)
    const onTurnComplete = vi.fn()
    const w = new CodexRolloutWatcher({ getAccount: () => account(dir), onTurnComplete, log: () => {}, now: () => now })
    w.register(session('live-1', cwd))
    await advance(TICK)
    w.unregister('live-1')
    await appendFile(p, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n')
    await advance(TICK)
    expect(onTurnComplete).not.toHaveBeenCalled()
    w.stop()
  })

  it('계정이 없으면 등록하지 않는다 (크래시 금지)', async () => {
    const onTurnComplete = vi.fn()
    const w = new CodexRolloutWatcher({ getAccount: () => null, onTurnComplete, log: () => {}, now: () => now })
    w.register(session('live-1', path.join(dir, 'proj')))
    await advance(TICK * 3)
    expect(onTurnComplete).not.toHaveBeenCalled()
    w.stop()
  })

  it('stop()이 타이머를 정리해 이후 콜백이 없다', async () => {
    const cwd = path.join(dir, 'proj')
    const p = await makeRollout(dir, '019f3f12-9c11-7cc1-9198-aeeaa6463dd2', 'sess-a', cwd)
    const onTurnComplete = vi.fn()
    const w = new CodexRolloutWatcher({ getAccount: () => account(dir), onTurnComplete, log: () => {}, now: () => now })
    w.register(session('live-1', cwd))
    await advance(TICK)
    w.stop()
    await appendFile(p, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n')
    await advance(TICK * 3)
    expect(onTurnComplete).not.toHaveBeenCalled()
  })

  // ── 사용량 (하단 바의 Context·5시간·주간) ──────────────────────────────────────
  // 알림이 아니라 화면을 먹이는 쪽이므로, Slack 여부와 무관하게 모든 codex 세션이 대상이다.
  it('Slack 을 끈 세션도 사용량을 낸다', async () => {
    const cwd = path.join(dir, 'proj')
    const p = await makeRollout(dir, '019f3f12-9c11-7cc1-9198-aeeaa6463dd2', 'sess-a', cwd)
    await appendFile(p, tokenCountLine({ last: 20_924, window: 258_400, primaryPct: 12 }))
    const w = new CodexRolloutWatcher({
      getAccount: () => account(dir),
      onTurnComplete: () => {},
      log: () => {},
      now: () => now
    })
    w.register(session('live-1', cwd, false))
    await advance(TICK) // 매핑
    await advance(TICK) // 읽기
    expect(w.usage('live-1')).toEqual({
      context: { usedPercent: 4, usedTokens: 20_924, windowSize: 258_400 },
      session: { usedPercent: 12, resetsAt: '2026-08-27T05:27:48.000Z' },
      weekly: { usedPercent: 31, resetsAt: '2026-09-02T05:17:38.000Z' }
    })
    w.stop()
  })

  // 등록 조건을 넓힌 대가로, 알림 쪽 게이트는 반드시 남아 있어야 한다
  it('Slack 을 끈 세션의 턴 완료는 알리지 않는다', async () => {
    const cwd = path.join(dir, 'proj')
    const p = await makeRollout(dir, '019f3f12-9c11-7cc1-9198-aeeaa6463dd2', 'sess-a', cwd)
    const onTurnComplete = vi.fn()
    const w = new CodexRolloutWatcher({
      getAccount: () => account(dir),
      onTurnComplete,
      log: () => {},
      now: () => now
    })
    w.register(session('live-1', cwd, false))
    await advance(TICK)
    await appendFile(p, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n')
    await advance(TICK)
    expect(onTurnComplete).not.toHaveBeenCalled()
    w.stop()
  })

  // 계정 롤링 후에는 이전 계정이 쓴 한도 스냅샷이 그 파일에 남아 있다. 그것을 그리면 새 계정의
  // 사용량을 거짓으로 표시한다 — 새 token_count 가 올 때까지 비어 있어야 한다.
  it('넘겨받은 rollout 의 이전 계정 한도는 표시하지 않는다', async () => {
    const cwd = path.join(dir, 'proj')
    const p = await makeRollout(dir, '019f3f12-9c11-7cc1-9198-aeeaa6463dd2', 'sess-a', cwd)
    await appendFile(p, tokenCountLine({ last: 50_000, window: 258_400, primaryPct: 98 }))
    const w = new CodexRolloutWatcher({
      getAccount: () => account(dir),
      onTurnComplete: () => {},
      log: () => {},
      now: () => now
    })
    w.register(session('live-1', cwd), p)
    await advance(TICK)
    await advance(TICK)
    expect(w.usage('live-1')?.session).toBeNull()
    expect(w.usage('live-1')?.weekly).toBeNull()
    w.stop()
  })

  // 한도와 달리 컨텍스트는 재개·롤 뒤에도 여전히 참이다 — 대화 내용이 그대로이기 때문이다.
  // 첫 턴이 끝날 때까지 Context 칩을 비워두지 않으려면 기존 기록에서 시드해야 한다.
  it('넘겨받은 rollout 에서 컨텍스트는 시드한다', async () => {
    const cwd = path.join(dir, 'proj')
    const p = await makeRollout(dir, '019f3f12-9c11-7cc1-9198-aeeaa6463dd2', 'sess-a', cwd)
    await appendFile(p, tokenCountLine({ last: 50_000, window: 258_400, primaryPct: 98 }))
    const w = new CodexRolloutWatcher({
      getAccount: () => account(dir),
      onTurnComplete: () => {},
      log: () => {},
      now: () => now
    })
    w.register(session('live-1', cwd), p)
    await advance(TICK)
    await advance(TICK)
    expect(w.usage('live-1')?.context).toEqual({
      usedPercent: 15,
      usedTokens: 50_000,
      windowSize: 258_400
    })
    w.stop()
  })

  it('붙은 뒤 새 token_count 가 오면 한도가 채워진다', async () => {
    const cwd = path.join(dir, 'proj')
    const p = await makeRollout(dir, '019f3f12-9c11-7cc1-9198-aeeaa6463dd2', 'sess-a', cwd)
    await appendFile(p, tokenCountLine({ last: 50_000, window: 258_400, primaryPct: 98 }))
    const w = new CodexRolloutWatcher({
      getAccount: () => account(dir),
      onTurnComplete: () => {},
      log: () => {},
      now: () => now
    })
    w.register(session('live-1', cwd), p)
    await advance(TICK)
    await advance(TICK)
    await appendFile(p, tokenCountLine({ last: 20_924, window: 258_400, primaryPct: 7 }))
    await advance(TICK)
    expect(w.usage('live-1')?.session?.usedPercent).toBe(7)
    expect(w.usage('live-1')?.context?.usedPercent).toBe(4)
    w.stop()
  })

  it('등록되지 않은 세션의 사용량은 null', () => {
    const w = new CodexRolloutWatcher({
      getAccount: () => account(dir),
      onTurnComplete: () => {},
      log: () => {},
      now: () => now
    })
    expect(w.usage('nope')).toBeNull()
    w.stop()
  })

  it('unregister 후 사용량은 null', async () => {
    const cwd = path.join(dir, 'proj')
    const p = await makeRollout(dir, '019f3f12-9c11-7cc1-9198-aeeaa6463dd2', 'sess-a', cwd)
    await appendFile(p, tokenCountLine({ last: 20_924, window: 258_400, primaryPct: 12 }))
    const w = new CodexRolloutWatcher({
      getAccount: () => account(dir),
      onTurnComplete: () => {},
      log: () => {},
      now: () => now
    })
    w.register(session('live-1', cwd))
    await advance(TICK)
    await advance(TICK)
    expect(w.usage('live-1')).not.toBeNull()
    w.unregister('live-1')
    expect(w.usage('live-1')).toBeNull()
    w.stop()
  })
})
