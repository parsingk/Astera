import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAppJournal, type AppJournal, type AppJournalDeps } from './appJournal'
import { ContinuityJournal } from '../../core/continuity/journal'
import { JournalReader } from '../../core/continuity/journalReader'
import { holdLock } from '../../core/continuity/sqliteLockFixtures'
import { stateFromLegacy } from '../../core/orchestration/legacyState'
import type { OrchState } from '../../core/orchestration/state'

const NOW = '2026-09-26T10:00:00.000Z'
let dir: string
const opened: Array<{ close(): void }> = []
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-appjournal-'))
})
afterEach(async () => {
  for (const o of opened.splice(0)) o.close()
  await fs.rm(dir, { recursive: true, force: true })
})
const file = (): string => path.join(dir, 'continuity.sqlite')
const run = { id: 'run_1', objective: 'o', cwd: 'D:/p', createdAt: NOW }
const on = (): OrchState => stateFromLegacy({ runs: [run], tasks: [], dispatches: [] })
const paused = (): OrchState => stateFromLegacy({ runs: [{ ...run, paused: true }], tasks: [], dispatches: [] })
const JOURNAL_HOST = { connected: true, features: ['journal'] }
const OLDER_HOST = { connected: true, features: ['spawn'] }
const make = (status: { connected: boolean; unresponsive?: boolean; features: string[] }, over: Partial<AppJournalDeps> = {}) => {
  const box = { status }
  const calls: Array<{ cmd: string; args: Record<string, unknown> }> = []
  const logs: string[] = []
  const j = createAppJournal({
    file: file(),
    status: () => box.status,
    call: async (cmd, args) => {
      calls.push({ cmd, args })
      return { status: 200, body: { applied: 1, failed: 0 } }
    },
    log: (m) => logs.push(m),
    lang: () => 'en',
    smartResume: () => false,
    handoffLookup: () => ({ state: 'none' }),
    ...over
  })
  opened.push(j)
  j.open()
  return { j, box, calls, logs }
}
const rowsIn = (): string[] => {
  const r = new JournalReader(file())
  try {
    return r.eventsFor('run_1').map((e) => e.type)
  } finally {
    r.close()
  }
}

