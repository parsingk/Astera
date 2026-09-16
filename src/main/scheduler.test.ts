import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { SessionInfo, ScheduleConfig } from '../core/types'
import { SchedulerCoordinator, type SchedulerDeps } from './scheduler'

function harness(overrides: Partial<SchedulerDeps> = {}): {
  coord: SchedulerCoordinator
  delivered: { id: string; text: string }[]
  rejectNext: { count: number } // how many upcoming deliver calls reject
  sent: { channel: string; payload: Record<string, unknown> }[]
  persisted: { key: string; config: unknown }[]
  deleted: string[]
  payloads: Map<string, unknown>
  statusCalls: string[] // readStatusPayload 호출 인자 기록 — codex 게이팅 검증용
  threadIds: Map<string, string>
} {
  const delivered: { id: string; text: string }[] = []
  const rejectNext = { count: 0 }
  const sent: { channel: string; payload: Record<string, unknown> }[] = []
  const persisted: { key: string; config: unknown }[] = []
  const deleted: string[] = []
  const payloads = new Map<string, unknown>()
  const statusCalls: string[] = []
  const threadIds = new Map<string, string>()
  const coord = new SchedulerCoordinator({
    deliver: async (id, text) => {
      if (rejectNext.count > 0) {
        rejectNext.count -= 1
        throw new Error('refused')
      }
      delivered.push({ id, text })
    },
    readStatusPayload: (id) => {
      statusCalls.push(id)
      return Promise.resolve(payloads.get(id) ?? null)
    },
    send: (channel, p) => sent.push({ channel, payload: p as Record<string, unknown> }),
    log: () => {},
    persistConfig: (key, config) => persisted.push({ key, config }),
    deleteConfig: (key) => deleted.push(key),
    chatThreadId: (id) => threadIds.get(id) ?? null,
    ...overrides
  } satisfies SchedulerDeps)
  return { coord, delivered, rejectNext, sent, persisted, deleted, payloads, statusCalls, threadIds }
}

const info = (id: string, schedule?: ScheduleConfig): SessionInfo => ({
  id,
  accountId: 'a1',
  cwd: 'D:\\work\\p',
  status: 'running',
  title: 'p',
  schedule
})

const everyMin = (command = 'c'): ScheduleConfig => ({
  rule: { kind: 'interval', minutes: 1 },
  command
})

const chatInfo = (id: string, schedule?: ScheduleConfig, threadId?: string): SessionInfo => ({
  ...info(id, schedule), kind: 'chat', ...(threadId ? { threadId, resumeSessionId: threadId } : {})
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 6, 31, 10, 0, 0)) // 2026-07-31(금) 10:00 로컬
})
afterEach(() => {
  vi.useRealTimers()
})

