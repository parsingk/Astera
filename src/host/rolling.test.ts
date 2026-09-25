import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PtyRegistry, type RegistryPty } from './registry'
import { createHostRolling, type HostRollEvent, type RollSpawnOpts } from './rolling'
import { hostRollConfigPath, readRollConfigKey } from '../core/rolling/config'
import type { RollSnapshot } from '../core/rolling/snapshot'
import type { Account, RateLimitPeak, SessionInfo } from '../core/types'

// The chat chain harness below reads the deps createHostRolling hands the claude coordinator; the class
// itself stays the real one, so every other test in this file runs as before.
const captured = vi.hoisted(() => ({ deps: [] as unknown[] }))
vi.mock('../core/rolling/claudeCoordinator', async (orig) => {
  const m = await orig<typeof import('../core/rolling/claudeCoordinator')>()
  class Recording extends m.RollingCoordinator {
    constructor(d: ConstructorParameters<typeof m.RollingCoordinator>[0]) {
      super(d)
      captured.deps.push(d)
    }
  }
  return { ...m, RollingCoordinator: Recording }
})

const LIMIT = 'Claude usage limit ' + 'reached ∙ resets 3am' // constraint 14: never one literal
const cfg = (id: string): string => path.join(os.tmpdir(), 'astera-hr', id)
const accounts: Account[] = [
  { id: 'a1', label: 'A', configDir: cfg('a1'), color: '#fff', createdAt: '2026-09-25T00:00:00Z' },
  { id: 'a2', label: 'B', configDir: cfg('a2'), color: '#fff', createdAt: '2026-09-25T00:00:00Z' }
]
const codexAccounts: Account[] = [
  { id: 'c1', label: 'C', configDir: cfg('c1'), color: '#fff', createdAt: '2026-09-25T00:00:00Z', provider: 'codex' },
  { id: 'c2', label: 'D', configDir: cfg('c2'), color: '#fff', createdAt: '2026-09-25T00:00:00Z', provider: 'codex' }
]

const fakePty = (): RegistryPty & { emit(d: string): void; exit(c: number): void; killed: boolean } => {
  let onData: (d: string) => void = () => {}
  let onExit: (e: { exitCode: number }) => void = () => {}
  const p = {
    pid: 1,
    killed: false,
    onData: (cb: (d: string) => void) => { onData = cb },
    onExit: (cb: (e: { exitCode: number }) => void) => { onExit = cb },
    write: () => {},
    resize: () => {},
    kill: () => { p.killed = true; onExit({ exitCode: 1 }) },
    pause: () => {},
    resume: () => {},
    emit: (d: string) => onData(d),
    exit: (c: number) => onExit({ exitCode: c })
  }
  return p
}

