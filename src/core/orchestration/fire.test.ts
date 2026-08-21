import { describe, expect, it } from 'vitest'
import { firesDue } from './fire'
import { emptyState, type OrchState } from './state'
import type { Run } from './types'

// 로컬 타임존 기준 시각 헬퍼 — core/scheduler/rule.test.ts 와 같은 모양이다. 규칙의 시각은
// 로컬 시계이므로(ScheduleRule 의 주석) UTC 리터럴로 쓰면 타임존마다 답이 달라진다
const at = (y: number, mo: number, d: number, h = 0, mi = 0): number =>
  new Date(y, mo - 1, d, h, mi, 0, 0).getTime()

const tmpl = (id: string, over: Partial<Run> = {}): Run => ({
  id,
  objective: `objective ${id}`,
  cwd: '/p',
  createdAt: '2026-08-21T00:00:00.000Z',
  provider: 'claude',
  schedule: { kind: 'daily', time: '09:00' },
  ...over
})

const withRuns = (runs: Run[]): OrchState => ({ ...emptyState(), runs })

describe('firesDue', () => {
  // 무장 없이 곧바로 발화시키면 앱을 켤 때마다 한 회차가 돈다 — 재시작이 곧 실행이 되어 버린다
  it('처음 본 템플릿은 발화하지 않고 무장만 한다', () => {
    const s = withRuns([tmpl('r1')])
    const r = firesDue(s, new Map(), at(2026, 8, 21, 10, 0))
    expect(r.fire).toEqual([])
    expect(r.arm.get('r1')).toBe(at(2026, 8, 22, 9, 0))
  })

  it('무장 시각 전이면 그 시각을 그대로 들고 있는다', () => {
    const s = withRuns([tmpl('r1')])
    const armed = new Map([['r1', at(2026, 8, 22, 9, 0)]])
    const r = firesDue(s, armed, at(2026, 8, 21, 10, 0))
    expect(r.fire).toEqual([])
    expect(r.arm.get('r1')).toBe(at(2026, 8, 22, 9, 0))
  })

  it('무장 시각을 지나면 발화하고 다시 무장한다', () => {
    const s = withRuns([tmpl('r1')])
    const armed = new Map([['r1', at(2026, 8, 21, 9, 0)]])
    const r = firesDue(s, armed, at(2026, 8, 21, 9, 0))
    expect(r.fire).toEqual(['r1'])
    expect(r.arm.get('r1')).toBe(at(2026, 8, 22, 9, 0))
  })

  // 놓친 발화를 합치지 않고 버린다는 규칙의 시험대. 재무장을 지난 시각 기준으로 잡으면 오래 자고
  // 깬 뒤 한 tick 안에서 사흘치가 쏟아진다
  it('오래 자고 깨어도 한 바퀴에 한 번만 발화하고, 재무장은 now 기준이다', () => {
    const s = withRuns([tmpl('r1')])
    const armed = new Map([['r1', at(2026, 8, 18, 9, 0)]])
    const r = firesDue(s, armed, at(2026, 8, 21, 10, 0))
    expect(r.fire).toEqual(['r1'])
    expect(r.arm.get('r1')).toBe(at(2026, 8, 22, 9, 0))
  })

  it('상태에서 사라진 템플릿은 무장에서 빠진다', () => {
    const armed = new Map([['gone', at(2026, 8, 21, 9, 0)]])
    const r = firesDue(emptyState(), armed, at(2026, 8, 21, 10, 0))
    expect(r.fire).toEqual([])
    expect(r.arm.has('gone')).toBe(false)
  })

  it('자식 Run 은 보지 않는다 — 회차는 스스로 발화하지 않는다', () => {
    const s = withRuns([tmpl('c1', { templateId: 'r1' })])
    const armed = new Map([['c1', at(2026, 8, 21, 9, 0)]])
    const r = firesDue(s, armed, at(2026, 8, 21, 10, 0))
    expect(r.fire).toEqual([])
    expect(r.arm.has('c1')).toBe(false)
  })

  it('schedule 없는 평범한 Run 은 보지 않는다', () => {
    const s = withRuns([tmpl('r1', { schedule: undefined })])
    const r = firesDue(s, new Map(), at(2026, 8, 21, 10, 0))
    expect(r.fire).toEqual([])
    expect(r.arm.size).toBe(0)
  })

  // isValidRule 이 거절하는 규칙이지만 orchestration.json 은 손으로 고쳐진다. days 가 비면
  // nextFireAt 의 366일 순회가 아무 날도 받아들이지 못해 NaN 이 된다
  it('nextFireAt 이 NaN 인 규칙은 무장하지 않는다', () => {
    const s = withRuns([tmpl('r1', { schedule: { kind: 'monthly', days: [], time: '09:00' } })])
    const r = firesDue(s, new Map(), at(2026, 8, 21, 10, 0))
    expect(r.fire).toEqual([])
    expect(r.arm.has('r1')).toBe(false)
  })

  it('템플릿 둘이 함께 발화하면 둘 다 싣는다', () => {
    const s = withRuns([tmpl('r1'), tmpl('r2')])
    const armed = new Map([
      ['r1', at(2026, 8, 21, 9, 0)],
      ['r2', at(2026, 8, 21, 9, 30)]
    ])
    const r = firesDue(s, armed, at(2026, 8, 21, 10, 0))
    expect(r.fire).toEqual(['r1', 'r2'])
  })
})
