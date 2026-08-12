import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { SessionInfo, ScheduleConfig } from '../core/types'
import { SchedulerCoordinator, type SchedulerDeps } from './scheduler'

function harness(overrides: Partial<SchedulerDeps> = {}): {
  coord: SchedulerCoordinator
  written: { id: string; data: string }[]
  sent: { channel: string; payload: Record<string, unknown> }[]
  persisted: { key: string; config: unknown }[]
  deleted: string[]
  payloads: Map<string, unknown>
  statusCalls: string[] // readStatusPayload 호출 인자 기록 — codex 게이팅 검증용
} {
  const written: { id: string; data: string }[] = []
  const sent: { channel: string; payload: Record<string, unknown> }[] = []
  const persisted: { key: string; config: unknown }[] = []
  const deleted: string[] = []
  const payloads = new Map<string, unknown>()
  const statusCalls: string[] = []
  const coord = new SchedulerCoordinator({
    write: (id, data) => written.push({ id, data }),
    readStatusPayload: (id) => {
      statusCalls.push(id)
      return Promise.resolve(payloads.get(id) ?? null)
    },
    send: (channel, p) => sent.push({ channel, payload: p as Record<string, unknown> }),
    log: () => {},
    persistConfig: (key, config) => persisted.push({ key, config }),
    deleteConfig: (key) => deleted.push(key),
    ...overrides
  } satisfies SchedulerDeps)
  return { coord, written, sent, persisted, deleted, payloads, statusCalls }
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

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 6, 31, 10, 0, 0)) // 2026-07-31(금) 10:00 로컬
})
afterEach(() => {
  vi.useRealTimers()
})