describe('createAppJournal', () => {
  it('in front of an older Host the app writes, as it always has', () => {
    const { j } = make(OLDER_HOST)
    expect(j.appWrites()).toBe(true)
    j.record(on(), paused())
    expect(rowsIn()).toEqual(['JOB_RUN_PAUSED'])
  })

  // Final review I2: a busy file is neither moved aside nor given up on until the next start.
  it('in front of an older Host, a busy open is logged, moves nothing aside, and is tried again at the next write', async () => {
    new ContinuityJournal(file()).close()
    const { j, logs } = make(OLDER_HOST, { busyTimeoutMs: 20 })
    const lock = holdLock(file())
    try {
      expect(j.record(on(), paused())).toEqual([])
    } finally {
      lock.release()
    }
    expect(logs.some((l) => /database is locked/.test(l))).toBe(true)
    expect((await fs.readdir(dir)).filter((n) => n.includes('.corrupt-'))).toEqual([])
    j.record(paused(), on())
    expect(rowsIn()).toEqual(['JOB_RUN_RESUMED'])
  })

  // Final review M4: an idle writer handle left open blocks the Host's move-aside on Windows.
  it('closes its own writer once a journal Host takes over, and never writes through it after', async () => {
    const { j, box } = make(OLDER_HOST)
    j.record(on(), paused())
    expect(rowsIn()).toEqual(['JOB_RUN_PAUSED'])
    const closed = vi.spyOn(ContinuityJournal.prototype, 'close')
    try {
      box.status = JOURNAL_HOST
      expect(j.appWrites()).toBe(false)
      expect(closed).toHaveBeenCalledTimes(1)
      j.record(paused(), on())
      expect(closed).toHaveBeenCalledTimes(1)
    } finally {
      closed.mockRestore()
    }
    expect(rowsIn()).toEqual(['JOB_RUN_PAUSED'])
    // With nothing of the app's holding the file, it can be moved (what the Host does with a broken one).
    await fs.rename(file(), `${file()}.moved`)
  })

  it('in front of a journal Host the app writes nothing and opens no writer', () => {
    const { j } = make(JOURNAL_HOST)
    expect(j.appWrites()).toBe(false)
    expect(j.record(on(), paused())).toEqual([])
    j.bootCleanup(on(), paused())
    expect(existsSync(file())).toBe(false)
  })

  // Review Focus 2 (P8).
  it('after the socket drops in front of a journal Host, the app still writes nothing locally', async () => {
    const { j, box, logs } = make(JOURNAL_HOST, { call: async () => { throw new Error('not connected') } })
    expect(j.appWrites()).toBe(false)
    box.status = { connected: false, features: [] }
    expect(j.appWrites()).toBe(false)
    j.record(on(), paused())
    j.reconcilerJournal.append([{ runId: 'run_1', type: 'RECOVERY_DETECTED', at: NOW, idempotencyKey: 'r1', payload: {} }])
    await j.settled()
    expect(existsSync(file())).toBe(false)
    expect(logs.some((l) => /could not reach the Host/.test(l))).toBe(true)
    // A later greeting of an older Host makes the app the writer again.
    box.status = OLDER_HOST
    expect(j.appWrites()).toBe(true)
  })

  it('sends the reconciler’s rows in order, the finish under the id the app minted (J3, P14)', async () => {
    const { j, calls } = make(JOURNAL_HOST)
    const rj = j.reconcilerJournal
    rj.append([{ runId: 'run_1', type: 'RECOVERY_DETECTED', at: NOW, idempotencyKey: 'r1', payload: {} }])
    const row = rj.startRecoveryAction({ runId: 'run_1', taskId: 'tsk_1', dispatchId: 'dsp_1', strategy: 'redispatch', class: 'safe', reason: 'r', at: NOW })
    rj.finishRecoveryAction(row.recoveryActionId, 'completed', NOW, { newDispatchId: 'dsp_2' })
    await j.settled()
    expect(calls.map((c) => [c.cmd, (c.args.ops as Array<{ op: string }>)[0].op])).toEqual([
      ['journal-append', 'events'],
      ['journal-append', 'recovery-start'],
      ['journal-append', 'recovery-finish']
    ])
    const [start, finish] = [calls[1].args.ops, calls[2].args.ops] as Array<Array<{ row?: { recoveryActionId: string }; id?: string }>>
    expect(start[0].row?.recoveryActionId).toBe(row.recoveryActionId)
    expect(finish[0].id).toBe(row.recoveryActionId)
  })

  it('reads the rows the Host wrote, through a read-only connection', () => {
    const host = new ContinuityJournal(file())
    opened.push(host)
    host.append([{ runId: 'run_1', taskId: 'tsk_1', dispatchId: 'dsp_1', type: 'ATTEMPT_LOST', at: NOW, idempotencyKey: 'l1', payload: {}, actor: { surface: 'host' } }])
    const { j } = make(JOURNAL_HOST)
    const state = stateFromLegacy({
      runs: [run],
      tasks: [{ id: 'tsk_1', runId: 'run_1', title: 't', spec: 's', deps: [], status: 'dispatched', consecutiveFailures: 0, createdAt: NOW, updatedAt: NOW }],
      dispatches: []
    })
    expect(j.timeline('run_1', state).map((e) => e.kind)).toEqual(['runtime-lost'])
    expect(j.reconcilerJournal.eventsFor('run_1').map((e) => e.actor)).toEqual([{ surface: 'host' }])
    expect(j.firstCheckpointHead('dsp_1')).toBeNull()
  })

  it('turning on in front of a journal Host asks it to reload and writes no baseline itself', async () => {
    const { j, calls } = make(JOURNAL_HOST)
    await j.turnedOn(on())
    j.settingsChanged()
    await j.settled()
    expect(calls.map((c) => c.cmd)).toEqual(['journal-reload', 'journal-reload'])
    expect(existsSync(file())).toBe(false)
  })

  it('off, it reads nothing and sends nothing', async () => {
    const { j, calls } = make(JOURNAL_HOST)
    j.close()
    expect(j.timeline('run_1', on())).toEqual([])
    j.note({ runId: 'run_1', type: 'PROMPT_WRITE_REQUESTED', at: NOW, idempotencyKey: 'p', payload: {} })
    await j.settled()
    expect(calls).toEqual([])
  })

  // Task 7 carry (review 4-5): the app's local keys and the Host's `app:` keys differ, so a row sent
  // both ways would land twice. Each reconciler row goes exactly one way, decided when it is written.
  it('writes each reconciler row exactly one way: locally in front of an older Host, through the Host otherwise', async () => {
    const { j, box, calls } = make(OLDER_HOST)
    const rj = j.reconcilerJournal
    rj.append([{ runId: 'run_1', type: 'RECOVERY_DETECTED', at: NOW, idempotencyKey: 'r1', payload: {} }])
    const local = rj.startRecoveryAction({ runId: 'run_1', taskId: 'tsk_1', dispatchId: 'dsp_1', strategy: 'redispatch', class: 'safe', reason: 'r', at: NOW })
    rj.finishRecoveryAction(local.recoveryActionId, 'completed', NOW)
    await j.settled()
    expect(calls).toEqual([])
    expect(rowsIn()).toEqual(['RECOVERY_DETECTED'])
    box.status = JOURNAL_HOST
    rj.append([{ runId: 'run_1', type: 'RECOVERY_STRATEGY_SELECTED', at: NOW, idempotencyKey: 'r2', payload: {} }])
    const sent = rj.startRecoveryAction({ runId: 'run_1', taskId: 'tsk_1', dispatchId: 'dsp_1', strategy: 'redispatch', class: 'safe', reason: 'r', at: NOW })
    rj.finishRecoveryAction(sent.recoveryActionId, 'failed', NOW)
    await j.settled()
    expect(calls.map((c) => (c.args.ops as Array<{ op: string }>)[0].op)).toEqual(['events', 'recovery-start', 'recovery-finish'])
    expect(rowsIn()).toEqual(['RECOVERY_DETECTED'])
    const r = new JournalReader(file())
    try {
      expect(r.recoveryActionsFor('run_1').map((a) => [a.recoveryActionId, a.status])).toEqual([[local.recoveryActionId, 'completed']])
    } finally {
      r.close()
    }
  })

  // Task 7 carry (review 4-5 I1 b): the Host reads the toggle only at start and on journal-reload, so
  // turning Job Continuity off must reach it too, after the app closed its own handles.
  it('turning off in front of a journal Host still tells it to reload', async () => {
    const { j, calls } = make(JOURNAL_HOST)
    j.close()
    j.settingsChanged()
    await j.settled()
    expect(calls.map((c) => c.cmd)).toEqual(['journal-reload'])
  })

  // Final review I1: a setting changed while the socket is down sends a journal-reload that cannot arrive.
  // Every greeting of a journal Host sends it again, so the Host follows the setting after the reconnect.
  it('after a reconnect to a journal Host, it sends journal-reload again; to an older Host it sends nothing', async () => {
    const box = { up: true }
    const { j, calls, box: status } = make(JOURNAL_HOST, {
      call: async (cmd, args) => {
        if (!box.up) throw new Error('no connection to the Host')
        calls.push({ cmd, args })
        return { status: 200, body: { enabled: true, writer: true } }
      }
    })
    box.up = false
    status.status = { connected: false, features: [] }
    j.settingsChanged()
    await j.settled()
    expect(calls).toEqual([])
    box.up = true
    status.status = JOURNAL_HOST
    j.greeted()
    await j.settled()
    expect(calls.map((c) => c.cmd)).toEqual(['journal-reload'])
    // Off, too: the Host must hear that it was turned off.
    j.close()
    j.greeted()
    await j.settled()
    expect(calls.map((c) => c.cmd)).toEqual(['journal-reload', 'journal-reload'])
    const older = make(OLDER_HOST)
    older.j.greeted()
    await older.j.settled()
    expect(older.calls).toEqual([])
  })

  it('in front of an older Host, turning on writes the baseline here and asks the Host for nothing', async () => {
    const { j, calls } = make(OLDER_HOST)
    const working = stateFromLegacy({
      runs: [run],
      tasks: [{ id: 'tsk_1', runId: 'run_1', title: 't', spec: 's', deps: [], status: 'dispatched', consecutiveFailures: 0, createdAt: NOW, updatedAt: NOW }],
      dispatches: [{ id: 'dsp_1', taskId: 'tsk_1', provider: 'claude', accountId: 'acc', sessionId: 'sess-1', cwd: path.join(dir, 'nowhere'), specPath: 's', startedAt: NOW, workerState: 'ready', retained: false }]
    })
    await j.turnedOn(working)
    j.settingsChanged()
    await j.settled()
    expect(calls).toEqual([])
    expect(rowsIn()).toEqual(['CONTINUITY_ENABLED', 'CHECKPOINT_CREATED'])
  })

  it('a prompt write goes to the Host in front of a journal Host, and is written here in front of an older one', async () => {
    const e = { runId: 'run_1', type: 'PROMPT_WRITE_REQUESTED' as const, at: NOW, idempotencyKey: 'p', payload: {} }
    const host = make(JOURNAL_HOST)
    host.j.note(e)
    await host.j.settled()
    expect(host.calls.map((c) => c.args.ops)).toEqual([[{ op: 'events', events: [e] }]])
    expect(existsSync(file())).toBe(false)
    host.j.close()
    const older = make(OLDER_HOST)
    older.j.note(e)
    await older.j.settled()
    expect(older.calls).toEqual([])
    expect(rowsIn()).toEqual(['PROMPT_WRITE_REQUESTED'])
  })
})

