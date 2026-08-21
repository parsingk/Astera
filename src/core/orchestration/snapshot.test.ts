import { describe, expect, it } from 'vitest'
import { findRun } from './snapshot'
import type { JobRun, OrchSnapshot } from '../types'

const jobRun = (id: string, over: Partial<JobRun> = {}): JobRun => ({
  id,
  objective: `objective ${id}`,
  outcome: 'running',
  done: 0,
  total: 0,
  eventCount: 0,
  sharesProjectFolder: false,
  tasks: [],
  ...over
})

const snap = (runs: JobRun[]): OrchSnapshot => ({ runs, projectFolderBusy: false })

describe('findRun', () => {
  it('최상위 Run 을 찾는다', () => {
    const s = snap([jobRun('r1'), jobRun('r2')])
    expect(findRun(s, 'r2')?.id).toBe('r2')
  })

  // 이 갈래가 이 함수의 존재 이유다 — 회차는 snapshotFor 가 최상위에서 빼고 children 에 넣는다
  it('템플릿의 회차를 찾는다', () => {
    const s = snap([
      jobRun('r1'),
      jobRun('tmpl', { schedule: { kind: 'daily', time: '09:00' }, children: [jobRun('kid')] })
    ])
    expect(findRun(s, 'kid')?.id).toBe('kid')
  })

  it('없으면 undefined', () => {
    const s = snap([jobRun('tmpl', { children: [jobRun('kid')] })])
    expect(findRun(s, 'nope')).toBeUndefined()
  })

  // 예약이 아닌 Run 에는 children 칸이 **아예 없다**(JobRun 의 주석) — 그 모양에서도 던지지 않아야
  // 한다. 스냅샷 대부분이 이 모양이다.
  it('children 칸이 없는 스냅샷에서도 동작한다', () => {
    const s = snap([jobRun('r1'), jobRun('r2')])
    expect(s.runs.every((r) => !('children' in r))).toBe(true)
    expect(findRun(s, 'r1')?.id).toBe('r1')
    expect(findRun(s, 'kid')).toBeUndefined()
  })
})