describe('SchedulerCoordinator', () => {
  it('interval rule: after N minutes the tick delivers the command once', async () => {
    const h = harness()
    h.coord.register(info('s1', everyMin('상태 점검')))
    await vi.advanceTimersByTimeAsync(60_000 + 15_000) // one minute on, plus the tick that sees it
    expect(h.delivered.map((d) => d.text)).toEqual(['상태 점검'])
    expect(h.delivered.every((d) => d.id === 's1')).toBe(true)
  })

  it('a session without a schedule is not registered', async () => {
    const h = harness()
    h.coord.register(info('s1'))
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(h.delivered).toEqual([])
    expect(h.sent).toEqual([])
  })

  it('busy holds the round; idle sends once (overlapping rounds merge)', async () => {
    const h = harness()
    h.coord.register(info('s1', everyMin()))
    h.coord.handleBusy('s1', true)
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 15_000) // 3회차 경과 — pending 1개로 합쳐짐
    expect(h.delivered).toEqual([])
    h.coord.handleBusy('s1', false)
    await vi.advanceTimersByTimeAsync(200)
    expect(h.delivered.map((d) => d.text)).toEqual(['c'])
  })

  it('even without busy, a clock jump across several rounds recomputes and fires once (a missed round is ignored)', async () => {
    // deps.now를 직접 제어해 "시스템 sleep 후 재개"처럼 10회차 분(10분)을 한 번에 건너뛴다.
    // tick 폴링(15초)은 정상 진행하되, 그 한 번의 tick이 관측하는 now()만 크게 앞서 있는 상황 —
    // busy 병합(pending boolean)과 별개로, nextAt 재계산 자체가 밀린 횟수를 쌓지 않고 현재 시각
    // 기준으로 다음 한 번만 계산함을 검증한다.
    let t = new Date(2026, 6, 31, 10, 0, 0).getTime()
    const h = harness({ now: () => t })
    h.coord.register(info('s1', everyMin()))
    t += 10 * 60_000 // 10분 점프 — 명목상 10회차가 지났지만 busy는 아니었다
    await vi.advanceTimersByTimeAsync(15_000 + 200) // one more polling tick
    expect(h.delivered.map((d) => d.text)).toEqual(['c'])
  })

  it('등록 시 schedState active 이벤트에 nextAt(ISO)을 실어 보낸다', () => {
    const h = harness()
    h.coord.register(info('s1', { rule: { kind: 'daily', time: '18:00' }, command: 'c' }))
    const ev = h.sent.find((s) => s.channel === 'session:schedState')
    expect(ev?.payload.state).toBe('active')
    expect(ev?.payload.nextAt).toBe(new Date(2026, 6, 31, 18, 0).toISOString())
  })

  it('rekey: delivers to the new id after a rolling switch, and sends off for the old id', async () => {
    const h = harness()
    h.coord.register(info('s1', everyMin()))
    h.coord.rekey('s1', 's2')
    const off = h.sent.find((s) => s.payload.sessionId === 's1' && s.payload.state === 'off')
    expect(off).toBeTruthy()
    await vi.advanceTimersByTimeAsync(60_000 + 15_000)
    expect(h.delivered.map((d) => d.id)).toEqual(['s2'])
  })

  it('rekey drops a backed-up pending round — avoids an input collision with the rolling resume window', async () => {
    const h = harness()
    h.coord.register(info('s1', everyMin()))
    h.coord.handleBusy('s1', true) // busy 중 발화 시각 도달 — pending=true로 대기
    await vi.advanceTimersByTimeAsync(60_000 + 15_000)
    h.coord.rekey('s1', 's2') // 롤 발생 — pending은 폐기되어야 한다
    h.coord.handleBusy('s2', false) // 새 PTY 유휴 전환 — 폐기 안 됐다면 즉시 발화했을 시점
    await vi.advanceTimersByTimeAsync(200)
    expect(h.delivered).toEqual([])
  })

  it('during the rolling resume window (switching) idle still does not send, and right after none it still does not send — the next tick sends once', async () => {
    const h = harness()
    h.coord.register(info('s1', everyMin()))
    h.coord.handleRollState({ sessionId: 's1', state: 'switching' })
    await vi.advanceTimersByTimeAsync(60_000 + 15_000) // 발화 시각 도달 — pending은 서지만 억제로 미전송
    expect(h.delivered).toEqual([])
    h.coord.handleRollState({ sessionId: 's1', state: 'none' }) // 억제 해제 — 즉시 발화하지 않는다
    expect(h.delivered).toEqual([]) // still unsent right after none — it would collide on the same input line
    await vi.advanceTimersByTimeAsync(15_000 + 200) // the next tick (within 15 s)
    expect(h.delivered.map((d) => d.text)).toEqual(['c'])
  })

  it('rekey keeps suppressed — the re-published event leaves no window in which suppression is off', async () => {
    const h = harness()
    h.coord.register(info('s1', everyMin()))
    h.coord.handleRollState({ sessionId: 's1', state: 'switching' })
    h.coord.rekey('s1', 's2')
    await vi.advanceTimersByTimeAsync(60_000 + 15_000) // tick이 발화 시각 도달을 보고 pending을 세움
    expect(h.delivered).toEqual([]) // suppressed survived the rekey, so the round is still held — unsent
  })

  it('nudged suppresses firing (idle still does not send) — the next tick after none sends once', async () => {
    // 당시엔 nudged 뒤에 'none'이 뒤따르지 않아 억제가 영구 latch될 위험 때문에
    // nudged를 억제 대상에서 제외했었다. rolling.ts의 resetAnchorCheck가 이제 Enter 전송 직후
    // 'none'을 게시하도록 고쳐져 그 위험이 없어졌으므로, switching/trust/waiting과
    // 동일하게 억제하고 동일하게 해제되는지 검증한다.
    const h = harness()
    h.coord.register(info('s1', everyMin()))
    h.coord.handleRollState({ sessionId: 's1', state: 'nudged' })
    await vi.advanceTimersByTimeAsync(60_000 + 15_000) // 발화 시각 도달 — pending은 서지만 억제로 미전송
    expect(h.delivered).toEqual([])
    h.coord.handleRollState({ sessionId: 's1', state: 'none' }) // 억제 해제 — 즉시 발화하지 않는다
    expect(h.delivered).toEqual([])
    await vi.advanceTimersByTimeAsync(15_000 + 200) // the next tick (within 15 s)
    expect(h.delivered.map((d) => d.text)).toEqual(['c'])
  })

  // stalled은 switching/trust/waiting/nudged와 달리 억제 목록에 넣지 않는다(default case로 빠진다,
  // 앞선 작업에서 그렇게 정했다). nudged와 달리 PTY에 아무것도 쓰지 않는 순수 알림 이벤트라 억제를 걸면
  // 짝이 되는 'none' 해제가 나올 일이 없어 영구 latch된다(과거에 겪은 부류의 버그) — 그래서 넣지
  // 않았다는 결정을 pin한다. suppressed 여부를 직접 노출하지 않으므로, 다른 테스트처럼 예정된
  // 발화가 억제 없이 정상적으로 나가는지로 간접 관찰한다.
  it('receiving stalled does not suppress a scheduled fire', async () => {
    const h = harness()
    h.coord.register(info('s1', everyMin()))
    h.coord.handleRollState({ sessionId: 's1', state: 'stalled' })
    await vi.advanceTimersByTimeAsync(60_000 + 15_000) // 발화 시각 도달 — 억제라면 여기서 미전송
    expect(h.delivered.map((d) => d.text)).toEqual(['c'])
  })

  it('while suppressed, handleBusy(false) still does not send', async () => {
    const h = harness()
    h.coord.register(info('s1', everyMin()))
    h.coord.handleBusy('s1', true)
    h.coord.handleRollState({ sessionId: 's1', state: 'waiting' })
    await vi.advanceTimersByTimeAsync(60_000 + 15_000) // 발화 시각 도달 — busy+suppressed 둘 다 대기
    h.coord.handleBusy('s1', false) // 유휴 전환되어도 억제가 남아 있으면 전송하지 않는다
    await vi.advanceTimersByTimeAsync(200)
    expect(h.delivered).toEqual([])
  })

  it('statusline에서 claude session id를 학습해 1회 영속한다', async () => {
    const h = harness()
    h.coord.register(info('s1', everyMin()))
    h.payloads.set('s1', { session_id: 'claude-sess', transcript_path: 'D:\\t.jsonl' })
    await vi.advanceTimersByTimeAsync(2 * 15_000) // tick 2회 — 학습은 1회만
    expect(h.persisted).toEqual([{ key: 'claude-sess', config: everyMin() }])
  })

  it('provider가 codex면 readStatusPayload가 아예 호출되지 않는다', async () => {
    const h = harness()
    h.coord.register(info('s1', everyMin()), 'codex')
    await vi.advanceTimersByTimeAsync(3 * 15_000) // tick 3회 — 학습 시도 자체가 없어야 한다
    expect(h.statusCalls).toEqual([])
  })

  // codex 에도 키를 배울 자리가 있다 — statusLine 이 아니라 rollout 감시자다. 그쪽은 모든 codex
  // 세션에 붙어 rollout 파일을 찾고, 그 탐색(findRollout)이 경로와 **세션 id 를 함께** 돌려준다.
  // 이 값이 없으면 codex 스케줄은 그 세션이 사는 동안만 돌고 다음 재개에 프리필되지 않는다.
  it('codex는 rollout 감시자가 알아낸 세션 id로 학습해 1회 영속한다', async () => {
    const h = harness({ codexSessionId: () => 'codex-sess' })
    h.coord.register(info('s1', everyMin()), 'codex')
    await vi.advanceTimersByTimeAsync(2 * 15_000) // tick 2회 — 학습은 1회만
    expect(h.persisted).toEqual([{ key: 'codex-sess', config: everyMin() }])
    expect(h.statusCalls).toEqual([]) // codex 는 여전히 statusLine 을 묻지 않는다
  })

  // rollout 탐색은 파일이 생길 때까지 걸린다(1초 폴링). 그동안 null 을 받는 것은 실패가 아니라
  // 아직 모르는 것이므로, 학습을 포기하지 않고 다음 tick 에 다시 묻는다.
  it('codex 세션 id를 아직 모르면 다음 tick에 다시 묻는다', async () => {
    let id: string | null = null
    const h = harness({ codexSessionId: () => id })
    h.coord.register(info('s1', everyMin()), 'codex')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(h.persisted).toEqual([])
    id = 'codex-sess'
    await vi.advanceTimersByTimeAsync(15_000)
    expect(h.persisted).toEqual([{ key: 'codex-sess', config: everyMin() }])
  })

  // 배선이 그 접근자를 넘기지 않으면(감시자가 없는 조합) 예전 동작 그대로다 — 조용히 아무 것도
  // 하지 않을 뿐, 스케줄 자체는 그 세션이 사는 동안 계속 돈다.
  it('codexSessionId 접근자가 없으면 아무 것도 영속하지 않는다', async () => {
    const h = harness()
    h.coord.register(info('s1', everyMin()), 'codex')
    await vi.advanceTimersByTimeAsync(3 * 15_000)
    expect(h.persisted).toEqual([])
  })

  it('provider 생략(기본 claude)이면 기존처럼 학습·영속이 일어난다', async () => {
    const h = harness()
    h.coord.register(info('s1', everyMin())) // provider 생략
    h.payloads.set('s1', { session_id: 'claude-sess', transcript_path: 'D:\\t.jsonl' })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(h.statusCalls).toContain('s1')
    expect(h.persisted).toEqual([{ key: 'claude-sess', config: everyMin() }])
  })

  it('resume 복원 등록(resumeSessionId 있음)은 키를 이미 알아 재영속하지 않는다', async () => {
    const h = harness()
    const i = info('s1', everyMin())
    i.resumeSessionId = 'claude-sess'
    h.coord.register(i)
    h.payloads.set('s1', { session_id: 'claude-sess', transcript_path: 'D:\\t.jsonl' })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(h.persisted).toEqual([])
  })

  it('disable: deletes the persisted config, sends off, and stops further sends', async () => {
    const h = harness()
    h.coord.register(info('s1', everyMin()))
    h.payloads.set('s1', { session_id: 'claude-sess', transcript_path: 'D:\\t.jsonl' })
    await vi.advanceTimersByTimeAsync(15_000) // 키 학습
    h.coord.disable('s1')
    expect(h.deleted).toEqual(['claude-sess'])
    expect(h.sent.at(-1)?.payload).toMatchObject({ sessionId: 's1', state: 'off' })
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(h.delivered).toEqual([])
  })

  it('handleExit: disposes the entry and stops further sends', async () => {
    const h = harness()
    h.coord.register(info('s1', everyMin()))
    h.coord.handleExit({ sessionId: 's1' })
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(h.delivered).toEqual([])
  })

  it('stop: disposes every entry (will-quit cleanup)', async () => {
    const h = harness()
    h.coord.register(info('s1', everyMin()))
    h.coord.register(info('s2', everyMin()))
    h.coord.stop()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(h.delivered).toEqual([])
  })
})

