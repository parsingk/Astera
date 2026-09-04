import { describe, it, expect } from 'vitest'
import type { RunStatus } from './config'
import { recentConfigIds, configRowStatus } from './menuRows'

const run = (
  runId: string,
  configId: string,
  startedAt: number,
  status: RunStatus['status'] = 'running',
  extra: Partial<RunStatus> = {}
): RunStatus => ({
  runId, projectPath: '/p', projectName: 'p', configId, configName: configId,
  command: 'x', seq: 1, status, startedAt, ...extra
})

describe('recentConfigIds', () => {
  it('is newest started first', () => {
    const runs = [run('r1', 'a', 1), run('r2', 'b', 5), run('r3', 'c', 3)]
    expect(recentConfigIds(runs, 5)).toEqual(['b', 'c', 'a'])
  })

  // A configuration with several runs is one row, placed by its newest run.
  it('names a configuration once, at its newest run', () => {
    const runs = [run('r1', 'a', 1), run('r2', 'b', 5), run('r3', 'a', 9)]
    expect(recentConfigIds(runs, 5)).toEqual(['a', 'b'])
  })

  it('counts finished runs too', () => {
    const runs = [run('r1', 'a', 9, 'exited', { exitCode: 0, exitedAt: 10 })]
    expect(recentConfigIds(runs, 5)).toEqual(['a'])
  })

  it('truncates at the limit, keeping the newest', () => {
    const runs = [run('r1', 'a', 1), run('r2', 'b', 2), run('r3', 'c', 3)]
    expect(recentConfigIds(runs, 2)).toEqual(['c', 'b'])
  })

  it('is empty with no runs', () => {
    expect(recentConfigIds([], 5)).toEqual([])
  })
})

describe('configRowStatus', () => {
  it('reports the number of live runs', () => {
    const runs = [run('r1', 'a', 1), run('r2', 'a', 2)]
    expect(configRowStatus(runs, 'a')).toEqual({ kind: 'running', count: 2 })
  })

  // A stopping run is still the user's process.
  it('counts a stopping run as live', () => {
    expect(configRowStatus([run('r1', 'a', 1, 'stopping')], 'a')).toEqual({ kind: 'running', count: 1 })
  })

  // A configuration with a server up and an old failure reads "1 running", not the failure.
  it('lets a live run win over a finished one', () => {
    const runs = [run('r1', 'a', 1, 'exited', { exitCode: 1, exitedAt: 2 }), run('r2', 'a', 3)]
    expect(configRowStatus(runs, 'a')).toEqual({ kind: 'running', count: 1 })
  })

  it('reports the newest finished run when none is live', () => {
    const older = run('r1', 'a', 1, 'exited', { exitCode: 0, exitedAt: 2 })
    const newer = run('r2', 'a', 5, 'exited', { exitCode: 1, exitedAt: 6 })
    expect(configRowStatus([older, newer], 'a')).toEqual({ kind: 'exited', run: newer })
  })

  it("ignores other configurations' runs", () => {
    expect(configRowStatus([run('r1', 'b', 1)], 'a')).toBeNull()
  })

  it('is null with no runs at all', () => {
    expect(configRowStatus([], 'a')).toBeNull()
  })
})
