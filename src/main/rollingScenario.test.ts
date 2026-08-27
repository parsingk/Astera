// 목(mock) 계정으로 돌리는 롤링 시나리오 테스트. rolling.test.ts가 규약을 단위로 쪼개 검증한다면
// 이 파일은 진짜 RollingCoordinator에 가짜 계정·가짜 statusline을 물려 "한도 → 전환/대기 → 재개"가
// 처음부터 끝까지 어떤 순서로 일어나는지를 타임라인으로 찍어 눈으로 확인하기 위한 것이다.
// 부작용(spawn/kill/copy/write/state/log)은 전부 주입된 deps로 기록만 하고 실제로는 아무것도 하지 않는다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'node:path'
import type { Account, SessionInfo } from '../core/types'
import { BlockRegistry } from '../core/rolling/blockRegistry'
import { RollingCoordinator, type RollingDeps } from './rolling'

const MIN = 60_000
const CFG = 'D:\\mock-cfg'

const acc = (id: string, label: string): Account => ({
  id,
  label,
  configDir: path.join(CFG, id),
  color: '#fff',
  createdAt: '2026-08-01T00:00:00Z'
})

// 통짜 리터럴 금지 관례는 rolling.test.ts와 동일 — 이 파일이 롤링 세션 PTY로 흘러가도 스캐너를 물리지 않는다.
const LIMIT_TEXT = 'Claude usage limit ' + 'reached ∙ resets 3am'

const mkPayload = (o: {
  five?: number
  weekly?: number
  fiveReset?: string
  weeklyReset?: string
  sid?: string
}): unknown => {
  const sid = o.sid ?? 'claude-sess'
  return {
    session_id: sid,
    transcript_path: path.join(CFG, 'a1', 'projects', 'D--work-p', `${sid}.jsonl`),
    rate_limits: {
      five_hour: { used_percentage: o.five ?? 0, ...(o.fiveReset ? { resets_at: o.fiveReset } : {}) },
      seven_day: { used_percentage: o.weekly ?? 0, ...(o.weeklyReset ? { resets_at: o.weeklyReset } : {}) }
    }
  }
}