// Global Constraint 12. Mutation that fails it: putting `new ContinuityJournal(continuityFile` back in
// openContinuity, which reopens the app's own writer in front of a journal Host; or dropping the
// `appJournal.settingsChanged()` after closeContinuity, which leaves the Host journaling after toggle-off.
describe('ipc.ts journals through appJournal only (Host journal Task 7)', () => {
  it('opens no journal of its own and hands every journal use to appJournal', () => {
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ipc.ts'), 'utf8')
    expect(src).not.toMatch(/new ContinuityJournal\(/)
    expect(src).not.toMatch(/new ContinuityRecorder\(/)
    expect(src).toMatch(/const appJournal = createAppJournal\(\{/)
    expect(src).toMatch(/record: \(prev, next\) => appJournal\.record\(prev, next\)/)
    expect(src).toMatch(/journal: appJournal\.reconcilerJournal/)
    expect(src).toMatch(/appJournal\.bootCleanup\(/)
    expect(src).toMatch(/appJournal\.settingsChanged\(\)/)
    // Review 4-5 I1: every journal use the old wiring made directly now asks appJournal.
    expect(src).toMatch(/checkpoint: \(events, next\) => appJournal\.checkpoint\(events, next\)/)
    expect(src).toMatch(/onPromptWrite: \(e\) => appJournal\.note\(promptWriteEventOf\(/)
    expect(src).toMatch(/firstCheckpointHead: \(dispatchId\) => appJournal\.firstCheckpointHead\(dispatchId\)/)
    expect(src).toMatch(/\.\.\.appJournal\.timeline\(detailRunId, state\)/)
    expect(src).toMatch(/void appJournal\.turnedOn\(orch\.deps\.getState\(\)\)/)
    expect(src).not.toMatch(/continuityJournal|\bcontinuity\??\.[a-z]+\(/)
    // The toggle reaches the Host both ways (off in its handler, and the resume strategy), and after
    // the handles closed.
    const toggle = src.slice(src.indexOf("ipcMain.handle('settings.setJobContinuityEnabled'"))
    expect(toggle.slice(0, toggle.indexOf('return r'))).toMatch(/closeContinuity\(\)\s*appJournal\.settingsChanged\(\)/)
    // Final review I1: every greeting of a Host, beside the mirror's refill.
    const connect = src.slice(src.indexOf('hostClient.onConnect((h) => {'))
    expect(connect.slice(0, connect.indexOf("if (means === 'first')"))).toMatch(/remirrorOrchState\?\.\(\)\s*appJournal\.greeted\(\)/)
    const strategy = src.slice(src.indexOf("ipcMain.handle('settings.setResumeStrategy'"))
    expect(strategy.slice(0, strategy.indexOf('ipcMain.handle(', 10))).toMatch(/appJournal\.settingsChanged\(\)/)
  })
})
