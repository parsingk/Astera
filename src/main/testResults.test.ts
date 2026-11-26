import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RunStatus } from '../core/run/config'
import type { RunConfig } from '../core/run/types'
import { createTestResults, resultOfRun, type TestRunResult } from './testResults'

// Phase 3 Part 2: the last test result of each configuration a person runs, kept in main
let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'astera-test-results-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const result = (over: Partial<TestRunResult> = {}): TestRunResult => ({
  schemaVersion: 1,
  projectPath: 'D:/a',
  cwd: 'D:/a',
  configId: 'user:1',
  configName: 'unit',
  format: 'junit-xml',
  runId: 'r1',
  startedAt: '2026-11-26T01:00:00.000Z',
  endedAt: '2026-11-26T01:00:05.000Z',
  outcome: 'passed',
  cases: [],
  counts: { passed: 0, failed: 0, skipped: 0, errored: 0 },
  ...over
})

describe('createTestResults', () => {
  it('keeps the last result per configuration, in a file name Windows takes, and loads a project’s own', async () => {
    const store = createTestResults({ dir })
    await store.record(result())
    await store.record(result({ runId: 'r2', outcome: 'failed' }))
    await store.record(result({ projectPath: 'D:/b', configId: 'user:2', runId: 'r3' }))
    expect((await store.load('D:/a')).map((r) => r.runId)).toEqual(['r2'])
    expect((await store.load('d:\\a')).map((r) => r.runId)).toEqual(['r2'])
    expect(readdirSync(dir).every((f) => !f.includes(':'))).toBe(true)
    await store.forget('user:1')
    expect(await store.load('D:/a')).toEqual([])
  })

  it('lists only the configurations the project still has', async () => {
    const store = createTestResults({ dir })
    await store.record(result())
    await store.record(result({ configId: 'user:9', runId: 'r9' }))
    expect((await store.load('D:/a', new Set(['user:9']))).map((r) => r.runId)).toEqual(['r9'])
  })
})

describe('resultOfRun', () => {
  const status = (over: Partial<RunStatus> = {}): RunStatus =>
    ({ runId: 'r1', configId: 'user:1', projectPath: 'D:/a', status: 'exited', exitCode: 1, startedAt: Date.parse('2026-11-26T01:00:00.000Z'), exitedAt: Date.parse('2026-11-26T01:00:05.000Z'), ...over }) as RunStatus
  const config = { id: 'user:1', name: 'unit', type: 'npm', script: 'test', testReport: { format: 'junit-xml', path: 'report.xml' } } as RunConfig
  const read = async () => ({ outcome: 'failed' as const, report: { framework: 'vitest' as const, cases: [{ id: 'a', suite: [], name: 't', status: 'failed' as const }] } })

  it('records a person’s run of a configuration with a test report, its counts from the report', async () => {
    const r = await resultOfRun({ status: status(), config, cwd: 'D:/a', read })
    expect(r).toMatchObject({ projectPath: 'D:/a', cwd: 'D:/a', configId: 'user:1', configName: 'unit', format: 'junit-xml', runId: 'r1', outcome: 'failed', counts: { passed: 0, failed: 1, skipped: 0, errored: 0 } })
    expect(r?.startedAt).toBe('2026-11-26T01:00:00.000Z')
  })

  it('records a stopped run as stopped, with no cases, without reading the report', async () => {
    const r = await resultOfRun({ status: status({ stopped: true }), config, cwd: 'D:/a', read: async () => { throw new Error('read') } })
    expect(r).toMatchObject({ outcome: 'stopped', cases: [] })
  })

  it('records nothing for a validation, an exit the app lost sight of, or a configuration with no test report', async () => {
    expect(await resultOfRun({ status: status({ validation: true }), config, cwd: 'D:/a', read })).toBeNull()
    expect(await resultOfRun({ status: status({ exitCode: -1 }), config, cwd: 'D:/a', read })).toBeNull()
    expect(await resultOfRun({ status: status(), config: { ...config, testReport: undefined }, cwd: 'D:/a', read })).toBeNull()
    expect(await resultOfRun({ status: status(), config: undefined, cwd: 'D:/a', read })).toBeNull()
  })
})

// Phase 3 Part 2: a rerun of the failures updates the result instead of shrinking it to the rerun
describe('createTestResults, a failures-only rerun', () => {
  const c = (id: string, status: 'passed' | 'failed' | 'skipped'): TestRunResult['cases'][number] => ({ id, suite: [], name: id, status })
  it('merges a failures-only rerun into the stored result, a case the filter skipped keeping what it was', async () => {
    const store = createTestResults({ dir })
    await store.record(result({ outcome: 'failed', cases: [c('a', 'passed'), c('b', 'failed'), c('c', 'failed')], counts: { passed: 1, failed: 2, skipped: 0, errored: 0 } }))
    await store.record(result({ runId: 'r2', endedAt: '2026-11-26T02:00:00.000Z', scope: 'failures', outcome: 'passed', cases: [c('a', 'skipped'), c('b', 'passed'), c('c', 'passed')], counts: { passed: 2, failed: 0, skipped: 1, errored: 0 } }))
    const [r] = await store.load('D:/a')
    expect(r.cases.map((x) => [x.id, x.status])).toEqual([['a', 'passed'], ['b', 'passed'], ['c', 'passed']])
    expect(r).toMatchObject({ runId: 'r2', outcome: 'passed', endedAt: '2026-11-26T02:00:00.000Z', counts: { passed: 3, failed: 0, skipped: 0, errored: 0 } })
    // A rerun that read nothing of its own is recorded as it is: it says what happened
    await store.record(result({ runId: 'r3', scope: 'failures', outcome: 'unknown', stale: true, cases: [] }))
    expect((await store.load('D:/a'))[0]).toMatchObject({ runId: 'r3', outcome: 'unknown', stale: true })
  })
})
