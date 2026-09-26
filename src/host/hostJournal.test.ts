import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs, existsSync } from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { createHostJournal, type HostJournal, type HostJournalDeps } from './hostJournal'
import { hostAddress } from './address'
import { encodeLine, createLineReader } from './framing'
import { startHostServer, type HostServer } from './server'
import { HOST_PROTOCOL, HOST_YIELD_JOURNAL } from '../core/host/protocol'
import { versionOnlyOrchCall } from '../core/host/orchProtocol'
import { JournalReader } from '../core/continuity/journalReader'
import { ContinuityJournal } from '../core/continuity/journal'
import { holdLock, holdLockFor } from '../core/continuity/sqliteLockFixtures'
import { stateFromLegacy } from '../core/orchestration/legacyState'
import type { OrchState } from '../core/orchestration/state'
import type { Dispatch } from '../core/orchestration/types'

const NOW = '2026-09-26T10:00:00.000Z'
const STARTED = '2026-09-26T09:00:00.000Z'
let dir: string
const opened: Array<{ close(): void }> = []
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-hostjournal-'))
})
afterEach(async () => {
  for (const o of opened.splice(0)) o.close()
  await fs.rm(dir, { recursive: true, force: true })
})
const journalFile = (): string => path.join(dir, 'orch', 'continuity.sqlite')
const settings = (o: Record<string, unknown>): Promise<void> => fs.writeFile(path.join(dir, 'app-settings.json'), JSON.stringify(o))
const make = (over: Partial<HostJournalDeps> = {}): { j: HostJournal; box: { writer: boolean }; logs: string[] } => {
  const logs: string[] = []
  const box = { writer: true }
  const j = createHostJournal({ profileDir: dir, writer: () => box.writer, hostStartedAt: () => STARTED, now: () => NOW, log: (m) => logs.push(m), ...over })
  opened.push(j)
  return { j, box, logs }
}
const rows = (runId = 'run_1') => {
  const r = new JournalReader(journalFile())
  try {
    return r.eventsFor(runId)
  } finally {
    r.close()
  }
}
const run = { id: 'run_1', objective: 'o', cwd: 'D:/p', createdAt: NOW }
const on = (): OrchState => stateFromLegacy({ runs: [run], tasks: [], dispatches: [] })
const paused = (): OrchState => stateFromLegacy({ runs: [{ ...run, paused: true }], tasks: [], dispatches: [] })
const cli = { surface: 'cli' as const }

