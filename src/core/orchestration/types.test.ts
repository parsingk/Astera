import { describe, it, expect } from 'vitest'
import { canTransition, recomputeReady, newId, type Task } from './types'

const task = (id: string, status: Task['status'], deps: string[] = []): Task => ({
  id,
  runId: 'run_1',
  title: id,
  spec: 's',
  deps,
  status,
  consecutiveFailures: 0,
  createdAt: '2026-08-04T00:00:00.000Z',
  updatedAt: '2026-08-04T00:00:00.000Z'
})

describe('canTransition', () => {
  it('pending에서 ready·dispatched·blocked로 갈 수 있다', () => {
    expect(canTransition('pending', 'ready')).toBe(true)
    expect(canTransition('pending', 'dispatched')).toBe(true)
    expect(canTransition('pending', 'blocked')).toBe(true)
  })
  it('pending에서 completed로 바로 갈 수 없다', () => {
    expect(canTransition('pending', 'completed')).toBe(false)
  })
  it('dispatched에서 completed·failed로 갈 수 있다', () => {
    expect(canTransition('dispatched', 'completed')).toBe(true)
    expect(canTransition('dispatched', 'failed')).toBe(true)
  })
  it('dispatched에서 blocked로 갈 수 없다 — 열린 dispatch가 있는 Task는 Gate로 막지 않는다', () => {
    expect(canTransition('dispatched', 'blocked')).toBe(false)
  })
  it('failed에서 dispatched로 재시도할 수 있다', () => {
    expect(canTransition('failed', 'dispatched')).toBe(true)
  })
  it('failed에서 blocked로 갈 수 있다 — failed는 열린 dispatch가 없으므로 Gate를 걸어 재시도 여부를 물을 수 있다 (2026-08-04 판정)', () => {
    expect(canTransition('failed', 'blocked')).toBe(true)
  })
  it('blocked에서 ready로 풀린다', () => {
    expect(canTransition('blocked', 'ready')).toBe(true)
  })
  it('completed는 종단이다', () => {
    expect(canTransition('completed', 'dispatched')).toBe(false)
    expect(canTransition('completed', 'failed')).toBe(false)
  })
})

describe('recomputeReady', () => {
  it('deps가 없는 pending은 ready가 된다', () => {
    const out = recomputeReady([task('a', 'pending')])
    expect(out[0].status).toBe('ready')
  })
  it('deps가 전부 completed면 ready가 된다', () => {
    const out = recomputeReady([task('a', 'completed'), task('b', 'pending', ['a'])])
    expect(out.find((t) => t.id === 'b')!.status).toBe('ready')
  })
  it('deps 중 하나라도 completed가 아니면 pending에 머문다', () => {
    const out = recomputeReady([task('a', 'dispatched'), task('b', 'pending', ['a'])])
    expect(out.find((t) => t.id === 'b')!.status).toBe('pending')
  })
  it('blocked는 deps가 충족돼도 건드리지 않는다 — Gate가 풀어야 한다', () => {
    const out = recomputeReady([task('a', 'completed'), task('b', 'blocked', ['a'])])
    expect(out.find((t) => t.id === 'b')!.status).toBe('blocked')
  })
  it('이미 ready인 것은 그대로 둔다 (멱등)', () => {
    const once = recomputeReady([task('a', 'pending')])
    expect(recomputeReady(once)).toEqual(once)
  })
})

describe('newId', () => {
  it('접두사와 16자 본문을 가진다', () => {
    // 8자(32비트)에서 늘렸다 — 메시지 1만 건이면 충돌 확률 ≈1.2%이고, 충돌하면
    // s.messages.find(id)가 다른 메시지를 돌려줘 reply가 엉뚱한 질문에 답한다(조용히 틀린다).
    // 접두와 형식은 그대로다 — 기존 테스트와 로그가 그것에 의존한다.
    const id = newId('tsk')
    expect(id).toMatch(/^tsk_[0-9a-f]{16}$/)
  })
  it('연속 호출이 충돌하지 않는다', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newId('msg')))
    expect(ids.size).toBe(200)
  })
})