const profiles: string[] = []
afterEach(async () => {
  // A roll's persistConfig writes host/rolling.json without anyone awaiting it; give that write a real
  // moment to land, so the removal neither races it (ENOTEMPTY) nor is undone by it.
  vi.useRealTimers()
  await new Promise((r) => setTimeout(r, 50))
  for (const p of profiles.splice(0)) await fs.rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

type Over = {
  mayAct?: (pty: string) => boolean
  prepare?: () => Promise<void>
  fetchUsage?: (configDir: string) => Promise<RateLimitPeak | null>
  statusLinePayload?: (id: string) => Promise<unknown>
  resumeText?: () => Promise<string | null>
  isLoggedIn?: () => Promise<boolean>
  onNativeSession?: (sessionId: string, nativeSessionId: string) => void
  readAccounts?: () => Promise<Account[]>
}
const rig = async (over: Over = {}) => {
  // Preflight C8: a profile per rig, removed after the test (the Host writes host/rolling.json there).
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-hr-'))
  profiles.push(profileDir)
  const ptys = new Map<string, ReturnType<typeof fakePty>>()
  let opening = ''
  const registry = new PtyRegistry({ spawn: () => { const p = fakePty(); ptys.set(opening, p); return p }, log: () => {} })
  const open = (ptyId: string, sessionId: string, restore: Record<string, unknown>): void => {
    opening = ptyId
    const r = registry.open({ id: ptyId, file: 'x', args: [], opts: { cwd: os.tmpdir(), cols: 80, rows: 24, env: {} }, meta: { kind: 'session', id: sessionId, restore } })
    if (!r.ok) throw new Error(r.error)
  }
  const payloads = new Map<string, unknown>()
  const spawned: RollSpawnOpts[] = []
  const events: HostRollEvent[] = []
  const rolled: string[] = []
  let seq = 1
  const rolling = createHostRolling({
    profileDir,
    platform: process.platform,
    registry,
    spawner: {
      prepareRollSpawn: async () => { await over.prepare?.() },
      rollSpawn: (o) => {
        spawned.push(o)
        const id = `s${++seq}`
        open(`p${seq}`, id, { accountId: o.account.id, cwd: o.cwd, title: 't', rollAccountIds: o.rollAccountIds, ...(o.restoreExtra ?? {}) })
        return { id, accountId: o.account.id, cwd: o.cwd, status: 'running', title: 't', rollAccountIds: o.rollAccountIds, resumeSessionId: o.resumeSessionId } as SessionInfo
      },
      statusLinePayload: over.statusLinePayload ?? (async (id) => payloads.get(id) ?? null)
    },
    mayAct: over.mayAct ?? (() => true),
    tap: { onRolled: async (old, info) => { rolled.push(`${old}->${info.id}`) }, onRollState: () => {} },
    resumeText: over.resumeText ?? (async () => null),
    onNativeSession: over.onNativeSession ?? (() => {}),
    onEvent: (e) => events.push(e),
    lang: () => 'en',
    readAccounts: over.readAccounts ?? (async () => [...accounts, ...codexAccounts]),
    readStrategy: async () => 'original',
    isLoggedIn: over.isLoggedIn ?? (async () => true),
    fetchUsage: over.fetchUsage ?? (async () => null), // no network in a unit test; null is "unavailable"
    copy: async () => {}, // no transcript on disk here; the copy is the coordinators' own, tested there
    log: () => {},
    logCodex: () => {},
    watchHooks: false
  })
  return { profileDir, registry, ptys, open, payloads, spawned, events, rolled, rolling }
}

const info = (id: string, accountId = 'a1'): SessionInfo => ({ id, accountId, cwd: os.tmpdir(), status: 'running', title: 't', rollAccountIds: ['a1', 'a2'] })
const payload = (pct: number) => ({ session_id: 'cs', transcript_path: path.join(cfg('a1'), 'projects', 'p', 'cs.jsonl'), rate_limits: { five_hour: { used_percentage: pct } } })

beforeEach(() => vi.useFakeTimers())

describe('createHostRolling (S6 Task 9)', () => {
  it('rolls a Host session at its limit: kills the old pty, respawns marked and with rolledFrom, taps and tells', async () => {
    const r = await rig()
    await r.rolling.refresh()
    r.open('p1', 's1', { accountId: 'a1', cwd: os.tmpdir(), title: 't', rollAccountIds: ['a1', 'a2'] })
    r.rolling.adoptSpawned(info('s1'), accounts[0])
    r.payloads.set('s1', payload(100))
    r.ptys.get('p1')!.emit(LIMIT)
    await vi.advanceTimersByTimeAsync(100)
    expect(r.ptys.get('p1')!.killed).toBe(true)
    expect(r.spawned).toHaveLength(1)
    expect(r.spawned[0].account.id).toBe('a2')
    expect(r.spawned[0].restoreExtra).toMatchObject({ rolledBy: 'host', rolledFrom: 's1' })
    expect(r.rolled).toEqual(['s1->s2'])
    expect(r.events.some((e) => e.t === 'session-rolled' && e.oldSessionId === 's1' && e.info.id === 's2')).toBe(true)
    expect(r.events.some((e) => e.t === 'roll-state' && e.event.state === 'switching')).toBe(true)
    r.rolling.dispose()
  })

  it('keeps a chain quiet for a pty mayAct refuses (Review Focus 4)', async () => {
    let may = false
    const r = await rig({ mayAct: () => may })
    await r.rolling.refresh()
    r.open('p1', 's1', { accountId: 'a1', cwd: os.tmpdir(), title: 't', rollAccountIds: ['a1', 'a2'] })
    r.rolling.adoptSpawned(info('s1'), accounts[0])
    r.payloads.set('s1', payload(100))
    r.ptys.get('p1')!.emit(LIMIT)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(r.spawned).toHaveLength(0)
    may = true
    r.ptys.get('p1')!.emit(LIMIT)
    await vi.advanceTimersByTimeAsync(100)
    expect(r.spawned).toHaveLength(1)
    r.rolling.dispose()
  })

  it('a refused respawn leaves the old pty alive (Review Focus 3)', async () => {
    const r = await rig({ prepare: async () => { throw new Error('the Host is retiring') } })
    await r.rolling.refresh()
    r.open('p1', 's1', { accountId: 'a1', cwd: os.tmpdir(), title: 't', rollAccountIds: ['a1', 'a2'] })
    r.rolling.adoptSpawned(info('s1'), accounts[0])
    r.payloads.set('s1', payload(100))
    r.ptys.get('p1')!.emit(LIMIT)
    await vi.advanceTimersByTimeAsync(100)
    expect(r.ptys.get('p1')!.killed).toBe(false)
    expect(r.spawned).toHaveLength(0)
    expect(r.events.some((e) => e.t === 'roll-state' && e.event.state === 'waiting')).toBe(true)
    r.rolling.dispose()
  })

  it('asks the account for its usage, and a lookup under the limit rejects the phrase (preflight R1)', async () => {
    const asked: string[] = []
    const r = await rig({ fetchUsage: async (dir) => { asked.push(dir); return { percent: 40, resetsAt: null, weekly: false } } })
    await r.rolling.refresh()
    r.open('p1', 's1', { accountId: 'a1', cwd: os.tmpdir(), title: 't', rollAccountIds: ['a1', 'a2'] })
    r.rolling.adoptSpawned(info('s1'), accounts[0])
    r.payloads.set('s1', payload(100))
    r.ptys.get('p1')!.emit(LIMIT)
    await vi.advanceTimersByTimeAsync(100)
    expect(asked).toEqual([accounts[0].configDir])
    expect(r.spawned).toHaveLength(0)
    r.rolling.dispose()
  })

  it('no dependency that rejects becomes an unhandled rejection (preflight R3)', async () => {
    const seen: unknown[] = []
    const on = (e: unknown): void => { seen.push(e) }
    process.on('unhandledRejection', on)
    try {
      const boom = async (): Promise<never> => { throw new Error('boom') }
      const r = await rig({ fetchUsage: boom, statusLinePayload: boom, resumeText: boom, isLoggedIn: boom, prepare: boom })
      await r.rolling.refresh()
      r.open('p1', 's1', { accountId: 'a1', cwd: os.tmpdir(), title: 't', rollAccountIds: ['a1', 'a2'] })
      r.rolling.adoptSpawned(info('s1'), accounts[0])
      r.ptys.get('p1')!.emit(LIMIT)
      await vi.advanceTimersByTimeAsync(40_000) // the limit path, two ticks, the login refresh
      await Promise.resolve()
      expect(seen).toEqual([])
      r.rolling.dispose()
    } finally {
      process.off('unhandledRejection', on)
    }
  })

  it('a late exit from an old pty of a session live in another pty leaves its chain (fix round 1)', async () => {
    const r = await rig()
    await r.rolling.refresh()
    r.open('p1', 's1', { accountId: 'a1', cwd: os.tmpdir(), title: 't', rollAccountIds: ['a1', 'a2'] })
    r.rolling.adoptSpawned(info('s1'), accounts[0])
    r.open('p9', 's1', { accountId: 'a2', cwd: os.tmpdir(), title: 't', rollAccountIds: ['a1', 'a2'] })
    r.ptys.get('p1')!.exit(1)
    expect(r.rolling.has('s1')).toBe(true)
    r.ptys.get('p9')!.exit(0)
    expect(r.rolling.has('s1')).toBe(false)
    r.rolling.dispose()
  })

  it('a codex roll notes the copy it resumes on, and the thread id, on the new pty', async () => {
    const r = await rig()
    await r.rolling.refresh()
    const rollout = path.join(os.tmpdir(), `astera-hr-rollout-${process.pid}.jsonl`)
    await fs.writeFile(rollout, '')
    r.open('p1', 's1', { accountId: 'c1', cwd: os.tmpdir(), title: 't', rollAccountIds: ['c1', 'c2'] })
    r.rolling.adoptSpawned({ ...info('s1', 'c1'), rollAccountIds: ['c1', 'c2'] }, codexAccounts[0])
    r.rolling.attachFresh('s1', 'thread-1', rollout)
    await r.rolling.forceRoll('s1')
    await vi.advanceTimersByTimeAsync(100)
    const note = r.registry.metaOf('p2')?.restore ?? {}
    expect(note.codexSessionId).toBe('thread-1')
    expect(typeof note.rolloutPath).toBe('string')
    await fs.rm(rollout, { force: true })
    r.rolling.dispose()
  })

  it('writes the native session id into the note, so a returning app’s history guard can see it', async () => {
    const r = await rig()
    await r.rolling.refresh()
    r.open('p1', 's1', { accountId: 'a1', cwd: os.tmpdir(), title: 't', rollAccountIds: ['a1', 'a2'] })
    r.rolling.adoptSpawned(info('s1'), accounts[0])
    r.payloads.set('s1', payload(10))
    await vi.advanceTimersByTimeAsync(16_000)
    expect(r.registry.metaOf('p1')?.restore.nativeSessionId).toBe('cs')
    r.rolling.dispose()
  })

  it('a second adoptSpawned of the same session is a no-op, so the chain keeps its timers (fix round 1)', async () => {
    const r = await rig()
    await r.rolling.refresh()
    r.open('p1', 's1', { accountId: 'a1', cwd: os.tmpdir(), title: 't', rollAccountIds: ['a1', 'a2'] })
    r.rolling.adoptSpawned(info('s1'), accounts[0])
    r.payloads.set('s1', payload(100))
    r.ptys.get('p1')!.emit(LIMIT)
    await vi.advanceTimersByTimeAsync(100)
    expect(r.spawned).toHaveLength(1) // rolled to s2 on a2
    // The rolled session handed to adoptSpawned again (a late onSpawned, say) must not start a new chain
    // over the live one, which sits at index 1 with its own timers.
    const timers = vi.getTimerCount()
    r.rolling.adoptSpawned(info('s2', 'a2'), accounts[1])
    expect(vi.getTimerCount()).toBe(timers)
    expect(r.rolling.stateOf('s2')?.state).toBe('switching')
    r.rolling.dispose()
  })

  it('feeds only session ptys, and a session exit disposes its chain', async () => {
    const r = await rig()
    await r.rolling.refresh()
    r.open('p1', 's1', { accountId: 'a1', cwd: os.tmpdir(), title: 't', rollAccountIds: ['a1', 'a2'] })
    r.rolling.adoptSpawned(info('s1'), accounts[0])
    expect(r.rolling.has('s1')).toBe(true)
    r.ptys.get('p1')!.exit(0)
    expect(r.rolling.has('s1')).toBe(false)
    r.rolling.dispose()
  })
})

describe('HostRolling.restore wiring (S6 Task 12, carry C-a)', () => {
  const base = (provider: 'claude' | 'codex', ids: string[]): Omit<RollSnapshot, 'claude' | 'codex'> => ({
    v: 1, provider, accountIds: ids, currentIndex: 0, streak: 0, recovery: ids.map(() => null), blocks: {},
    wait: null, inPlaceUsed: false, rolledAt: null, awaitingPrompt: false, writtenAt: Date.now()
  })

  it('a taken-over claude chain reports its native session and writes its roll config into the Host file', async () => {
    vi.useRealTimers() // the config write is real file I/O, awaited below
    const natives: string[] = []
    const r = await rig({ onNativeSession: (s, n) => natives.push(`${s}=${n}`) })
    await r.rolling.refresh()
    r.open('p1', 's1', { accountId: 'a1', cwd: os.tmpdir(), title: 't', rollAccountIds: ['a1', 'a2'] })
    const snap: RollSnapshot = {
      ...base('claude', ['a1', 'a2']),
      claude: { sessionId: 'cs-1', transcriptPath: null, tailOffset: null, tailSince: null }
    }
    expect(r.rolling.restore(info('s1'), snap)).toBe(true)
    expect(natives).toEqual(['s1=cs-1'])
    await vi.waitFor(async () => {
      expect(await readRollConfigKey(hostRollConfigPath(r.profileDir), 'cs-1')).toMatchObject({ accountIds: ['a1', 'a2'] })
    })
    r.rolling.dispose()
  })

  it('a taken-over codex chain mapped from its snapshot does the same under its thread id', async () => {
    vi.useRealTimers()
    const natives: string[] = []
    const r = await rig({ onNativeSession: (s, n) => natives.push(`${s}=${n}`) })
    await r.rolling.refresh()
    r.open('p1', 's1', { accountId: 'c1', cwd: os.tmpdir(), title: 't', rollAccountIds: ['c1', 'c2'] })
    const snap: RollSnapshot = {
      ...base('codex', ['c1', 'c2']),
      codex: { sessionId: 'thread-1', rolloutPath: path.join(os.tmpdir(), 'astera-hr-none.jsonl'), tailOffset: 0, state: null }
    }
    expect(r.rolling.restore({ ...info('s1', 'c1'), rollAccountIds: ['c1', 'c2'] }, snap)).toBe(true)
    expect(natives).toEqual(['s1=thread-1'])
    await vi.waitFor(async () => {
      expect(await readRollConfigKey(hostRollConfigPath(r.profileDir), 'thread-1')).toMatchObject({ accountIds: ['c1', 'c2'] })
    })
    r.rolling.dispose()
  })
  it('accountsRead answers whether a read of accounts.json ever succeeded (Task 16 review)', async () => {
    let fail = true
    const r = await rig({ readAccounts: async () => { if (fail) throw new Error('mid-write'); return accounts } })
    expect(r.rolling.accountsRead()).toBe(false)
    await r.rolling.refresh()
    expect(r.rolling.accountsRead()).toBe(false)
    fail = false
    await r.rolling.refresh()
    expect(r.rolling.accountsRead()).toBe(true)
    fail = true
    await r.rolling.refresh() // the last good read stands (R23)
    expect(r.rolling.accountsRead()).toBe(true)
    r.rolling.dispose()
  })
})

describe('createHostRolling — chat chains (chat takeover, lifts R20)', () => {
  type Deps = {
    write(id: string, d: string): void
    kill(id: string): void
    mayAct(id: string): boolean
    spawn(o: RollSpawnOpts): SessionInfo
    send(channel: 'session:rolled' | 'session:rollState', payload: unknown): void
  }
  const harness = (over: { chats: unknown; chatMayAct: (p: string) => boolean }) => {
    const spawned: RollSpawnOpts[] = []
    const events: HostRollEvent[] = []
    const registry = new PtyRegistry({ spawn: () => fakePty(), log: () => {} })
    const before = captured.deps.length
    const rolling = createHostRolling({
      profileDir: path.join(os.tmpdir(), 'astera-hr-chat-never-created'),
      platform: process.platform,
      registry,
      spawner: {
        prepareRollSpawn: async () => {},
        rollSpawn: (o) => { spawned.push(o); throw new Error('a chat chain must never reach the pty spawner') },
        statusLinePayload: async () => null
      },
      mayAct: () => true,
      tap: { onRolled: async () => {}, onRollState: () => {} },
      resumeText: async () => null,
      onNativeSession: () => {},
      onEvent: (e) => events.push(e),
      lang: () => 'en',
      readAccounts: async () => accounts,
      readStrategy: async () => 'original',
      isLoggedIn: async () => true,
      fetchUsage: async () => null,
      copy: async () => {},
      log: () => {},
      logCodex: () => {},
      watchHooks: false,
      chats: over.chats as never,
      chatMayAct: over.chatMayAct
    })
    const deps = captured.deps[before] as Deps
    disposers.push(() => rolling.dispose())
    return {
      accounts,
      spawned,
      events,
      writeDep: (id: string, d: string) => deps.write(id, d),
      killDep: (id: string) => deps.kill(id),
      mayActDep: (id: string) => deps.mayAct(id),
      spawnDep: (o: RollSpawnOpts) => deps.spawn(o),
      sendDep: (channel: 'session:rolled' | 'session:rollState', payload: unknown) => deps.send(channel, payload)
    }
  }
  const disposers: Array<() => void> = []
  afterEach(() => { for (const d of disposers.splice(0)) d() })
  const fakeChats = (open = false) => ({
    has: (id: string) => id === 'c1', procOf: () => 'p1', info: () => null, spawn: vi.fn(() => ({ id: 'c2', accountId: 'a2', cwd: 'D:/p', status: 'running', title: 't', kind: 'chat' }) as SessionInfo),
    started: vi.fn(async () => {}), kill: vi.fn(), deliver: vi.fn(), hasOpenRequest: () => open,
    chosenModelOf: () => 'opus', bypassedOf: () => false, subscribe: () => () => {}
  })
  it('routes a chat chain’s write through the writer, drops the Enter, and kills through chats', () => {
    const chats = fakeChats()
    const h = harness({ chats, chatMayAct: () => true })
    h.writeDep('c1', 'carry on')
    h.writeDep('c1', '\r')
    h.killDep('c1')
    expect(chats.deliver.mock.calls).toEqual([['c1', 'carry on']])
    expect(chats.kill).toHaveBeenCalledWith('c1')
  })
  it('quiets a chat chain while a prompt is open or a holder did not yield chat-takeover', () => {
    expect(harness({ chats: fakeChats(true), chatMayAct: () => true }).mayActDep('c1')).toBe(false)
    expect(harness({ chats: fakeChats(false), chatMayAct: () => false }).mayActDep('c1')).toBe(false)
    expect(harness({ chats: fakeChats(false), chatMayAct: () => true }).mayActDep('c1')).toBe(true)
  })
  it('spawns a chat respawn through chats with the session’s own bypass, never the settings', () => {
    const chats = fakeChats()
    const h = harness({ chats, chatMayAct: () => true })
    h.spawnDep({ kind: 'chat', account: h.accounts[1], cwd: 'D:/p', resumeSessionId: 'th', restoreExtra: { rolledFrom: 'c1', roll: {} as never } })
    expect(chats.spawn).toHaveBeenCalledWith(expect.objectContaining({ bypassPermissions: false, resumeSessionId: 'th', restoreExtra: expect.objectContaining({ rolledBy: 'host' }) }))
    // Task 5 review hard carry: a chat chain never opens a pty.
    expect(h.spawned).toHaveLength(0)
  })
  it('does not announce a chat roll whose new proc ended before it started (review M2)', async () => {
    const chats = { ...fakeChats(), has: (id: string) => id === 'c1' || id === 'c2', procOf: (id: string) => (id === 'c2' ? null : 'p1') }
    const h = harness({ chats, chatMayAct: () => true })
    h.sendDep('session:rolled', { oldSessionId: 'c1', info: { id: 'c2', accountId: 'a2', cwd: 'D:/p', status: 'running', title: 't', kind: 'chat' } })
    await vi.waitFor(() => expect(chats.started).toHaveBeenCalledWith('c2'))
    await Promise.resolve()
    await Promise.resolve()
    expect(h.events.filter((e) => e.t === 'session-rolled')).toEqual([])
  })
  it('announces a chat roll only once the new proc has started (P5)', async () => {
    let started: () => void = () => {}
    const chats = { ...fakeChats(), has: (id: string) => id === 'c1' || id === 'c2', started: vi.fn(() => new Promise<void>((r) => { started = r })) }
    const h = harness({ chats, chatMayAct: () => true })
    h.sendDep('session:rolled', { oldSessionId: 'c1', info: { id: 'c2', accountId: 'a2', cwd: 'D:/p', status: 'running', title: 't', kind: 'chat' } })
    await Promise.resolve()
    expect(chats.started).toHaveBeenCalledWith('c2')
    expect(h.events.filter((e) => e.t === 'session-rolled')).toEqual([])
    started()
    await vi.waitFor(() => expect(h.events.filter((e) => e.t === 'session-rolled')).toHaveLength(1))
  })
})