/** 가짜 세계 하나. 모든 부작용을 시각과 함께 timeline에 적재하고, 마지막에 통째로 출력한다. */
function world(overrides: Partial<RollingDeps> = {}) {
  const accounts: Record<string, Account> = {
    a1: acc('a1', 'Mock-A'),
    a2: acc('a2', 'Mock-B'),
    a3: acc('a3', 'Mock-C')
  }
  const timeline: string[] = []
  const payloads = new Map<string, unknown>()
  const spawned: SessionInfo[] = []
  const written: { id: string; data: string }[] = []
  const states: { state: string; accountLabel?: string; nextRetryAt?: string; scope?: string }[] = []
  const clock = (): string => new Date(Date.now()).toISOString().slice(11, 19)
  const rec = (kind: string, msg: string): void => {
    timeline.push(`  ${clock()}  ${kind.padEnd(7)}  ${msg}`)
  }
  const short = (p: string): string => p.replace(CFG + path.sep, '')
  let seq = 1
  const coord = new RollingCoordinator({
    spawn: (o) => {
      seq++
      const info: SessionInfo = {
        id: `s${seq}`,
        accountId: o.account.id,
        cwd: o.cwd,
        status: 'running',
        title: 'p',
        resumeSessionId: o.resumeSessionId,
        rollAccountIds: o.rollAccountIds
      }
      spawned.push(info)
      rec('SPAWN', `${info.id} on ${o.account.label}  --resume ${o.resumeSessionId}`)
      return info
    },
    write: (id, data) => {
      written.push({ id, data })
      rec('WRITE', `${id} ← ${data === '\r' ? '<Enter>' : JSON.stringify(data)}`)
    },
    kill: (id) => rec('KILL', id),
    getAccount: (id) => accounts[id] ?? null,
    readStatusPayload: (id) => Promise.resolve(payloads.get(id) ?? null),
    send: (channel, p) => {
      if (channel !== 'session:rollState') return
      const q = p as { state: string; accountLabel?: string; nextRetryAt?: string; scope?: string }
      states.push(q)
      const extra = [
        q.accountLabel ? `→ ${q.accountLabel}` : '',
        q.nextRetryAt ? `retryAt=${q.nextRetryAt.slice(11, 19)} scope=${q.scope}` : ''
      ]
        .filter(Boolean)
        .join(' ')
      rec('STATE', `${q.state}${extra ? '  ' + extra : ''}`)
    },
    log: (m) => rec('LOG', m),
    lang: () => 'en',
    blocks: new BlockRegistry(),
    copy: (src, dest) => {
      rec('COPY', `${short(src)}  →  ${short(dest)}`)
      return Promise.resolve()
    },
    ...overrides
  } satisfies RollingDeps)

  const session = (ids: string[]): SessionInfo => ({
    id: 's1',
    accountId: 'a1',
    cwd: 'D:\\work\\p',
    status: 'running',
    title: 'p',
    rollAccountIds: ids
  })
  const dump = (title: string): void => {
    console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 74 - title.length))}\n${timeline.join('\n')}\n`)
  }
  return { coord, timeline, payloads, spawned, written, states, session, dump }
}

const flush = (): Promise<void> => vi.advanceTimersByTimeAsync(0) as unknown as Promise<void>

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 7, 6, 9, 0, 0))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('목 계정 롤링 시나리오 — 단일 계정', () => {
  it('한도 → 리셋까지 대기 → 같은 세션에서 그대로 재개(kill 없음)', async () => {
    const w = world()
    const resetAt = new Date(Date.now() + 10 * MIN).toISOString()
    w.payloads.set('s1', mkPayload({ five: 100, weekly: 20, fiveReset: resetAt }))
    w.coord.register(w.session(['a1']))

    w.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()

    // 단일 계정은 갈 곳이 없다 — 즉시 재개하지 않고 리셋 시각까지 대기한다
    expect(w.spawned).toHaveLength(0)
    expect(w.states.at(-1)?.state).toBe('waiting')
    expect(w.states.at(-1)?.scope).toBe('session')

    await vi.advanceTimersByTimeAsync(12 * MIN) // 리셋 + 여유
    await vi.advanceTimersByTimeAsync(2_000)

    // 계정이 바뀌지 않으므로 프로세스를 죽이지 않는다 — 살아 있는 s1에 프롬프트만 나간다.
    // 백그라운드 워크플로는 이 kill로만 죽으므로, 이 단정이 곧 그 사고의 회귀 가드다.
    expect(w.spawned).toHaveLength(0)
    expect(w.written.map((x) => x.data)).toEqual(['Continue the work', '\r'])
    expect(w.written.every((x) => x.id === 's1')).toBe(true)
    w.dump('단일 계정 · 5시간 한도 → 대기 → 같은 세션에서 재개')
  })

  it('한도 증거 없이 리셋 시각만 도달하면 아무것도 하지 않는다 (증거 게이트)', async () => {
    const start = Date.now()
    const w = world({
      probeActivity: () => Promise.resolve(start - 60_000), // 리셋 한참 전에 멈춘 활동
      readPending: () => Promise.resolve(1) // 남은 백그라운드 작업도 있다
    })
    // 사용률 30% — 한도에 걸린 적이 없는 세션. 사용자가 그냥 자리를 비웠을 뿐이다.
    w.payloads.set('s1', mkPayload({ five: 30, fiveReset: new Date(start + 10 * MIN).toISOString() }))
    w.coord.register(w.session(['a1']))

    await vi.advanceTimersByTimeAsync(16 * MIN) // 리셋(+10분) + GRACE(5분) 경과

    expect(w.written).toEqual([]) // 프롬프트가 나가면 안 된다
    expect(w.spawned).toEqual([])
    w.dump('단일 계정 · 한도 증거 없음 → 리셋 시각 도달해도 무개입')
  })
})

describe('목 계정 롤링 시나리오 — 멀티 계정', () => {
  it('한도 → 다음 계정으로 전환하고 전사를 옮겨 --resume 한다', async () => {
    const w = world()
    w.payloads.set('s1', mkPayload({ five: 100, weekly: 30 }))
    w.coord.register(w.session(['a1', 'a2', 'a3']))

    w.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    w.payloads.set('s2', mkPayload({ five: 5, weekly: 30 }))
    await vi.advanceTimersByTimeAsync(2_000)

    expect(w.spawned).toHaveLength(1)
    expect(w.spawned[0].accountId).toBe('a2') // 다음 계정으로
    expect(w.spawned[0].resumeSessionId).toBe('claude-sess') // 같은 대화를 이어받는다
    expect(w.written.map((x) => x.data)).toEqual(['Continue the work', '\r'])
    w.dump('멀티 계정 · a1 한도 → a2 전환')
  })

  it('세 계정이 연속으로 막히면 한 바퀴를 마치고 대기했다가 첫 계정으로 돌아온다', async () => {
    const w = world()
    w.payloads.set('s1', mkPayload({ five: 100, weekly: 30 }))
    w.coord.register(w.session(['a1', 'a2', 'a3']))

    w.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT }) // a1 → a2
    await flush()
    w.payloads.set('s2', mkPayload({ five: 100, weekly: 30 }))
    await vi.advanceTimersByTimeAsync(1_000)

    w.coord.handleData({ sessionId: 's2', data: LIMIT_TEXT }) // a2 → a3
    await flush()
    w.payloads.set('s3', mkPayload({ five: 100, weekly: 30 }))
    await vi.advanceTimersByTimeAsync(1_000)

    w.coord.handleData({ sessionId: 's3', data: LIMIT_TEXT }) // 세 번째 — 한 바퀴 전부 막혔다
    await flush()

    expect(w.states.at(-1)?.state).toBe('waiting') // 더 갈 곳이 없으니 대기
    expect(w.spawned.map((s) => s.accountId)).toEqual(['a2', 'a3'])

    await vi.advanceTimersByTimeAsync(16 * MIN)
    expect(w.spawned.at(-1)?.accountId).toBe('a1') // 대기 후 첫 계정으로 복귀
    w.dump('멀티 계정 · a1→a2→a3 전부 차단 → 대기 → a1 복귀')
  })

  it('전환에 성공하면 증거 게이트가 정상 세션의 진행을 막지 않는다', async () => {
    const w = world()
    w.payloads.set('s1', mkPayload({ five: 100, weekly: 30 }))
    w.coord.register(w.session(['a1', 'a2', 'a3']))
    w.coord.handleData({ sessionId: 's1', data: LIMIT_TEXT })
    await flush()
    // 전환된 계정은 사용률이 낮다 — 60초 뒤 healthyTimer가 차단 기록을 지운다
    w.payloads.set('s2', mkPayload({ five: 5, weekly: 30 }))
    await vi.advanceTimersByTimeAsync(2_000)
    const afterRoll = w.written.length

    await vi.advanceTimersByTimeAsync(2 * MIN) // 정상 동작 구간
    w.coord.onHookEvent('s2', { hook_event_name: 'Notification', notification_type: 'idle_prompt' })
    await vi.advanceTimersByTimeAsync(15 * MIN) // 자리를 비운다

    // 한도 기록은 healthyTimer가 지웠고 사용률도 5%다 → 개입할 근거가 없다
    expect(w.written.length).toBe(afterRoll)
    w.dump('멀티 계정 · 전환 성공 후 유휴 → 증거 없으므로 무개입')
  })
})
