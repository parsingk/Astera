import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CodexTurnWatcher } from './codexTurnWatcher'
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

const session = (id: string, cwd: string): SessionInfo =>
  ({ id, accountId: 'acc1', cwd, title: 't', status: 'running', slackNotify: true }) as SessionInfo

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

describe('CodexTurnWatcher', () => {
  it('task_complete를 만나면 콜백한다', async () => {
    const cwd = path.join(dir, 'proj')
    const p = await makeRollout(dir, '019f3f12-9c11-7cc1-9198-aeeaa6463dd2', 'sess-a', cwd)
    const onTurnComplete = vi.fn()
    const w = new CodexTurnWatcher({
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
    const w = new CodexTurnWatcher({ getAccount: () => account(dir), onTurnComplete, log: () => {}, now: () => now })
    w.register(session('live-1', cwd))
    await advance(TICK)
    await appendFile(p, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n')
    await advance(TICK)
    await advance(TICK) // 새 줄 없이 한 번 더
    expect(onTurnComplete).toHaveBeenCalledTimes(1)
    w.stop()
  })

  it('register의 excludePaths로 넘긴 rollout은 후보에서 빠진다', async () => {
    const cwd = path.join(dir, 'proj')
    const p = await makeRollout(dir, '019f3f12-9c11-7cc1-9198-aeeaa6463dd2', 'sess-a', cwd)
    await appendFile(p, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n')
    const onTurnComplete = vi.fn()
    const w = new CodexTurnWatcher({
      getAccount: () => account(dir),
      onTurnComplete,
      log: () => {},
      now: () => now
    })
    // 롤 직후 재등록 시나리오를 흉내낸다 — 유일한 후보(p)가 복사된 옛 rollout이라 제외 대상이면
    // 워쳐는 매핑할 게 없어 콜백도 없다 (excludePaths 없이 등록했다면 p를 물어 오발했을 것).
    w.register(session('live-1', cwd), [p])
    await advance(TICK * 3)
    expect(onTurnComplete).not.toHaveBeenCalled()
    w.stop()
  })

  it('같은 계정·같은 cwd의 두 세션이 서로 다른 rollout을 문다 (선점 방지)', async () => {
    const cwd = path.join(dir, 'proj')
    const a = await makeRollout(dir, '019f3f12-9c11-7cc1-9198-aeeaa6463dd2', 'sess-a', cwd)
    const b = await makeRollout(dir, '019f3f12-9c11-7cc1-9198-aeeaa6463dd3', 'sess-b', cwd)
    const seen: string[] = []
    const w = new CodexTurnWatcher({
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
    const w = new CodexTurnWatcher({ getAccount: () => account(dir), onTurnComplete, log: () => {}, now: () => now })
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
    const w = new CodexTurnWatcher({ getAccount: () => null, onTurnComplete, log: () => {}, now: () => now })
    w.register(session('live-1', path.join(dir, 'proj')))
    await advance(TICK * 3)
    expect(onTurnComplete).not.toHaveBeenCalled()
    w.stop()
  })

  it('stop()이 타이머를 정리해 이후 콜백이 없다', async () => {
    const cwd = path.join(dir, 'proj')
    const p = await makeRollout(dir, '019f3f12-9c11-7cc1-9198-aeeaa6463dd2', 'sess-a', cwd)
    const onTurnComplete = vi.fn()
    const w = new CodexTurnWatcher({ getAccount: () => account(dir), onTurnComplete, log: () => {}, now: () => now })
    w.register(session('live-1', cwd))
    await advance(TICK)
    w.stop()
    await appendFile(p, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n')
    await advance(TICK * 3)
    expect(onTurnComplete).not.toHaveBeenCalled()
  })
})
