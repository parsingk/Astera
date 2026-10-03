// The app's side of session work units since the Host writes them (E2 §3, §6): a real collector and a
// real store over a real workUnits.json, with the sessions, git and the Host's orch-calls faked, so what
// reaches the file is what the app would leave there.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WorkUnitCollector, type CollectorSession, type CollectorGit } from '../../core/workUnit/collector'
import { readWorkUnitsFile, type WorkUnitState } from '../../core/workUnit/store'
import type { SessionWorkUnit } from '../../core/workUnit/types'
import { AppWorkUnitStore, createAppWorkUnits, type AppWorkUnitsDeps, type WorkUnitsCall } from './appWorkUnits'

let dir: string
let file: string
let root: string
let transcript: string

const hostUnit = (over: Partial<SessionWorkUnit> = {}): SessionWorkUnit => ({
  id: 'wu-host',
  sessionId: 'host-s1',
  projectPath: root,
  objective: 'opened by the Host',
  status: 'active',
  startedAt: '2026-10-03T09:00:00.000Z',
  git: { startHead: 'c0', observedChangedFiles: [] },
  encounteredExternalGitChangeIds: [],
  ...over
})

const stateOf = (units: SessionWorkUnit[]): WorkUnitState => ({ units, cursors: [], externalGitChanges: [] })

/** What a Host write leaves on disk: this project's units replaced. */
const hostWrites = async (units: SessionWorkUnit[], key = root): Promise<void> => {
  const cur = await readWorkUnitsFile(file)
  // A later mtime than any write the app made in the same millisecond, so the store's stamp moves.
  await new Promise((r) => setTimeout(r, 15))
  await fs.writeFile(file, JSON.stringify({ projects: { ...cur.projects, [key]: stateOf(units) } }, null, 2), 'utf8')
}
const onDisk = (): string => readFileSync(file, 'utf8')
const unitsOnDisk = (): SessionWorkUnit[] => JSON.parse(onDisk()).projects[root]?.units ?? []

interface Rig {
  deps: AppWorkUnitsDeps
  store: AppWorkUnitStore
  collector: WorkUnitCollector
  sessions: CollectorSession[]
  calls: Array<{ cmd: WorkUnitsCall; args: Record<string, unknown> }>
  notified: string[]
  ignored: Array<{ projectPath: string; blockingUnitId: string }>
  logs: string[]
  state: { tracking: boolean; reply: (cmd: WorkUnitsCall) => Promise<{ status: number; body: unknown }> }
}

function rig(over: Partial<AppWorkUnitsDeps> = {}): Rig {
  const store = new AppWorkUnitStore(file)
  const sessions: CollectorSession[] = []
  const git: CollectorGit = {
    readRef: async () => ({ branch: 'main', head: 'c0' }),
    isAncestor: async () => true,
    changedFiles: async () => [],
    readRange: async () => ({ commits: [], changedFiles: [] })
  } as unknown as CollectorGit
  const collector = new WorkUnitCollector({ store, listSessions: async () => sessions, git, now: () => Date.now() })
  const calls: Rig['calls'] = []
  const notified: string[] = []
  const ignored: Rig['ignored'] = []
  const logs: string[] = []
  const state: Rig['state'] = {
    tracking: true,
    reply: async (cmd) => ({ status: 200, body: cmd === 'work-units-complete' ? { ok: true, recorded: true } : { ok: true } })
  }
  const deps: AppWorkUnitsDeps = {
    store,
    collector,
    tracking: () => state.tracking,
    orchCall: (cmd, args) => {
      calls.push({ cmd, args })
      return state.reply(cmd)
    },
    readFile: () => readWorkUnitsFile(file),
    notify: (r) => notified.push(r),
    goalIgnored: (info) => ignored.push(info),
    log: (m) => logs.push(m),
    ...over
  }
  return { deps, store, collector, sessions, calls, notified, ignored, logs, state }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-work-units-'))
  file = path.join(dir, 'workUnits.json')
  root = path.join(dir, 'proj')
  transcript = path.join(dir, 't1.jsonl')
  await fs.mkdir(root)
  await fs.writeFile(transcript, '', 'utf8')
  // The Host's file: one unit a Host session opened, whose session the app does not run itself.
  await fs.writeFile(file, JSON.stringify({ projects: { [root]: stateOf([hostUnit()]) } }, null, 2), 'utf8')
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(dir, { recursive: true, force: true })
})