describe('SchedulerCoordinator', () => {
  it('간격 규칙: N분 경과 후 tick에서 명령 → 150ms 뒤 Enter를 전송한다', async () => {
    const h = harness()
    h.coord.register(info('s1', everyMin('상태 점검')))
    await vi.advanceTimersByTimeAsync(60_000 + 15_000) // 1분 경과 + 다음 tick + Enter 지연
    expect(h.written.map((w) => w.data)).toEqual(['상태 점검', '\r'])
    expect(h.written.every((w) => w.id === 's1')).toBe(true)
  })

  it('schedule 없는 세션은 등록되지 않는다', async () => {
    const h = harness()
    h.coord.register(info('s1'))
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(h.written).toEqual([])
    expect(h.sent).toEqual([])
  })

  it('busy면 대기하고 유휴 전환 시 1회만 전송한다 (겹친 회차 합침)', async () => {
    const h = harness()
    h.coord.register(info('s1', everyMin()))
    h.coord.handleBusy('s1', true)
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 15_000) // 3회차 경과 — pending 1개로 합쳐짐
    expect(h.written).toEqual([])
    h.coord.handleBusy('s1', false)
    await vi.advanceTimersByTimeAsync(200)
    expect(h.written.map((w) => w.data)).toEqual(['c', '\r'])
  })

  it('busy 아니어도 clock jump로 여러 회차를 건너뛰면 재계산 후 1회만 발화한다 (놓친 회차 무시)', async () => {
    // deps.now를 직접 제어해 "시스템 sleep 후 재개"처럼 10회차 분(10분)을 한 번에 건너뛴다.
    // tick 폴링(15초)은 정상 진행하되, 그 한 번의 tick이 관측하는 now()만 크게 앞서 있는 상황 —
    // busy 병합(pending boolean)과 별개로, nextAt 재계산 자체가 밀린 횟수를 쌓지 않고 현재 시각
    // 기준으로 다음 한 번만 계산함을 검증한다.
    let t = new Date(2026, 6, 31, 10, 0, 0).getTime()
    const h = harness({ now: () => t })
    h.coord.register(info('s1', everyMin()))
    t += 10 * 60_000 // 10분 점프 — 명목상 10회차가 지났지만 busy는 아니었다
    await vi.advanceTimersByTimeAsync(15_000 + 200) // 다음 폴링 tick 1회 + Enter 지연
    expect(h.written.map((w) => w.data)).toEqual(['c', '\r'])
  })

  it('등록 시 schedState active 이벤트에 nextAt(ISO)을 실어 보낸다', () => {
    const h = harness()
    h.coord.register(info('s1', { rule: { kind: 'daily', time: '18:00' }, command: 'c' }))
    const ev = h.sent.find((s) => s.channel === 'session:schedState')
    expect(ev?.payload.state).toBe('active')
    expect(ev?.payload.nextAt).toBe(new Date(2026, 6, 31, 18, 0).toISOString())
  })

  it('rekey: 롤링 전환 후 새 id로 전송하고, 옛 id에는 off를 보낸다', async () => {
    const h = harness()
    h.coord.register(info('s1', everyMin()))
    h.coord.rekey('s1', 's2')
    const off = h.sent.find((s) => s.payload.sessionId === 's1' && s.payload.state === 'off')
    expect(off).toBeTruthy()
    await vi.advanceTimersByTimeAsync(60_000 + 15_000)
    expect(h.written.map((w) => w.id)).toEqual(['s2', 's2'])
  })

  it('rekey 시 밀린 회차(pending)를 버린다 — 롤링 재개 구간과의 입력 충돌 회피', async () => {
    const h = harness()
    h.coord.register(info('s1', everyMin()))
    h.coord.handleBusy('s1', true) // busy 중 발화 시각 도달 — pending=true로 대기
    await vi.advanceTimersByTimeAsync(60_000 + 15_000)
    h.coord.rekey('s1', 's2') // 롤 발생 — pending은 폐기되어야 한다
    h.coord.handleBusy('s2', false) // 새 PTY 유휴 전환 — 폐기 안 됐다면 즉시 발화했을 시점
    await vi.advanceTimersByTimeAsync(200)
    expect(h.written).toEqual([])
  })

  it('롤링 재개 구간(switching) 중에는 유휴여도 전송하지 않고, none 수신 직후엔 미전송·다음 tick에서 1회 전송한다', async () => {
    const h = harness()
    h.coord.register(info('s1', everyMin()))
    h.coord.handleRollState({ sessionId: 's1', state: 'switching' })
    await vi.advanceTimersByTimeAsync(60_000 + 15_000) // 발화 시각 도달 — pending은 서지만 억제로 미전송
    expect(h.written).toEqual([])
    h.coord.handleRollState({ sessionId: 's1', state: 'none' }) // 억제 해제 — 즉시 발화하지 않는다
    expect(h.written).toEqual([]) // none 수신 직후에는 아직 미전송 (같은 입력 줄 충돌 회피)
    await vi.advanceTimersByTimeAsync(15_000 + 200) // 다음 tick(≤15초) + Enter 지연
    expect(h.written.map((w) => w.data)).toEqual(['c', '\r'])
  })

  it('rekey는 suppressed를 유지한다 — 재게시 이벤트 도착 전 찰나에 억제가 풀리지 않는다', async () => {
    const h = harness()
    h.coord.register(info('s1', everyMin()))
    h.coord.handleRollState({ sessionId: 's1', state: 'switching' })
    h.coord.rekey('s1', 's2')
    await vi.advanceTimersByTimeAsync(60_000 + 15_000) // tick이 발화 시각 도달을 보고 pending을 세움
    expect(h.written).toEqual([]) // suppressed가 살아있어 억제 유지 — 미전송
  })

  it('nudged 동안은 억제된다(유휴여도 미전송) — none 수신 후 다음 tick에서 1회 전송한다', async () => {
    // 당시엔 nudged 뒤에 'none'이 뒤따르지 않아 억제가 영구 latch될 위험 때문에
    // nudged를 억제 대상에서 제외했었다. rolling.ts의 resetAnchorCheck가 이제 Enter 전송 직후
    // 'none'을 게시하도록 고쳐져 그 위험이 없어졌으므로, switching/trust/waiting과
    // 동일하게 억제하고 동일하게 해제되는지 검증한다.
    const h = harness()
    h.coord.register(info('s1', everyMin()))
    h.coord.handleRollState({ sessionId: 's1', state: 'nudged' })
    await vi.advanceTimersByTimeAsync(60_000 + 15_000) // 발화 시각 도달 — pending은 서지만 억제로 미전송
    expect(h.written).toEqual([])
    h.coord.handleRollState({ sessionId: 's1', state: 'none' }) // 억제 해제 — 즉시 발화하지 않는다
    expect(h.written).toEqual([])
    await vi.advanceTimersByTimeAsync(15_000 + 200) // 다음 tick(≤15초) + Enter 지연
    expect(h.written.map((w) => w.data)).toEqual(['c', '\r'])
  })

  // stalled은 switching/trust/waiting/nudged와 달리 억제 목록에 넣지 않는다(default case로 빠진다,
  // 앞선 작업에서 그렇게 정했다). nudged와 달리 PTY에 아무것도 쓰지 않는 순수 알림 이벤트라 억제를 걸면
  // 짝이 되는 'none' 해제가 나올 일이 없어 영구 latch된다(과거에 겪은 부류의 버그) — 그래서 넣지
  // 않았다는 결정을 pin한다. suppressed 여부를 직접 노출하지 않으므로, 다른 테스트처럼 예정된
  // 발화가 억제 없이 정상적으로 나가는지로 간접 관찰한다.
  it('stalled 수신은 스케쥴 발화를 억제하지 않는다', async () => {
    const h = harness()
    h.coord.register(info('s1', everyMin()))
    h.coord.handleRollState({ sessionId: 's1', state: 'stalled' })
    await vi.advanceTimersByTimeAsync(60_000 + 15_000) // 발화 시각 도달 — 억제라면 여기서 미전송
    expect(h.written.map((w) => w.data)).toEqual(['c', '\r'])
  })

  it('억제 중에는 handleBusy(false)가 와도 전송하지 않는다', async () => {
    const h = harness()
    h.coord.register(info('s1', everyMin()))
    h.coord.handleBusy('s1', true)
    h.coord.handleRollState({ sessionId: 's1', state: 'waiting' })
    await vi.advanceTimersByTimeAsync(60_000 + 15_000) // 발화 시각 도달 — busy+suppressed 둘 다 대기
    h.coord.handleBusy('s1', false) // 유휴 전환되어도 억제가 남아 있으면 전송하지 않는다
    await vi.advanceTimersByTimeAsync(200)
    expect(h.written).toEqual([])
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

  it('disable: 영속 삭제 + off 이벤트 + 이후 미전송', async () => {
    const h = harness()
    h.coord.register(info('s1', everyMin()))
    h.payloads.set('s1', { session_id: 'claude-sess', transcript_path: 'D:\\t.jsonl' })
    await vi.advanceTimersByTimeAsync(15_000) // 키 학습
    h.coord.disable('s1')
    expect(h.deleted).toEqual(['claude-sess'])
    expect(h.sent.at(-1)?.payload).toMatchObject({ sessionId: 's1', state: 'off' })
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(h.written).toEqual([])
  })

  it('handleExit: 엔트리 폐기, 이후 미전송', async () => {
    const h = harness()
    h.coord.register(info('s1', everyMin()))
    h.coord.handleExit({ sessionId: 's1' })
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(h.written).toEqual([])
  })

  it('stop: 모든 엔트리 폐기 (will-quit 정리)', async () => {
    const h = harness()
    h.coord.register(info('s1', everyMin()))
    h.coord.register(info('s2', everyMin()))
    h.coord.stop()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(h.written).toEqual([])
  })
})
