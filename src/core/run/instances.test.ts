import { describe, it, expect } from 'vitest'
import { decideStart, placeNewRun, labelRuns, toolbarState, upsertRun } from './instances'
import type { RunStatus } from './config'
import type { RunConfig } from './types'

const cfg = (id: string, allowMultipleInstances?: boolean): RunConfig => ({
  id,
  name: id,
  type: 'shell',
  command: 'x',
  ...(allowMultipleInstances === undefined ? {} : { allowMultipleInstances })
})

let n = 0
const run = (
  configId: string,
  status: RunStatus['status'],
  o: Partial<Pick<RunStatus, 'seq' | 'startedAt' | 'projectPath' | 'runId' | 'configName'>> = {}
): RunStatus => {
  n += 1
  return {
    runId: o.runId ?? `r${n}`,
    projectPath: o.projectPath ?? 'D:/p',
    projectName: 'p',
    configId,
    configName: o.configName ?? configId,
    command: 'x',
    seq: o.seq ?? n,
    status,
    startedAt: o.startedAt ?? n,
    ...(status === 'exited' ? { exitCode: 0, exitedAt: n } : {})
  }
}

describe('decideStart', () => {
  it('starts when nothing of that configuration is live', () => {
    expect(decideStart([], cfg('dev'))).toEqual({ action: 'start' })
    expect(decideStart([run('dev', 'exited'), run('test', 'running')], cfg('dev'))).toEqual({ action: 'start' })
  })

  it('restarts the live run when the switch is off', () => {
    const live = run('dev', 'running')
    expect(decideStart([live], cfg('dev'))).toEqual({ action: 'restart', runId: live.runId })
    expect(decideStart([live], cfg('dev', false))).toEqual({ action: 'restart', runId: live.runId })
  })

  it('starts another when the switch is on, even with a live run', () => {
    expect(decideStart([run('dev', 'running')], cfg('dev', true))).toEqual({ action: 'start' })
  })

  // A restart takes a moment (the kill is asynchronous). A second press in that window must not
  // start a second replacement — the stopping run still counts as the one to restart.
  it('a stopping run counts as live', () => {
    const stopping = run('dev', 'stopping')
    expect(decideStart([stopping], cfg('dev'))).toEqual({ action: 'restart', runId: stopping.runId })
  })

  // Reachable by turning the switch on, starting two, then turning it off.
  it('with several live runs it names the most recently started', () => {
    const older = run('dev', 'running', { startedAt: 10 })
    const newer = run('dev', 'running', { startedAt: 20 })
    expect(decideStart([older, newer], cfg('dev'))).toEqual({ action: 'restart', runId: newer.runId })
  })
})

describe('placeNewRun', () => {
  it('appends after the highest seat when the list is empty or holds no finished run of that configuration', () => {
    expect(placeNewRun([], 'dev')).toEqual({ seq: 1 })
    expect(placeNewRun([run('test', 'exited', { seq: 3 }), run('dev', 'running', { seq: 7 })], 'dev')).toEqual({ seq: 8 })
  })

  it('takes over the earliest finished seat of the same configuration and names it', () => {
    const late = run('dev', 'exited', { seq: 5 })
    const early = run('dev', 'exited', { seq: 2 })
    expect(placeNewRun([late, early, run('test', 'exited', { seq: 1 })], 'dev')).toEqual({ seq: 2, replaces: early.runId })
  })

  it('never takes a live seat', () => {
    expect(placeNewRun([run('dev', 'running', { seq: 1 }), run('dev', 'stopping', { seq: 2 })], 'dev')).toEqual({ seq: 3 })
  })
})

describe('labelRuns', () => {
  it('a configuration with one run keeps its plain name', () => {
    expect(labelRuns([run('dev', 'running', { seq: 1 }), run('test', 'exited', { seq: 2 })]).map((l) => l.label)).toEqual([
      'dev',
      'test'
    ])
  })

  it('numbers repeats from the second one, in seat order', () => {
    const a = run('dev', 'running', { seq: 3 })
    const b = run('dev', 'running', { seq: 1 })
    const c = run('dev', 'exited', { seq: 2 })
    expect(labelRuns([a, b, c])).toEqual([
      { runId: b.runId, label: 'dev' },
      { runId: c.runId, label: 'dev (2)' },
      { runId: a.runId, label: 'dev (3)' }
    ])
  })

  it('groups by configuration id, not by name', () => {
    const old = run('dev', 'exited', { seq: 1, configName: 'dev' })
    const renamed = run('dev', 'running', { seq: 2, configName: 'serve' })
    expect(labelRuns([old, renamed]).map((l) => l.label)).toEqual(['dev', 'serve (2)'])
  })
})

describe('toolbarState', () => {
  it('nothing selected disables ▶ and offers no stop', () => {
    expect(toolbarState([run('dev', 'running')], null)).toEqual({ canRun: false })
  })

  it('a selected configuration with no running run: ▶ only', () => {
    expect(toolbarState([run('dev', 'exited'), run('test', 'running')], 'dev')).toEqual({ canRun: true })
  })

  it('a running run of the selection is the stop target — the most recent when there are several', () => {
    const older = run('dev', 'running', { startedAt: 1 })
    const newer = run('dev', 'running', { startedAt: 2 })
    expect(toolbarState([older, newer], 'dev')).toEqual({ canRun: true, stopTarget: newer.runId })
  })

  it('a stopping run is not a stop target', () => {
    expect(toolbarState([run('dev', 'stopping')], 'dev')).toEqual({ canRun: true })
  })
})

describe('upsertRun', () => {
  it('replaces the row with the same runId and keeps seat order', () => {
    const a = run('dev', 'running', { seq: 1 })
    const b = run('test', 'running', { seq: 2 })
    const aDone = { ...a, status: 'exited' as const, exitCode: 1 }
    expect(upsertRun([b, a], aDone)).toEqual([aDone, b])
  })

  it('appends a new run', () => {
    const a = run('dev', 'running', { seq: 1 })
    const c = run('api', 'running', { seq: 3 })
    expect(upsertRun([a], c)).toEqual([a, c])
  })

  // A restart or placeNewRun's takeover: main has already dropped the old record, and the new run
  // arrives on the same seat under a new id. Two rows on one seat must not appear.
  it('a run arriving on an occupied seat evicts the holder', () => {
    const old = run('dev', 'exited', { seq: 1 })
    const other = run('test', 'running', { seq: 2 })
    const fresh = run('dev', 'running', { seq: 1 })
    expect(upsertRun([old, other], fresh)).toEqual([fresh, other])
  })

  it('a seat collision in another project is not a collision', () => {
    const here = run('dev', 'running', { seq: 1, projectPath: 'D:/a' })
    const there = run('dev', 'running', { seq: 1, projectPath: 'D:/b' })
    expect(upsertRun([here], there)).toHaveLength(2)
  })
})