describe('createAppWorkUnits: before the greeting decides', () => {
  it('the collector does not start, the file is untouched, and the list reads the file (Review Focus 2)', async () => {
    const m = rig()
    const start = vi.spyOn(m.collector, 'start')
    const before = onDisk()
    const w = createAppWorkUnits(m.deps)
    expect(w.mode()).toBe('undecided')
    expect(await w.list(root)).toEqual([expect.objectContaining({ id: 'wu-host', status: 'active' })])
    await w.trackingChanged(true)
    expect(start).not.toHaveBeenCalled()
    expect(m.calls).toEqual([])
    expect(onDisk()).toBe(before)
  })

  it('a button press before the decision is refused, and nothing is written or sent', async () => {
    const m = rig()
    const before = onDisk()
    const w = createAppWorkUnits(m.deps)
    await expect(w.complete(root, 'wu-host')).rejects.toThrow()
    await expect(w.cancel(root, 'wu-host')).rejects.toThrow()
    expect(m.calls).toEqual([])
    expect(onDisk()).toBe(before)
  })

  it('a startup chain that settled with a Host seen but never greeted decides nothing', async () => {
    const m = rig()
    const start = vi.spyOn(m.collector, 'start')
    const w = createAppWorkUnits(m.deps)
    await w.onStartupSettled(false)
    expect(w.mode()).toBe('undecided')
    expect(start).not.toHaveBeenCalled()
    // Both causes of that answer are named: a peer that never greeted, or the Host wiring failing after it
    // began connecting (startHostClient's outer catch, where onConnect may never have been registered).
    expect(m.logs.filter((l) => l.includes('never greeted') && l.includes('Host wiring failed'))).toHaveLength(1)
  })
})

