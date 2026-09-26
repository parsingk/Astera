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

  it('a journal it cannot open is logged once and journals nothing, and nothing throws', async () => {
    await settings({ jobContinuityEnabled: true })
    // A file where the orch folder should be: the mkdir fails. (A folder at the journal's own path would
    // not do: ContinuityJournal moves an unopenable path aside and starts a new file.)
    await fs.writeFile(path.join(dir, 'orch'), 'not a folder')
    const { j, logs } = make()
    await j.start()
    expect(() => j.committed({ prev: on(), next: paused(), version: 1, actor: cli })).not.toThrow()
    expect(() => j.loaded({ before: on(), state: paused() })).not.toThrow()
    expect(logs.filter((l) => /could not open the journal/.test(l))).toHaveLength(1)
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
