import { describe, expect, it } from 'vitest'
import { findRun, runDetailKey, runIdToMerge } from './snapshot'
import type { JobRow, OrchSnapshot } from '../types'

const jobRun = (id: string, over: Partial<JobRow> = {}): JobRow => ({
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

const snap = (runs: JobRow[]): OrchSnapshot => ({ runs, projectFolderBusy: false })

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

  // 예약이 아닌 Run 에는 children 칸이 **아예 없다**(JobRow 의 주석) — 그 모양에서도 던지지 않아야
  // 한다. 스냅샷 대부분이 이 모양이다.
  it('children 칸이 없는 스냅샷에서도 동작한다', () => {
    const s = snap([jobRun('r1'), jobRun('r2')])
    expect(s.runs.every((r) => !('children' in r))).toBe(true)
    expect(findRun(s, 'r1')?.id).toBe('r1')
    expect(findRun(s, 'kid')).toBeUndefined()
  })
})

describe('runIdToMerge', () => {
  // The detail window opened from a Job row has the Job's id; run-merge knows Run ids only.
  it('a Job row that shows its one Run gives that Run id', () => {
    expect(runIdToMerge(jobRun('job_a', { foldedRunId: 'run_a' }), 'job_a')).toBe('run_a')
  })

  it('a Run row gives the id it was opened with', () => {
    expect(runIdToMerge(jobRun('run_b'), 'run_b')).toBe('run_b')
    expect(runIdToMerge(undefined, 'run_b')).toBe('run_b')
  })
})

// Performance audit R5: an open Run detail was read again on every push of the project's snapshot, whichever Run moved.
// Its key moves only with the open Run's own row.
describe('runDetailKey', () => {
  const row = (id: string, eventCount: number) => ({ id, objective: id, concurrency: 1, outcome: 'running' as const, done: 0, total: 1, eventCount, sharesProjectFolder: false, tasks: [] })
  it('moves with the open Run’s row only', () => {
    const a = { runs: [row('r1', 1), row('r2', 1)], projectFolderBusy: false }
    const other = { runs: [row('r1', 1), row('r2', 5)], projectFolderBusy: true }
    const mine = { runs: [row('r1', 2), row('r2', 1)], projectFolderBusy: false }
    expect(runDetailKey(other, 'r1')).toBe(runDetailKey(a, 'r1'))
    expect(runDetailKey(mine, 'r1')).not.toBe(runDetailKey(a, 'r1'))
    expect(runDetailKey(null, 'r1')).not.toBe(runDetailKey(a, 'r1'))
    expect(runDetailKey(a, 'gone')).not.toBe(runDetailKey(a, 'r1'))
  })
  // Final review M6: the detail's events link to sessions this app holds; one closing leaves the row as it was, and
  // the links must still be read again.
  it('moves when the sessions this app holds change, whatever their order', () => {
    const a = { runs: [row('r1', 1)], projectFolderBusy: false }
    expect(runDetailKey(a, 'r1', ['s1', 's2'])).toBe(runDetailKey(a, 'r1', ['s2', 's1']))
    expect(runDetailKey(a, 'r1', ['s1'])).not.toBe(runDetailKey(a, 'r1', ['s1', 's2']))
  })
})