describe('createAppWorkUnits: in front of a Host that announces work-units', () => {
  it("the collector never starts, also after the startup chain settles, and nothing of the Host's is overwritten (Review Focus 2)", async () => {
    const m = rig()
    const start = vi.spyOn(m.collector, 'start')
    const before = onDisk()
    const w = createAppWorkUnits(m.deps)
    await w.onGreeting(true)
    await w.onStartupSettled(true)
    expect(w.mode()).toBe('reader')
    expect(start).not.toHaveBeenCalled()
    await m.store.settled()
    expect(onDisk()).toBe(before)
  })

  it('list reads the file the Host wrote, matching the key as a path', async () => {
    const m = rig({ platform: 'win32' })
    const w = createAppWorkUnits(m.deps)
    await w.onGreeting(true)
    await hostWrites([hostUnit(), hostUnit({ id: 'wu-2', startedAt: '2026-10-03T10:00:00.000Z', objective: 'second' })])
    expect((await w.list(root)).map((t) => t.id)).toEqual(['wu-2', 'wu-host'])
    expect((await w.list(root.toUpperCase())).map((t) => t.id)).toEqual(['wu-2', 'wu-host'])
    expect(await w.list(path.join(dir, 'other'))).toEqual([])
  })

  it('complete goes to the Host as work-units-complete with the file\'s spelling of the key, and maps its answer as today', async () => {
    const m = rig({ platform: 'win32' })
    const w = createAppWorkUnits(m.deps)
    await w.onGreeting(true)
    expect(await w.complete(root.toUpperCase(), 'wu-host')).toEqual({ recorded: true })
    expect(m.calls).toEqual([{ cmd: 'work-units-complete', args: { projectPath: root, id: 'wu-host' } }])
    m.state.reply = async () => ({ status: 200, body: { ok: true, recorded: false } })
    expect(await w.complete(root, 'wu-host')).toEqual({ recorded: false })
    // The Host does not know the row the file still lists: nothing was closed, so it is not a success.
    m.state.reply = async () => ({ status: 200, body: { ok: false, reason: 'unknown task: wu-host' } })
    await expect(w.complete(root, 'wu-host')).rejects.toThrow('unknown task: wu-host')
    // The row is already gone from the file: what the button wanted is true.
    await hostWrites([])
    expect(await w.complete(root, 'wu-host')).toEqual({ recorded: true })
    m.state.reply = async () => ({ status: 200, body: { ok: false, reason: 'task is completed' } })
    expect(await w.complete(root, 'wu-host')).toEqual({ recorded: true })
    m.state.reply = async () => ({ status: 200, body: { ok: false, reason: 'something else' } })
    await expect(w.complete(root, 'wu-host')).rejects.toThrow('something else')
    // The Host's save of the close was dropped (hostWorkUnits.ts NOT_RECORDED): a failure the person sees,
    // not the "nothing to record" of `recorded: false`.
    const notRecorded = 'not recorded: this Host stopped writing workUnits.json before the close was saved, the task is still open'
    m.state.reply = async () => ({ status: 200, body: { ok: false, reason: notRecorded } })
    await expect(w.complete(root, 'wu-host')).rejects.toThrow(notRecorded)
    m.state.reply = async () => ({ status: 409, body: { error: 'not the work units writer' } })
    await expect(w.complete(root, 'wu-host')).rejects.toThrow('not the work units writer')
  })

  it('cancel goes to the Host as work-units-cancel, and a refusal rejects with its reason', async () => {
    const m = rig()
    const w = createAppWorkUnits(m.deps)
    await w.onGreeting(true)
    await w.cancel(root, 'wu-host')
    expect(m.calls).toEqual([{ cmd: 'work-units-cancel', args: { projectPath: root, id: 'wu-host' } }])
    m.state.reply = async () => ({ status: 200, body: { ok: false, reason: 'task is completed' } })
    await expect(w.cancel(root, 'wu-host')).rejects.toThrow('task is completed')
    m.state.reply = async () => ({ status: 501, body: { error: 'no work-units duty' } })
    await expect(w.cancel(root, 'wu-host')).rejects.toThrow('no work-units duty')
  })

  it('a history-resume fork goes to the Host as work-units-fork, and a refusal is logged', async () => {
    const m = rig()
    const w = createAppWorkUnits(m.deps)
    await w.onGreeting(true)
    w.fork('new-s', transcript)
    w.fork('rolled-s', undefined, 'old-s')
    await vi.waitFor(() => expect(m.calls).toHaveLength(2))
    expect(m.calls).toEqual([
      { cmd: 'work-units-fork', args: { newSessionId: 'new-s', transcriptPath: transcript } },
      { cmd: 'work-units-fork', args: { newSessionId: 'rolled-s', oldSessionId: 'old-s' } }
    ])
    m.state.reply = async () => {
      throw new Error('no Host connection')
    }
    w.fork('x', transcript)
    await vi.waitFor(() => expect(m.logs.some((l) => l.includes('no Host connection'))).toBe(true))
  })

  it('the tracking toggle sends work-units-reload and starts nothing here (Review Focus 5)', async () => {
    const m = rig()
    const start = vi.spyOn(m.collector, 'start')
    const w = createAppWorkUnits(m.deps)
    await w.onGreeting(true)
    await w.trackingChanged(true)
    await w.trackingChanged(false)
    expect(m.calls).toEqual([
      { cmd: 'work-units-reload', args: {} },
      { cmd: 'work-units-reload', args: {} }
    ])
    expect(start).not.toHaveBeenCalled()
    // A reload the Host does not take is logged, not thrown: the setting is saved, and the Host reads
    // it again at the next greeting.
    m.state.reply = async () => ({ status: 409, body: { error: 'not the writer' } })
    await w.trackingChanged(true)
    expect(m.logs.some((l) => l.includes('work-units-reload'))).toBe(true)
  })

  it("the Host's pushes reach the renderer: work-units-state as sessionTasks:changed, goal-ignored as today's notice", () => {
    const m = rig()
    const w = createAppWorkUnits(m.deps)
    w.onHostPush({ t: 'work-units-state', root })
    w.onHostPush({ t: 'work-units-goal-ignored', projectPath: root, objective: 'o', blockingUnitId: 'wu-host' })
    w.onHostPush({ t: 'understanding-state', root })
    expect(m.notified).toEqual([root])
    expect(m.ignored).toEqual([{ projectPath: root, blockingUnitId: 'wu-host' }])
  })

  it('a reader whose Host is gone stays a reader: a press fails, nothing is written here, and a later settle changes nothing', async () => {
    const m = rig()
    const start = vi.spyOn(m.collector, 'start')
    const before = onDisk()
    const w = createAppWorkUnits(m.deps)
    await w.onGreeting(true)
    m.state.reply = async () => {
      throw new Error('no Host connection')
    }
    await expect(w.complete(root, 'wu-host')).rejects.toThrow('no Host connection')
    await w.onStartupSettled(true)
    expect(w.mode()).toBe('reader')
    expect(start).not.toHaveBeenCalled()
    expect(onDisk()).toBe(before)
  })

  it("a Host roll's fork is not sent back to the Host (it re-keyed its own roll); an app roll's still is", async () => {
    const m = rig()
    const w = createAppWorkUnits(m.deps)
    await w.onGreeting(true)
    w.fork('host-new', transcript, 'host-old', true)
    w.fork('app-new', transcript, 'app-old', false)
    await vi.waitFor(() => expect(m.calls).toHaveLength(1))
    // A Host roll held before the decision is dropped at it as well.
    const late = rig()
    const w2 = createAppWorkUnits(late.deps)
    w2.fork('host-new', undefined, 'host-old', true)
    await w2.onGreeting(true)
    await Promise.resolve()
    expect(late.calls).toEqual([])
    expect(m.calls).toEqual([
      { cmd: 'work-units-fork', args: { newSessionId: 'app-new', transcriptPath: transcript, oldSessionId: 'app-old' } }
    ])
  })

  it('a fork made before the decision is sent once the Host is the writer', async () => {
    const m = rig()
    const w = createAppWorkUnits(m.deps)
    w.fork('new-s', transcript)
    expect(m.calls).toEqual([])
    await w.onGreeting(true)
    await vi.waitFor(() => expect(m.calls).toEqual([{ cmd: 'work-units-fork', args: { newSessionId: 'new-s', transcriptPath: transcript } }]))
  })
})