describe('chat sessions', () => {
  it('a chat entry fires through deliver once per round — no Enter', async () => {
    const h = harness()
    h.coord.register(chatInfo('c1', everyMin('status')), 'codex')
    await vi.advanceTimersByTimeAsync(60_000 + 15_000)
    expect(h.delivered).toEqual([{ id: 'c1', text: 'status' }])
  })

  it('busy from a chat status (working or waiting) holds the round; idle releases it once', async () => {
    const h = harness()
    h.coord.register(chatInfo('c1', everyMin()), 'claude')
    h.coord.handleBusy('c1', true) // ipc: status !== 'idle'
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 15_000)
    expect(h.delivered).toEqual([])
    h.coord.handleBusy('c1', false)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.delivered.map((d) => d.text)).toEqual(['c'])
  })

  it('learns a chat session key from chatThreadId and persists once; asks again while it is null', async () => {
    const h = harness()
    h.coord.register(chatInfo('c1', everyMin()), 'claude')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(h.persisted).toEqual([])
    expect(h.statusCalls).toEqual([]) // never the statusLine for a chat session, whatever the provider
    h.threadIds.set('c1', 'th-9')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(h.persisted).toEqual([{ key: 'th-9', config: everyMin() }])
    await vi.advanceTimersByTimeAsync(15_000)
    expect(h.persisted).toHaveLength(1)
  })

  it('a chat resume (threadId known) registers with the key and does not re-persist', async () => {
    const h = harness()
    h.coord.register(chatInfo('c1', everyMin(), 'th-1'), 'codex')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.persisted).toEqual([])
  })

  it('a rejected deliver keeps the round pending and retries next tick, up to MAX_REJECTIONS_PER_ROUND', async () => {
    const h = harness()
    h.rejectNext.count = 2
    h.coord.register(chatInfo('c1', everyMin('go')), 'codex')
    await vi.advanceTimersByTimeAsync(60_000 + 15_000) // due at 60s (attempt 1 rejects) and the 75s tick (attempt 2 rejects) both land in this span
    await vi.advanceTimersByTimeAsync(15_000)          // 90s tick: attempt 3 lands
    await vi.advanceTimersByTimeAsync(15_000)          // 105s tick: nothing pending — a no-op
    expect(h.delivered).toEqual([{ id: 'c1', text: 'go' }])
  })

  it('after MAX_REJECTIONS_PER_ROUND rejections the round is dropped, and the next round starts clean', async () => {
    const h = harness()
    h.rejectNext.count = 3
    h.coord.register(chatInfo('c1', everyMin('go')), 'codex')
    // Due at 60 s (ticks at 60, 75, 90 s are the three rejected attempts); the tick at 105 s makes no
    // fourth attempt — the round was dropped at the third refusal.
    await vi.advanceTimersByTimeAsync(60_000 + 15_000 * 3)
    expect(h.delivered).toEqual([])
    // The next round came due at 120 s (interval rounds recompute from the previous due time) and fires
    // normally: the refusal count was reset with the drop.
    await vi.advanceTimersByTimeAsync(15_000)
    expect(h.delivered).toEqual([{ id: 'c1', text: 'go' }])
  })

  it('a new round starts with a full attempt budget, even after the previous one ended part-refused', async () => {
    // The refusal budget is "3 times per round", so a round that never used its three attempts must not
    // hand its leftovers to the next one. That is reachable: busy holds a refused round past the next due
    // time, and the round that comes due then is the one this asserts on. Four refusals are queued, so
    // with the counter carried over the second round would be dropped on its first attempt and nothing
    // would ever be delivered; with the counter reset at the due branch the third attempt of the second
    // round lands.
    const h = harness()
    h.rejectNext.count = 4
    h.coord.register(chatInfo('c1', everyMin('go')), 'codex')
    await vi.advanceTimersByTimeAsync(60_000 + 15_000) // the 60 s and 75 s ticks: attempts one and two of round one refuse
    h.coord.handleBusy('c1', true) // busy from here — the round still owed cannot retry
    await vi.advanceTimersByTimeAsync(3 * 15_000) // 90 s and 105 s held; 120 s is round two coming due
    h.coord.handleBusy('c1', false) // the idle edge sends round two's first attempt
    await vi.advanceTimersByTimeAsync(2 * 15_000 + 200) // 135 s and 150 s: its second and third attempts
    expect(h.delivered).toEqual([{ id: 'c1', text: 'go' }])
  })

  it('a stale deliver resolving after a rekey does not reset rejections or log a fired line for the old id', async () => {
    const logs: string[] = []
    const deliverCalls: { id: string; text: string }[] = []
    let resolveStale: (() => void) | undefined
    const h = harness({
      log: (m) => logs.push(m),
      deliver: (id, text) => {
        deliverCalls.push({ id, text })
        // c1's round is left hanging — it resolves late, once the entry has already moved to c2.
        // c2's round always rejects, so the number of attempts it takes to drop the round exposes
        // whether the late c1 resolution wrongly reset the carried-over rejection count.
        if (id === 'c1') return new Promise<void>((resolve) => (resolveStale = resolve))
        return Promise.reject(new Error('refused'))
      }
    })
    h.coord.register(chatInfo('c1', everyMin('go')), 'codex')
    await vi.advanceTimersByTimeAsync(60_000) // due: c1's round fires and hangs (deliver's promise is still pending)
    h.coord.rekey('c1', 'c2')
    await vi.advanceTimersByTimeAsync(60_000) // 120s tick: c2's round comes due and rejects once — rejections=1
    expect(logs).toContain('schedule send refused session=c2 (1/3): refused')
    resolveStale?.() // the stale c1 promise resolves now, well after the rekey
    await vi.advanceTimersByTimeAsync(0) // flushes the stale .then
    expect(logs.some((m) => m.includes('schedule fired session=c1'))).toBe(false)
    // If the stale resolve had reset rejections to 0, c2 would get a fresh 3-attempt budget and the
    // round would still be pending after two more rejections. With the guard, only two more are needed
    // (1 carried over + 2 more = 3) before the round is dropped.
    await vi.advanceTimersByTimeAsync(2 * 15_000)
    expect(logs.some((m) => m.includes('schedule round dropped session=c2'))).toBe(true)
    expect(deliverCalls.filter((c) => c.id === 'c2')).toHaveLength(3)
  })
})