describe('createHostJournal', () => {
  it('journals nothing and opens no file while Job Continuity is off', async () => {
    const { j } = make()
    await j.start()
    j.committed({ prev: on(), next: paused(), version: 1, actor: cli })
    expect(existsSync(journalFile())).toBe(false)
    expect(j.timeline('run_1', paused())).toEqual([])
  })

  it('records a commit with its actor and its Host-life stamp', async () => {
    await settings({ jobContinuityEnabled: true })
    const { j } = make()
    await j.start()
    j.committed({ prev: on(), next: paused(), version: 4, actor: cli })
    expect(rows()).toEqual([expect.objectContaining({ type: 'JOB_RUN_PAUSED', actor: cli, idempotencyKey: `JOB_RUN_PAUSED:run_1:${STARTED}#4` })])
  })

  it('once closed (the Host leaving), a later commit writes nothing and reopens no handle', async () => {
    await settings({ jobContinuityEnabled: true })
    const { j } = make()
    await j.start()
    j.committed({ prev: on(), next: paused(), version: 1, actor: cli })
    expect(rows()).toHaveLength(1)
    j.close()
    // The exits leave() causes commit after the close; none of them may open the file again.
    j.committed({ prev: paused(), next: on(), version: 2, actor: { surface: 'host' } })
    expect(rows()).toHaveLength(1)
  })

  // Review Focus 1 (J2, P9).
  it('writes nothing while an attached app keeps the journal, and writes again once it leaves', async () => {
    await settings({ jobContinuityEnabled: true })
    const { j, box } = make()
    await j.start()
    box.writer = false
    j.committed({ prev: on(), next: paused(), version: 1, actor: cli })
    j.promptWrite({ dispatchId: 'dsp_1', taskId: 'tsk_1', phase: 'requested', via: 'argv', promptLength: 1, specPath: 's' }, paused())
    expect(j.append([{ op: 'events', events: [{ runId: 'run_1', type: 'RECOVERY_DETECTED', at: NOW, idempotencyKey: 'r1', payload: {} }] }]).status).toBe(409)
    expect(existsSync(journalFile()) ? rows() : []).toEqual([])
    box.writer = true
    j.committed({ prev: paused(), next: on(), version: 2, actor: cli })
    expect(rows().map((e) => e.type)).toEqual(['JOB_RUN_RESUMED'])
  })

  it('the load cleanup is the Host’s: a lost worker lands as ATTEMPT_LOST with actor host, and the timeline shows it', async () => {
    await settings({ jobContinuityEnabled: true })
    const { j } = make()
    await j.start()
    const d: Dispatch = { id: 'dsp_1', taskId: 'tsk_1', provider: 'claude', accountId: 'acc', sessionId: 'ses_gone', cwd: dir, specPath: 's', startedAt: NOW, workerState: 'ready', retained: false }
    const task = { id: 'tsk_1', runId: 'run_1', title: 'Auth refactor', spec: 's', deps: [], status: 'dispatched' as const, consecutiveFailures: 0, createdAt: NOW, updatedAt: NOW }
    const before = stateFromLegacy({ runs: [run], tasks: [task], dispatches: [d] })
    const after = stateFromLegacy({ runs: [run], tasks: [task], dispatches: [{ ...d, endedAt: NOW, workerState: 'outcome_unknown' }] })
    j.loaded({ before, state: after })
    expect(rows()).toEqual([expect.objectContaining({ type: 'ATTEMPT_LOST', actor: { surface: 'host' } })])
    expect(j.timeline('run_1', after)).toEqual([expect.objectContaining({ kind: 'runtime-lost', taskId: 'tsk_1', taskTitle: 'Auth refactor' })])
  })

  it('journal-append writes the app’s rows as desktop, and closes the recovery action under the id the app minted', async () => {
    await settings({ jobContinuityEnabled: true })
    const { j } = make()
    await j.start()
    const r = j.append([
      { op: 'events', events: [{ runId: 'run_1', taskId: 'tsk_1', dispatchId: 'dsp_1', type: 'RECOVERY_DETECTED', at: NOW, idempotencyKey: 'r1', payload: {} }] },
      { op: 'recovery-start', row: { recoveryActionId: 'rca_app', runId: 'run_1', taskId: 'tsk_1', dispatchId: 'dsp_1', strategy: 'redispatch', class: 'safe', reason: 'r', at: NOW } },
      { op: 'recovery-finish', id: 'rca_app', status: 'completed', at: NOW, details: { newDispatchId: 'dsp_2' } }
    ])
    expect(r).toEqual({ status: 200, body: { applied: 3, failed: 0 } })
    expect(rows()).toEqual([expect.objectContaining({ type: 'RECOVERY_DETECTED', actor: { surface: 'desktop' } })])
    const reader = new JournalReader(journalFile())
    opened.push(reader)
    expect(reader.recoveryActionsFor('run_1')).toEqual([expect.objectContaining({ recoveryActionId: 'rca_app', status: 'completed', details: { newDispatchId: 'dsp_2' } })])
  })

  // Review 4-5 M-2: the app's keys live in their own namespace, so no app row can take a key a later Host
  // row needs (a GATE_RESOLVED:<gateId> sent by the app would otherwise drop the Host's).
  it('journal-append writes the app’s keys under app:, and a Host row with the same key still lands', async () => {
    await settings({ jobContinuityEnabled: true })
    const { j } = make()
    await j.start()
    expect(j.append([{ op: 'events', events: [{ runId: 'run_1', type: 'JOB_RUN_PAUSED', at: NOW, idempotencyKey: `JOB_RUN_PAUSED:run_1:${STARTED}#1`, payload: {} }] }]).status).toBe(200)
    j.committed({ prev: on(), next: paused(), version: 1, actor: cli })
    expect(rows().map((e) => [e.idempotencyKey, e.actor?.surface])).toEqual([
      [`app:JOB_RUN_PAUSED:run_1:${STARTED}#1`, 'desktop'],
      [`JOB_RUN_PAUSED:run_1:${STARTED}#1`, 'cli']
    ])
  })

  it('journal-append writes one call in one transaction, and an op that fails costs only itself', async () => {
    await settings({ jobContinuityEnabled: true })
    const { j } = make()
    await j.start()
    // The depth each transaction was entered at: 0 is a BEGIN (one sync), anything deeper a savepoint.
    const depths: number[] = []
    const real = ContinuityJournal.prototype.transaction
    const tx = vi.spyOn(ContinuityJournal.prototype, 'transaction').mockImplementation(function <T>(this: ContinuityJournal, fn: () => T): T {
      depths.push((this as unknown as { depth: number }).depth)
      return real.call(this, fn) as T
    })
    try {
      const start = { recoveryActionId: 'rca_1', runId: 'run_1', taskId: 'tsk_1', dispatchId: 'dsp_1', strategy: 'redispatch', class: 'safe', reason: 'r', at: NOW }
      const r = j.append([
        { op: 'events', events: [{ runId: 'run_1', type: 'RECOVERY_DETECTED', at: NOW, idempotencyKey: 'r1', payload: {} }] },
        { op: 'recovery-start', row: start },
        { op: 'recovery-start', row: start }, // the same id again: its insert fails
        { op: 'events', events: [{ runId: 'run_1', type: 'RECOVERY_DETECTED', at: NOW, idempotencyKey: 'r2', payload: {} }] }
      ])
      expect(r).toEqual({ status: 200, body: { applied: 3, failed: 1 } })
      // One BEGIN for the whole call; every op (and the append inside it) a savepoint.
      expect(depths.filter((x) => x === 0)).toHaveLength(1)
      expect(depths[0]).toBe(0)
      expect(rows().map((e) => e.idempotencyKey)).toEqual(['app:r1', 'app:r2'])
    } finally {
      tx.mockRestore()
    }
  })

  it('journal-reload that turns journaling on writes the baseline; turning it off closes the handle and keeps the file', async () => {
    const { j } = make()
    await j.start()
    await settings({ jobContinuityEnabled: true })
    const withOpen = stateFromLegacy({
      runs: [run],
      tasks: [{ id: 'tsk_1', runId: 'run_1', title: 't', spec: 's', deps: [], status: 'dispatched', consecutiveFailures: 0, createdAt: NOW, updatedAt: NOW }],
      dispatches: [{ id: 'dsp_1', taskId: 'tsk_1', provider: 'claude', accountId: 'acc', sessionId: 'ses_1', cwd: dir, specPath: 's', startedAt: NOW, workerState: 'ready', retained: false }]
    })
    expect(await j.reload(() => withOpen)).toEqual({ enabled: true, writer: true })
    expect(rows().map((e) => [e.type, e.actor])).toContainEqual(['CONTINUITY_ENABLED', { surface: 'desktop' }])
    await settings({ jobContinuityEnabled: false })
    expect(await j.reload(() => withOpen)).toEqual({ enabled: false, writer: true })
    j.committed({ prev: on(), next: paused(), version: 9, actor: cli })
    expect(rows().some((e) => e.type === 'JOB_RUN_PAUSED')).toBe(false)
    expect(existsSync(journalFile())).toBe(true)
  })

  // Task 4 review CARRY: a reload that turned journaling on while an older app kept the journal wrote no
  // baseline, and nobody did. The Host owes it, and pays it the moment it becomes the writer.
  describe('the baseline a reload owes while this Host is not the writer', () => {
    const withOpen = (): OrchState =>
      stateFromLegacy({
        runs: [run],
        tasks: [{ id: 'tsk_1', runId: 'run_1', title: 't', spec: 's', deps: [], status: 'dispatched', consecutiveFailures: 0, createdAt: NOW, updatedAt: NOW }],
        dispatches: [{ id: 'dsp_1', taskId: 'tsk_1', provider: 'claude', accountId: 'acc', sessionId: 'ses_1', cwd: dir, specPath: 's', startedAt: NOW, workerState: 'ready', retained: false }]
      })
    const pausedOpen = (): OrchState => {
      const st = withOpen()
      return { ...st, runs: st.runs.map((r) => ({ ...r, paused: true })) }
    }
    const enabledRows = () => rows().filter((e) => e.type === 'CONTINUITY_ENABLED')
    // The owed baseline's checkpoint is fired and forgotten; a real git would still hold the folder open
    // when afterEach removes it.
    const noGit: HostJournalDeps['git'] = async () => ({ ok: false, stdout: '', stderr: 'no git in this test' })

    it('is written, as desktop, at the first write once this Host becomes the writer, and only once', async () => {
      const { j, box } = make({ git: noGit })
      await j.start()
      box.writer = false
      await settings({ jobContinuityEnabled: true })
      expect(await j.reload(() => withOpen())).toEqual({ enabled: true, writer: false })
      expect(existsSync(journalFile()) ? rows() : []).toEqual([])
      box.writer = true
      j.committed({ prev: withOpen(), next: pausedOpen(), version: 1, actor: cli })
      expect(enabledRows()).toEqual([expect.objectContaining({ actor: { surface: 'desktop' } })])
      expect(rows().map((e) => e.type)).toContain('JOB_RUN_PAUSED')
      j.committed({ prev: pausedOpen(), next: withOpen(), version: 2, actor: cli })
      expect(enabledRows()).toHaveLength(1)
    })

    // Review 4-5 M-3: paid once, not scanned for at every write after (the `already` scan would hide a
    // debt that is never dropped).
    it('is paid exactly once: no write after the payment looks for it again', async () => {
      const { j, box } = make({ git: noGit })
      await j.start()
      box.writer = false
      await settings({ jobContinuityEnabled: true })
      await j.reload(() => withOpen())
      box.writer = true
      const scans = vi.spyOn(ContinuityJournal.prototype, 'eventsFor')
      try {
        j.committed({ prev: withOpen(), next: pausedOpen(), version: 1, actor: cli })
        const afterPayment = scans.mock.calls.length
        expect(afterPayment).toBeGreaterThan(0)
        j.committed({ prev: pausedOpen(), next: withOpen(), version: 2, actor: cli })
        j.promptWrite({ dispatchId: 'dsp_1', taskId: 'tsk_1', phase: 'requested', via: 'argv', promptLength: 1, specPath: 's' }, withOpen())
        expect(scans.mock.calls.length).toBe(afterPayment)
      } finally {
        scans.mockRestore()
      }
      expect(enabledRows()).toHaveLength(1)
    })

    it('is not written when the file already has one since the reload', async () => {
      const { j, box } = make({ git: noGit })
      await j.start()
      box.writer = false
      await settings({ jobContinuityEnabled: true })
      await j.reload(() => withOpen())
      // An older app that could still open the file wrote its own baseline for the same toggle.
      await fs.mkdir(path.dirname(journalFile()), { recursive: true })
      const other = new ContinuityJournal(journalFile(), { log: () => {}, now: () => NOW })
      other.append([{ runId: 'run_1', type: 'CONTINUITY_ENABLED', at: NOW, idempotencyKey: 'CONTINUITY_ENABLED:run_1:app', payload: {} }])
      other.close()
      box.writer = true
      j.committed({ prev: withOpen(), next: pausedOpen(), version: 1, actor: cli })
      expect(enabledRows()).toHaveLength(1)
    })

    it('is dropped by a reload that turns journaling off again', async () => {
      const { j, box } = make({ git: noGit })
      await j.start()
      box.writer = false
      await settings({ jobContinuityEnabled: true })
      await j.reload(() => withOpen())
      await settings({ jobContinuityEnabled: false })
      await j.reload(() => withOpen())
      // On again with no reload behind it (a restart reads it at start): the app's toggle off ended the debt.
      await settings({ jobContinuityEnabled: true })
      await j.start()
      box.writer = true
      j.committed({ prev: withOpen(), next: pausedOpen(), version: 1, actor: cli })
      expect(rows().map((e) => e.type)).toEqual(['JOB_RUN_PAUSED'])
    })
  })

  // Final review I1: a toggle changed while the app's socket was down sent a journal-reload nobody heard.
  // The Host re-reads app-settings.json whenever an app greets it, so it follows the setting either way.
  describe('an app greeting re-reads the setting', () => {
    const noGit: HostJournalDeps['git'] = async () => ({ ok: false, stdout: '', stderr: 'no git in this test' })
    const withOpen = (paused = false): OrchState =>
      stateFromLegacy({
        runs: [{ ...run, paused }],
        tasks: [{ id: 'tsk_1', runId: 'run_1', title: 't', spec: 's', deps: [], status: 'dispatched', consecutiveFailures: 0, createdAt: NOW, updatedAt: NOW }],
        dispatches: [{ id: 'dsp_1', taskId: 'tsk_1', provider: 'claude', accountId: 'acc', sessionId: 'ses_1', cwd: dir, specPath: 's', startedAt: NOW, workerState: 'ready', retained: false }]
      })
    // The baseline's own checkpoint row is not what these tests are about.
    const types = (): string[] => (existsSync(journalFile()) ? rows().map((e) => e.type).filter((t) => t !== 'CHECKPOINT_CREATED') : [])

    it('turned on while no app was connected: the Host journals after the greeting, and off again stops it', async () => {
      const { j } = make({ git: noGit })
      await j.start()
      j.committed({ prev: withOpen(), next: withOpen(true), version: 1, actor: cli })
      expect(types()).toEqual([])
      // The app turned Job Continuity on while its socket was down: its journal-reload was lost.
      await settings({ jobContinuityEnabled: true })
      await j.appGreeted(() => withOpen(true))
      expect(types()).toEqual(['CONTINUITY_ENABLED'])
      j.committed({ prev: withOpen(true), next: withOpen(), version: 2, actor: cli })
      expect(types()).toEqual(['CONTINUITY_ENABLED', 'JOB_RUN_RESUMED'])
      // And off, the same way.
      await settings({ jobContinuityEnabled: false })
      await j.appGreeted(() => withOpen())
      j.committed({ prev: withOpen(), next: withOpen(true), version: 3, actor: cli })
      expect(types()).toEqual(['CONTINUITY_ENABLED', 'JOB_RUN_RESUMED'])
    })

    it('a greeting before the Host holds any state owes the baseline, and the first write pays it', async () => {
      const { j } = make({ git: noGit })
      await j.start()
      await settings({ jobContinuityEnabled: true })
      // The same thunk index.ts hands in: null until the load, the state after it.
      let loaded = false
      await j.appGreeted(() => (loaded ? withOpen() : null))
      loaded = true
      j.committed({ prev: withOpen(), next: withOpen(true), version: 1, actor: cli })
      expect(rows().filter((e) => e.type !== 'CHECKPOINT_CREATED').map((e) => [e.type, e.actor])).toEqual([
        ['CONTINUITY_ENABLED', { surface: 'desktop' }],
        ['JOB_RUN_PAUSED', cli]
      ])
    })
  })

  // Review 4-5 M-1: two reloads that overlap must not both see journaling as off and both write the
  // baseline (the clock moves between them, so their keys differ and both would land).
  it('two overlapping reloads that turn journaling on write the baseline once', async () => {
    let tick = 0
    const release: Array<() => void> = []
    const { j } = make({
      git: async () => ({ ok: false, stdout: '', stderr: 'no git in this test' }),
      now: () => new Date(Date.parse(NOW) + tick++ * 1000).toISOString(),
      // Each read waits until the test lets it go, so the two are in flight together.
      readSettings: () => new Promise((resolve) => release.push(() => resolve({ enabled: true, smartResume: false })))
    })
    const withOpen = stateFromLegacy({
      runs: [run],
      tasks: [{ id: 'tsk_1', runId: 'run_1', title: 't', spec: 's', deps: [], status: 'dispatched', consecutiveFailures: 0, createdAt: NOW, updatedAt: NOW }],
      dispatches: [{ id: 'dsp_1', taskId: 'tsk_1', provider: 'claude', accountId: 'acc', sessionId: 'ses_1', cwd: dir, specPath: 's', startedAt: NOW, workerState: 'ready', retained: false }]
    })
    const first = j.reload(() => withOpen)
    const second = j.reload(() => withOpen)
    let settled = false
    void Promise.all([first, second]).then(() => (settled = true))
    await vi.waitFor(() => expect(release.length).toBeGreaterThan(0))
    await new Promise((r) => setTimeout(r, 5))
    while (!settled) {
      release.splice(0).forEach((go) => go())
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(await first).toEqual({ enabled: true, writer: true })
    expect(await second).toEqual({ enabled: true, writer: true })
    expect(rows().filter((e) => e.type === 'CONTINUITY_ENABLED')).toHaveLength(1)
  })

  // Review 4-5: measured p99 is a few ms; a write that takes more than 50 ms is worth a line in the log.
  it('logs a warning for a journal write that takes more than 50 ms, and none for a fast one', async () => {
    await settings({ jobContinuityEnabled: true })
    let t = 0
    let step = 10
    const { j, logs } = make({ clockMs: () => (t += step) })
    await j.start()
    j.committed({ prev: on(), next: paused(), version: 1, actor: cli })
    expect(logs.filter((l) => /took \d+ ms/.test(l))).toEqual([])
    step = 60
    j.committed({ prev: paused(), next: on(), version: 2, actor: cli })
    j.append([{ op: 'events', events: [{ runId: 'run_1', type: 'RECOVERY_DETECTED', at: NOW, idempotencyKey: 'r1', payload: {} }] }])
    expect(logs.filter((l) => /took \d+ ms/.test(l))).toEqual([
      expect.stringMatching(/recording a commit took 60 ms/),
      expect.stringMatching(/journal-append took 60 ms/)
    ])
    expect(rows().map((e) => e.type)).toEqual(['JOB_RUN_PAUSED', 'JOB_RUN_RESUMED', 'RECOVERY_DETECTED'])
  })

  it('a journal it cannot open is logged once and journals nothing, and nothing throws', async () => {
    await settings({ jobContinuityEnabled: true })
    // A file where the orch folder should be: the mkdir fails. Any failure that is neither corruption nor
    // a lock is given up on for this Host's life (a lock is tried again, see below).
    await fs.writeFile(path.join(dir, 'orch'), 'not a folder')
    const { j, logs } = make()
    await j.start()
    expect(() => j.committed({ prev: on(), next: paused(), version: 1, actor: cli })).not.toThrow()
    expect(() => j.loaded({ before: on(), state: paused() })).not.toThrow()
    expect(logs.filter((l) => /could not open the journal/.test(l))).toHaveLength(1)
  })

  // Final review M2: runs follow asks for the timeline every 50 ms. The rows are read again only when the
  // journal changed; the lines are still built from the state of each call.
  it('reads a Run’s rows again only once the journal changed, and the lines follow the state either way', async () => {
    await settings({ jobContinuityEnabled: true })
    const { j } = make()
    await j.start()
    const d: Dispatch = { id: 'dsp_1', taskId: 'tsk_1', provider: 'claude', accountId: 'acc', sessionId: 'ses_gone', cwd: dir, specPath: 's', startedAt: NOW, workerState: 'ready', retained: false }
    const task = { id: 'tsk_1', runId: 'run_1', title: 'Auth refactor', spec: 's', deps: [], status: 'dispatched' as const, consecutiveFailures: 0, createdAt: NOW, updatedAt: NOW }
    const before = stateFromLegacy({ runs: [run], tasks: [task], dispatches: [d] })
    const after = stateFromLegacy({ runs: [run], tasks: [task], dispatches: [{ ...d, endedAt: NOW, workerState: 'outcome_unknown' }] })
    j.loaded({ before, state: after })
    const reads = vi.spyOn(JournalReader.prototype, 'eventsFor')
    try {
      const first = j.timeline('run_1', after)
      expect(first).toEqual([expect.objectContaining({ kind: 'runtime-lost', taskTitle: 'Auth refactor' })])
      expect(j.timeline('run_1', after)).toEqual(first)
      expect(j.timeline('run_1', after)).toEqual(first)
      expect(reads).toHaveBeenCalledTimes(1)
      // A renamed Task with no new row: the same rows, the new title.
      const renamed = { ...after, tasks: after.tasks.map((t) => ({ ...t, title: 'Renamed' })) }
      expect(j.timeline('run_1', renamed)).toEqual([expect.objectContaining({ taskTitle: 'Renamed' })])
      expect(reads).toHaveBeenCalledTimes(1)
      // A new row: read again.
      j.append([{ op: 'events', events: [{ runId: 'run_1', taskId: 'tsk_1', dispatchId: 'dsp_1', type: 'RECOVERY_STRATEGY_SELECTED', at: NOW, idempotencyKey: 'rs', payload: { strategy: 'redispatch', reason: 'r' } }] }])
      expect(j.timeline('run_1', after).map((e) => e.kind)).toEqual(['runtime-lost', 'recovery'])
      expect(reads).toHaveBeenCalledTimes(2)
    } finally {
      reads.mockRestore()
    }
  })

  // Final review I2: a busy file is not a corrupt one, and a busy open is not a failure for the Host's life.
  describe('a journal another process holds locked', () => {
    const corrupt = async (): Promise<string[]> => (await fs.readdir(path.dirname(journalFile()))).filter((n) => n.includes('.corrupt-'))
    const seedFile = async (): Promise<void> => {
      await fs.mkdir(path.dirname(journalFile()), { recursive: true })
      new ContinuityJournal(journalFile()).close()
    }

    it('a busy open is logged, moves nothing aside, and is tried again at the next write', async () => {
      await settings({ jobContinuityEnabled: true })
      await seedFile()
      const { j, logs } = make({ busyTimeoutMs: 20 })
      await j.start()
      const lock = holdLock(journalFile())
      try {
        j.committed({ prev: on(), next: paused(), version: 1, actor: cli })
      } finally {
        lock.release()
      }
      expect(logs.some((l) => /database is locked/.test(l))).toBe(true)
      expect(await corrupt()).toEqual([])
      j.committed({ prev: paused(), next: on(), version: 2, actor: cli })
      expect(rows().map((e) => e.type)).toEqual(['JOB_RUN_RESUMED'])
    })

    it('the timeline waits out a brief lock, and one held past the timeout is logged, reads as no rows and moves nothing', async () => {
      // Each profile's file is seeded and closed first: a lock can be taken only while no other connection
      // has the file open, so each reader meets the lock at its very first read.
      const seedLost = async (profileDir: string): Promise<void> => {
        await fs.mkdir(path.join(profileDir, 'orch'), { recursive: true })
        await fs.writeFile(path.join(profileDir, 'app-settings.json'), JSON.stringify({ jobContinuityEnabled: true }))
        const w = new ContinuityJournal(path.join(profileDir, 'orch', 'continuity.sqlite'))
        w.append([{ runId: 'run_1', taskId: 'tsk_1', dispatchId: 'dsp_1', type: 'ATTEMPT_LOST', at: NOW, idempotencyKey: 'lost', payload: {} }])
        w.close()
      }
      const task = { id: 'tsk_1', runId: 'run_1', title: 'Auth refactor', spec: 's', deps: [], status: 'dispatched' as const, consecutiveFailures: 0, createdAt: NOW, updatedAt: NOW }
      const state = stateFromLegacy({ runs: [run], tasks: [task], dispatches: [] })

      const brief = path.join(dir, 'brief')
      await seedLost(brief)
      const a = make({ profileDir: brief, busyTimeoutMs: 5000 })
      await a.j.start()
      const held = await holdLockFor(path.join(brief, 'orch', 'continuity.sqlite'), 150)
      expect(a.j.timeline('run_1', state)).toEqual([expect.objectContaining({ kind: 'runtime-lost', taskTitle: 'Auth refactor' })])
      await held.done

      const long = path.join(dir, 'long')
      await seedLost(long)
      const b = make({ profileDir: long, busyTimeoutMs: 20 })
      await b.j.start()
      const lock = holdLock(path.join(long, 'orch', 'continuity.sqlite'))
      try {
        expect(b.j.timeline('run_1', state)).toEqual([])
      } finally {
        lock.release()
      }
      expect(b.logs.some((l) => /run_1's journal rows failed: .*database is locked/.test(l))).toBe(true)
      expect((await fs.readdir(path.join(long, 'orch'))).filter((n) => n.includes('.corrupt-'))).toEqual([])
      expect(b.j.timeline('run_1', state)).toHaveLength(1)
    })
  })

  // J2 and P9 through the real server's appsKeep, the gate index.ts hands in: every attach and leave.
  describe('the one writer, judged by the attached apps', () => {
    let server: HostServer | null = null
    const sockets: net.Socket[] = []
    afterEach(async () => {
      for (const s of sockets.splice(0)) s.destroy()
      await server?.close().catch(() => {})
      server = null
    })
    const start = async (): Promise<{ s: HostServer; address: string }> => {
      const addr = hostAddress({ profileDir: path.join(dir, 'host-profile'), platform: process.platform, tmpDir: dir, protocol: HOST_PROTOCOL })
      server = await startHostServer({
        address: addr.address,
        dirToPrepare: addr.dirToPrepare,
        version: '9.9.9',
        idleMs: 60_000,
        onIdle: () => {},
        orch: versionOnlyOrchCall({ version: '9.9.9' }),
        pidLives: () => true,
        log: { write: () => {}, close: () => {} }
      })
      return { s: server, address: addr.address }
    }
    /** Greets with `hello` (one with no `role` is an app 1.3.25 or older) and resolves once the Host answered. */
    const attach = async (address: string, hello: Record<string, unknown>): Promise<net.Socket> => {
      const sock = net.connect(address)
      sockets.push(sock)
      await new Promise((r) => sock.once('connect', r))
      const answered = new Promise<void>((resolve) => {
        const read = createLineReader({ onMessage: () => resolve(), onBadLine: () => {}, onHandlerError: () => {} })
        sock.setEncoding('utf8')
        sock.on('data', read)
      })
      sock.write(encodeLine({ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0', ...hello }))
      await answered
      return sock
    }
    const newApp = { role: 'app', yields: ['worktrees', 'dispatch', HOST_YIELD_JOURNAL] }
    const olderApp = { role: 'app', yields: ['worktrees', 'dispatch'] }
    const legacyApp = { app: '1.3.25' }
    const types = (): string[] => (existsSync(journalFile()) ? rows().map((e) => e.type) : [])

    it('writes with no app and a yielding app, holds off for an older or legacy app, alone or beside a new one, and writes again once it leaves', async () => {
      await settings({ jobContinuityEnabled: true })
      const { s, address } = await start()
      const { j } = make({ writer: () => !s.appsKeep(HOST_YIELD_JOURNAL), hostStartedAt: () => s.startedAt })
      await j.start()
      let v = 0
      const flip = (): void => {
        v += 1
        j.committed(v % 2 === 1 ? { prev: on(), next: paused(), version: v, actor: cli } : { prev: paused(), next: on(), version: v, actor: cli })
      }
      const want: string[] = []
      const writes = (): void => {
        flip()
        want.push(v % 2 === 1 ? 'JOB_RUN_PAUSED' : 'JOB_RUN_RESUMED')
        expect(types()).toEqual(want)
      }
      const holdsOff = (): void => {
        flip()
        expect(types()).toEqual(want)
        expect(j.append([{ op: 'events', events: [{ runId: 'run_1', type: 'RECOVERY_DETECTED', at: NOW, idempotencyKey: `r${v}`, payload: {} }] }]).status).toBe(409)
      }

      writes() // no app
      const fresh = await attach(address, newApp)
      writes() // a new app that yields journal
      const older = await attach(address, olderApp)
      holdsOff() // a new app and an older app together
      older.end()
      await vi.waitFor(() => expect(s.appsKeep(HOST_YIELD_JOURNAL)).toBe(false))
      writes() // the older app left, the new one stays
      fresh.end()
      await vi.waitFor(() => expect(s.hasApp()).toBe(false))
      writes() // every app left
      const alone = await attach(address, olderApp)
      holdsOff() // an older app alone
      alone.end()
      await vi.waitFor(() => expect(s.hasApp()).toBe(false))
      writes()
      const legacy = await attach(address, legacyApp)
      holdsOff() // a role-less app 1.3.25 or older
      legacy.end()
      await vi.waitFor(() => expect(s.hasApp()).toBe(false))
      writes()
      await attach(address, { role: 'cli' })
      writes() // a CLI is not an app and keeps nothing
    })
  })
})