describe('createAppWorkUnits: writer (no Host, or an older Host)', () => {
  it('no Host after the startup chain settles: the store loads, then the collector starts, as today', async () => {
    const m = rig()
    const load = vi.spyOn(m.store, 'load')
    const start = vi.spyOn(m.collector, 'start')
    const w = createAppWorkUnits(m.deps)
    await w.onStartupSettled(true)
    expect(w.mode()).toBe('writer')
    expect(load).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledTimes(1)
    expect(load.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0])
    await m.collector.flush()
    await m.store.settled()
    // Today's seed: a unit whose session is not alive here is interrupted, in this app's file.
    expect(unitsOnDisk()).toEqual([expect.objectContaining({ id: 'wu-host', status: 'interrupted', reason: 'INTERRUPTED_BY_APP_RESTART' })])
    expect(m.calls).toEqual([])
  })

  it('an older Host greeting is a writer decision too; tracking off loads but does not start', async () => {
    const m = rig()
    m.state.tracking = false
    const start = vi.spyOn(m.collector, 'start')
    const w = createAppWorkUnits(m.deps)
    await w.onGreeting(false)
    expect(w.mode()).toBe('writer')
    expect(start).not.toHaveBeenCalled()
    expect(m.collector.listOpen(root).map((t) => t.id)).toEqual(['wu-host'])
    await w.trackingChanged(true)
    expect(start).toHaveBeenCalledTimes(1)
    expect(m.calls).toEqual([])
  })

  it("in front of an older Host, a Host roll's fork is still made locally", async () => {
    const m = rig()
    const fork = vi.spyOn(m.collector, 'onSessionForked')
    const w = createAppWorkUnits(m.deps)
    await w.onGreeting(false)
    w.fork('host-new', undefined, 'host-old', true)
    expect(fork).toHaveBeenCalledWith('host-new', undefined, 'host-old')
    expect(m.calls).toEqual([])
  })

  it('switches in quick succession hold a fork until the latest switch to writer has started the collector', async () => {
    const m = rig()
    const gates: Array<() => void> = []
    const realLoad = m.store.load.bind(m.store)
    vi.spyOn(m.store, 'load').mockImplementation(async () => {
      await new Promise<void>((r) => gates.push(r))
      return realLoad()
    })
    const fork = vi.spyOn(m.collector, 'onSessionForked')
    const w = createAppWorkUnits(m.deps)
    await w.onGreeting(true)
    void w.onGreeting(false) // first switch to writer: load pending
    void w.onGreeting(true)
    const second = w.onGreeting(false) // second switch to writer: load pending
    await vi.waitFor(() => expect(gates).toHaveLength(2))
    gates[0]() // the first switch ends while the second still loads
    await new Promise((r) => setTimeout(r, 20))
    w.fork('new-s', transcript)
    expect(fork).not.toHaveBeenCalled()
    gates[1]()
    await second
    expect(fork).toHaveBeenCalledWith('new-s', transcript, undefined)
  })

  it('reader to writer with the file gone starts from empty, not from what this app held as the writer before', async () => {
    const m = rig()
    const w = createAppWorkUnits(m.deps)
    await w.onGreeting(false)
    m.state.tracking = false
    expect(m.collector.listOpen(root).map((t) => t.id)).toEqual(['wu-host'])
    await w.onGreeting(true)
    await fs.rm(file)
    await w.onGreeting(false)
    expect(await w.list(root)).toEqual([])
  })

  it('list, complete, cancel and fork use the app collector, with the same answers as today', async () => {
    const m = rig()
    m.sessions.push({ sessionId: 's1', projectPath: root, transcriptPath: transcript, idleSignalTrusted: true })
    const fork = vi.spyOn(m.collector, 'onSessionForked')
    const w = createAppWorkUnits(m.deps)
    await w.onStartupSettled(true)
    await m.collector.flush()
    const started = await m.collector.startTask('s1', 'app task')
    expect(started.ok).toBe(true)
    const id = (started as { id: string }).id
    expect((await w.list(root)).map((t) => t.id)).toContain(id)
    await w.cancel(root, id)
    expect((await w.list(root)).map((t) => t.id)).not.toContain(id)
    // Gone already: success, as the IPC handler answered before.
    expect(await w.complete(root, 'no-such')).toEqual({ recorded: true })
    await expect(w.cancel(root, 'no-such')).rejects.toThrow('unknown task')
    w.fork('new-s', transcript, 'old-s')
    expect(fork).toHaveBeenCalledWith('new-s', transcript, 'old-s')
    expect(m.calls).toEqual([])
  })

  it('writer to reader at a greeting is immediate: the collector stops and none of its writes reach the file', async () => {
    const m = rig()
    m.sessions.push({ sessionId: 's1', projectPath: root, transcriptPath: transcript, idleSignalTrusted: true })
    const w = createAppWorkUnits(m.deps)
    await w.onStartupSettled(true)
    await m.collector.flush()
    const started = await m.collector.startTask('s1', 'app task')
    await m.store.settled()
    const before = onDisk()
    expect(unitsOnDisk().find((u) => u.id === (started as { id: string }).id)?.status).toBe('active')
    const stop = vi.spyOn(m.collector, 'stop')
    await w.onGreeting(true)
    expect(w.mode()).toBe('reader')
    expect(stop).toHaveBeenCalledTimes(1)
    await m.collector.flush()
    await m.store.settled()
    // The stop interrupts the open unit in memory, and that write is dropped: the Host continues it.
    expect(onDisk()).toBe(before)
    expect(await m.collector.startTask('s1', 'after')).toEqual({ ok: false, reason: 'work unit tracking is off' })
  })

  it('reader to writer when an older Host greets: the file the Host wrote is reloaded before the collector starts', async () => {
    const m = rig()
    const w = createAppWorkUnits(m.deps)
    await w.onGreeting(true)
    // While this app only read, the Host wrote a second unit.
    await hostWrites([hostUnit(), hostUnit({ id: 'wu-2', sessionId: 'host-s2', objective: 'second' })])
    const load = vi.spyOn(m.store, 'load')
    const start = vi.spyOn(m.collector, 'start')
    await w.onGreeting(false)
    expect(w.mode()).toBe('writer')
    expect(load).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledTimes(1)
    expect(load.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0])
    await m.collector.flush()
    await m.store.settled()
    // Both of the Host's units are in the writer's file (interrupted by today's seed: their sessions are
    // not this app's), none lost to a stale memory.
    expect(unitsOnDisk().map((u) => [u.id, u.status])).toEqual([
      ['wu-host', 'interrupted'],
      ['wu-2', 'interrupted']
    ])
  })
})
