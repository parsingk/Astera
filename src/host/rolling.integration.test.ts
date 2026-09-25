// The S6 rig (plan R2, R7, R25, R31, R32; preflight B2, R5, R13): the Host rolls its sessions with and
// without an app, over the wiring index.ts builds (`composeHostRolling`, spread into `createHostOrch`
// exactly as index.ts spreads it).
//
// **Real:** `createHostOrch` over a temp profile (the real handleCommand, store and `sessionExited`), a real
// `createHostExits` wired to it, and a real `PtyRegistry` over fake ptys. **Fake:** the server (which apps
// are attached and what each yields, and a recorded `broadcast`) and the spawner (its roll spawn opens the
// next pty in the real registry). Fake timers for `setTimeout`/`setInterval`/`Date` only: the store's disk
// I/O stays real, so every assertion on the state goes through `vi.waitFor`.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { composeHostRolling, type HostRollingWiring } from './rollingWiring'
import { createHostOrch } from './orch'
import { createHostExits } from './exits'
import { PtyRegistry, type RegistryPty } from './registry'
import { tempDir } from '../core/worktrees/testRepo'
import { createJob, startJobRun, createTask, openDispatch, attachCoordinator, emptyState, type OrchState } from '../core/orchestration/state'
import { EXIT_DEFER_MS } from '../core/orchestration/exec/exitOwner'
import { ROLL_SNAPSHOT_VERSION, type RollSnapshot } from '../core/rolling/snapshot'
import type { HostMessage } from '../core/host/protocol'
import type { Account, SessionInfo } from '../core/types'

const NOW = '2026-09-25T00:00:00.000Z'
const LIMIT = 'Claude usage limit ' + 'reached ∙ resets 3am' // constraint 14
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) c()
  vi.useRealTimers()
  // A roll's config write lands without anyone awaiting it; give it a real moment before the removal.
  await new Promise((r) => setTimeout(r, 50))
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
const dirs: string[] = []

/** The rolling seams every rig passes: nothing of this machine's accounts, keychain or network is read. */
const quietDeps = (accounts: () => Promise<Account[]>) => ({
  readAccounts: accounts,
  readStrategy: async () => 'original' as const,
  isLoggedIn: async () => true,
  fetchUsage: async () => null,
  copy: async () => {},
  log: () => {},
  logCodex: () => {},
  watchHooks: false
})

async function rig(o: { appPid?: number | null; coordinator?: string; openStop?: boolean; accountsGate?: Promise<void>; accountsFail?: number } = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] })
  const profileDir = await tempDir('astera-s6-rig-')
  dirs.push(profileDir)
  const accounts: Account[] = [
    ...['a1', 'a2'].map((id) => ({ id, label: id, configDir: path.join(profileDir, id), color: '#fff', createdAt: NOW })),
    ...['x1', 'x2'].map((id) => ({ id, label: id, configDir: path.join(profileDir, id), color: '#fff', createdAt: NOW, provider: 'codex' as const }))
  ]
  // One Job, one Run, one Task with an open Dispatch on s1 (and a coordinator slot when asked).
  const job = createJob(emptyState(), { objective: 'o', cwd: profileDir }, NOW); if (!job.ok) throw new Error(job.error)
  const run = startJobRun(job.state, job.value.id, NOW); if (!run.ok) throw new Error(run.error)
  const task = createTask(run.state, { runId: run.value.id, title: 't', spec: 's', deps: [] }, NOW); if (!task.ok) throw new Error(task.error)
  const disp = openDispatch(task.state, { taskId: task.value.id, provider: 'claude', accountId: 'a1', sessionId: 's1', cwd: profileDir, specPath: path.join(profileDir, 's.md') }, NOW)
  if (!disp.ok) throw new Error(disp.error)
  let state: OrchState = disp.state
  if (o.coordinator) { const c = attachCoordinator(state, { runId: run.value.id, sessionId: o.coordinator }); if (!c.ok) throw new Error(c.error); state = c.state }
  if (o.openStop) state = { ...state, dispatches: state.dispatches.map((x) => ({ ...x, resumes: [{ stoppedAt: NOW, reason: 'waiting' as const, fromAccountId: 'a1', resetsAt: NOW }] })) }
  await fs.writeFile(path.join(profileDir, 'orchestration.json'), JSON.stringify(state), 'utf8')

  const ptys = new Map<string, RegistryPty & { emit(d: string): void; exit(c: number): void; typed: string[] }>()
  let opening = ''
  const registry = new PtyRegistry({
    spawn: () => {
      let onData: (d: string) => void = () => {}
      let onExit: (e: { exitCode: number }) => void = () => {}
      const p = { pid: 1, typed: [] as string[], onData: (cb: typeof onData) => { onData = cb }, onExit: (cb: typeof onExit) => { onExit = cb },
        write: (d: string) => { p.typed.push(d) }, resize: () => {}, kill: () => onExit({ exitCode: 1 }), pause: () => {}, resume: () => {},
        emit: (d: string) => onData(d), exit: (c: number) => onExit({ exitCode: c }) }
      ptys.set(opening, p)
      return p
    },
    log: () => {}
  })
  const open = (ptyId: string, sessionId: string, restore: Record<string, unknown>): void => {
    opening = ptyId
    const r = registry.open({ id: ptyId, file: 'x', args: [], opts: { cwd: profileDir, cols: 80, rows: 24, env: {} }, meta: { kind: 'session', id: sessionId, restore } })
    if (!r.ok) throw new Error(r.error)
  }

  let appPid = o.appPid ?? null
  const apps = new Map<number, Set<string>>() // socket → yields
  const broadcasts: HostMessage[] = []
  const server = { hasApp: () => apps.size > 0, yieldsOf: (s: number) => apps.get(s) ?? null, broadcast: (m: HostMessage) => { broadcasts.push(m) } }

  const payloads = new Map<string, unknown>()
  let seq = 1
  const onSpawned: Array<(i: SessionInfo, a: Account) => void> = []
  const onLocated: Array<(s: string, c: string, p: string) => void> = []
  const spawner = {
    prepareRollSpawn: async () => {},
    rollSpawn: (x: { account: Account; cwd: string; rollAccountIds?: string[]; restoreExtra?: Record<string, unknown> }) => {
      const id = `s${++seq}`
      open(`p${seq}`, id, { accountId: x.account.id, cwd: x.cwd, title: 't', rollAccountIds: x.rollAccountIds, ...(x.restoreExtra ?? {}) })
      return { id, accountId: x.account.id, cwd: x.cwd, status: 'running', title: 't', rollAccountIds: x.rollAccountIds } as SessionInfo
    },
    statusLinePayload: async (id: string) => payloads.get(id) ?? null,
    onSpawned: (cb: (i: SessionInfo, a: Account) => void) => { onSpawned.push(cb) },
    onRolloutLocated: (cb: (s: string, c: string, p: string) => void) => { onLocated.push(cb) },
    retarget: () => {},
    isRetiring: () => false
  }
  const afters: Array<() => void> = []
  let reads = 0
  const logs: string[] = []
  // Built first, as index.ts builds it: `orch` and `exits` do not exist yet, and every closure that names
  // them runs only once both do (preflight B2).
  const box: { orch?: ReturnType<typeof createHostOrch>; exits?: ReturnType<typeof createHostExits> } = {}
  const wiring: HostRollingWiring = composeHostRolling({
    profileDir, platform: process.platform, registry, spawner: spawner as never, exits: () => box.exits!, server: () => server,
    orch: () => box.orch!, lang: () => 'en', log: (m) => logs.push(m), nowIso: () => new Date().toISOString(),
    after: (_ms, fn) => { afters.push(fn); return () => { const i = afters.indexOf(fn); if (i >= 0) afters.splice(i, 1) } },
    appPid: () => appPid,
    rollingDeps: quietDeps(async () => {
      await o.accountsGate
      if (reads++ < (o.accountsFail ?? 0)) throw new Error('accounts.json is being written')
      return accounts
    })
  })
  cleanups.push(() => wiring.dispose())
  const orch = createHostOrch({
    profileDir, version: '0.0.0', now: () => new Date().toISOString(), hostStartedAt: () => NOW, runningSessions: () => registry.liveCount(),
    aliveSessionIds: () => new Set(registry.list().filter((e) => e.alive && e.meta?.kind === 'session').map((e) => e.meta!.id)),
    act: async () => {
      throw new Error('the rig’s app answers no act')
    },
    hasApp: () => server.hasApp(), onState: () => {}, log: (m) => logs.push(m),
    sessions: {
      listSessions: async () => [],
      readSession: async () => ({ cols: 80, rows: 24, screen: [], scrollback: [] }),
      sendSession: async () => {},
      readChat: async () => [],
      sendChat: async () => {},
      serial: (_id, run) => run()
    },
    // The spread index.ts makes (the Review Focus 2 test fails without it).
    ...wiring.orchHooks
  })
  box.orch = orch
  const exits = createHostExits({ registry, sessionExited: (e) => orch.sessionExited(e), orphanedSessions: (f) => orch.orphanedSessions(f), log: () => {} })
  box.exits = exits
  // **Not loaded here** (an adaptation of the brief's sketch): the load's restart cleanup closes every open
  // Dispatch whose session is not alive, and no pty is open yet. Each helper that opens a session loads
  // once it is open and answers that load, as the Host's own spawn (inside a command, after `ready()`) or
  // an attached app's state push would have had it loaded before any roll.
  await vi.advanceTimersByTimeAsync(0)
  const payload = (pct: number) => ({ session_id: 'cs', transcript_path: path.join(profileDir, 'a1', 'projects', 'p', 'cs.jsonl'), rate_limits: { five_hour: { used_percentage: pct } } })
  const snapOf = (ids: string[], over: Partial<RollSnapshot>): RollSnapshot => ({ v: ROLL_SNAPSHOT_VERSION, provider: 'claude', accountIds: ids, currentIndex: 0, streak: 0, recovery: ids.map(() => null), blocks: {}, wait: null, inPlaceUsed: false, rolledAt: null, awaitingPrompt: false, claude: { sessionId: 'cs', transcriptPath: null, tailOffset: null, tailSince: null }, writtenAt: Date.now(), ...over })
  return {
    broadcasts,
    logs,
    now: () => Date.now(),
    spawnWorker: (p: string, s: string, ids: string[]) => { open(p, s, { accountId: ids[0], cwd: profileDir, title: 't', rollAccountIds: ids, rolledBy: 'host' }); for (const cb of onSpawned) cb({ id: s, accountId: ids[0], cwd: profileDir, status: 'running', title: 't', rollAccountIds: ids }, accounts.find((a) => a.id === ids[0])!); return orch.ready() },
    /** The spawner's locate found a fresh codex session's rollout (R12). */
    rolloutLocated: (s: string, thread: string, file: string) => { for (const cb of onLocated) cb(s, thread, file) },
    profileDir,
    spawnAppWorker: (p: string, s: string, ids: string[]) => { open(p, s, { accountId: ids[0], cwd: profileDir, title: 't', rollAccountIds: ids, roll: snapOf(ids, {}) }); return orch.ready() },
    openAppSession: (p: string, s: string, ids: string[], over: Partial<RollSnapshot>, x: { withoutSnapshot?: boolean } = {}) => {
      open(p, s, { accountId: ids[0], cwd: profileDir, title: 't', rollAccountIds: ids, ...(x.withoutSnapshot ? {} : { roll: snapOf(ids, over) }) })
      return orch.ready()
    },
    writeSnapshot: (p: string, ids: string[]) => registry.note(p, { roll: snapOf(ids, {}) }),
    tick: async () => { await vi.advanceTimersByTimeAsync(15_000); await vi.waitFor(() => undefined) },
    appRolledBeforeDying: (oldP: string, oldS: string, newP: string, newS: string) => {
      open(newP, newS, { accountId: 'a2', cwd: profileDir, title: 't', rollAccountIds: ['a1', 'a2'], rolledFrom: oldS, roll: snapOf(['a1', 'a2'], { currentIndex: 1, awaitingPrompt: true, rolledAt: Date.now() }) })
      ptys.get(oldP)!.exit(1)
    },
    attachApp: (socket: number, yields: string[], held: string[]) => { apps.set(socket, new Set(yields)); for (const p of held) exits.heldBy(p, socket); wiring.onAppsChanged() },
    detachApp: (socket: number) => { apps.delete(socket); exits.appGone(socket); wiring.onAppsChanged() },
    setAppPid: (p: number | null) => { appPid = p },
    graceEnds: () => { for (const fn of afters.splice(0)) fn() },
    gracesPending: () => afters.length,
    limit: (p: string, s: string) => { payloads.set(s, payload(100)); ptys.get(p)!.emit(LIMIT) },
    statuslineAppears: (s: string) => payloads.set(s, payload(5)),
    forceRoll: (s: string) => void wiring.rolling.forceRoll(s),
    advance: (ms: number) => vi.advanceTimersByTimeAsync(ms),
    settle: async () => { await vi.advanceTimersByTimeAsync(1_000); await vi.waitFor(() => undefined) },
    exitsHandoverRuns: async () => { await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS + 100); await vi.waitFor(() => undefined) },
    dispatch: () => orch.state().dispatches[0],
    run: () => orch.state().runs[0],
    /** `runs wait` over the Run, probed once (timeout 0): its ending now, or `timeout`. */
    runsWait: () => orch.handle('runs-wait', { id: orch.state().runs[0].id, timeoutMs: 0 }),
    note: (p: string) => registry.metaOf(p)?.restore ?? {},
    typedInto: (p: string) => ptys.get(p)?.typed ?? []
  }
}

/** Preflight B2: the wiring is built before the server (and the exits) exist, and building reads neither. */
function composeWithoutServer(): void {
  const registry = new PtyRegistry({ spawn: () => { throw new Error('no spawn here') }, log: () => {} })
  const w = composeHostRolling({
    profileDir: path.join(os.tmpdir(), 'astera-s6-no-server-never-created'),
    platform: process.platform,
    registry,
    spawner: { prepareRollSpawn: async () => {}, rollSpawn: () => { throw new Error('no') }, statusLinePayload: async () => null, onSpawned: () => {}, onRolloutLocated: () => {}, retarget: () => {}, isRetiring: () => false } as never,
    exits: () => undefined as never,
    server: () => undefined as never,
    orch: () => undefined as never,
    lang: () => 'en',
    log: () => {},
    nowIso: () => NOW,
    every: () => () => {},
    after: () => () => {},
    appPid: () => null,
    rollingDeps: quietDeps(async () => [])
  })
  w.dispose()
}

describe('the Host rolls, with and without an app (S6 rig)', () => {
  it('no app: a Host session at its limit rolls, its Dispatch follows, and the app would be told', async () => {
    const h = await rig()
    await h.spawnWorker('p1', 's1', ['a1', 'a2'])
    h.limit('p1', 's1')
    await h.settle()
    await vi.waitFor(() => expect(h.dispatch().sessionId).toBe('s2'))
    expect(h.broadcasts.some((m) => m.t === 'session-rolled' && m.oldSessionId === 's1')).toBe(true)
  })
  it('the session-rolled push names the new session’s pty, so the app can adopt it first (Task 13 carry)', async () => {
    const h = await rig()
    await h.spawnWorker('p1', 's1', ['a1', 'a2'])
    h.limit('p1', 's1')
    await h.settle()
    await vi.waitFor(() => expect(h.broadcasts.some((m) => m.t === 'session-rolled')).toBe(true))
    const rolled = h.broadcasts.find((m) => m.t === 'session-rolled')
    expect(rolled).toMatchObject({ t: 'session-rolled', oldSessionId: 's1', ptyId: 'p2' })
    expect(h.broadcasts.some((m) => m.t === 'roll-state')).toBe(true)
  })
  it('an app that yields rolling holds the pty: the Host still rolls it', async () => {
    const h = await rig()
    await h.spawnWorker('p1', 's1', ['a1', 'a2'])
    h.attachApp(3, ['worktrees', 'dispatch', 'rolling'], ['p1'])
    h.limit('p1', 's1')
    await h.settle()
    await vi.waitFor(() => expect(h.dispatch().sessionId).toBe('s2'))
  })
  it('an older app holds the pty: the Host stays quiet until it leaves (Review Focus 4)', async () => {
    const h = await rig()
    await h.spawnWorker('p1', 's1', ['a1', 'a2'])
    h.attachApp(4, ['worktrees', 'dispatch'], ['p1'])
    h.limit('p1', 's1')
    await h.settle()
    await vi.waitFor(() => expect(h.dispatch().sessionId).toBe('s1'))
    h.detachApp(4)
    h.limit('p1', 's1')
    await h.settle()
    await vi.waitFor(() => expect(h.dispatch().sessionId).toBe('s2'))
  })
  it('takes over an app session once its app is gone, and resumes its planned wait (Q2)', async () => {
    const h = await rig({ appPid: 100 })
    h.attachApp(3, ['worktrees', 'dispatch', 'rolling'], [])
    await h.openAppSession('p9', 't9', ['a1'], { wait: { retryAt: h.now() + 30_000, target: 0, weekly: false } })
    h.detachApp(3)
    h.setAppPid(null)
    h.graceEnds()
    expect(h.note('p9').rolledBy).toBe('host')
    await h.advance(31_000)
    expect(h.typedInto('p9').some((d) => d === '\r')).toBe(true)
  })
  it('takes nothing over before the first accounts read has finished (Task 12 hard carry)', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const h = await rig({ appPid: 100, accountsGate: gate })
    h.attachApp(3, ['worktrees', 'dispatch', 'rolling'], [])
    await h.openAppSession('p9', 't9', ['a1'], {})
    h.detachApp(3)
    h.setAppPid(null)
    h.graceEnds()
    expect(h.note('p9').rolledBy).toBeUndefined() // the gone decision waits on the read, not a tick
    release()
    await h.advance(0)
    await vi.waitFor(() => expect(h.note('p9').rolledBy).toBe('host'))
  })
  it('a failed first accounts read takes nothing over; a later good read lets the next pass run (Task 16 review)', async () => {
    const h = await rig({ appPid: 100, accountsFail: 1 })
    h.attachApp(3, ['worktrees', 'dispatch', 'rolling'], [])
    await h.openAppSession('p9', 't9', ['a1'], {})
    h.detachApp(3)
    h.setAppPid(null)
    h.graceEnds()
    expect(h.note('p9').rolledBy).toBeUndefined() // the read failed: no account would resolve
    expect(h.logs.filter((m) => m.includes('accounts.json was never read'))).toHaveLength(1)
    await h.tick() // the tick reads again, and this time the read succeeds
    expect(h.note('p9').rolledBy).toBe('host')
  })
  it('a takeover restore reports the chain’s native id, and the Dispatch records it (Task 16 review, M11)', async () => {
    const h = await rig({ appPid: 100 })
    h.attachApp(3, ['worktrees', 'dispatch', 'rolling'], [])
    await h.openAppSession('p1', 's1', ['a1'], {}) // the snapshot names claude session 'cs'; the Dispatch is on s1
    h.detachApp(3)
    h.setAppPid(null)
    h.graceEnds()
    expect(h.note('p1').rolledBy).toBe('host')
    await vi.waitFor(() => expect(h.dispatch().nativeSessionId).toBe('cs'))
  })
  it('a codex session the spawner located is mapped: its thread id reaches the note and the Dispatch (Task 16 review, M14)', async () => {
    const h = await rig()
    await h.spawnWorker('p1', 's1', ['x1', 'x2'])
    h.rolloutLocated('s1', 'thread-1', path.join(h.profileDir, 'x1', 'sessions', 'rollout-thread-1.jsonl'))
    expect(h.note('p1').nativeSessionId).toBe('thread-1')
    await vi.waitFor(() => expect(h.dispatch().nativeSessionId).toBe('thread-1'))
  })
  it('a dropped socket whose app lives takes nothing, however long it stays away (Review Focus 1)', async () => {
    const h = await rig({ appPid: 100 })
    h.attachApp(3, ['worktrees', 'dispatch', 'rolling'], [])
    await h.openAppSession('p9', 't9', ['a1'], {})
    h.detachApp(3)
    h.graceEnds()
    await h.advance(60_000)
    expect(h.note('p9').rolledBy).toBeUndefined()
    h.attachApp(5, ['worktrees', 'dispatch', 'rolling'], ['p9'])
    await h.advance(60_000)
    expect(h.note('p9').rolledBy).toBeUndefined()
  })
  it('an app that died mid-roll: the Dispatch is rekeyed, not closed, and the new session gets its prompt (Review Focus 2)', async () => {
    const h = await rig({ appPid: 100 })
    await h.spawnAppWorker('p1', 's1', ['a1', 'a2']) // the Dispatch names s1
    h.attachApp(3, ['worktrees', 'dispatch', 'rolling'], ['p1'])
    h.appRolledBeforeDying('p1', 's1', 'p2', 's2') // p1 exited; p2 born with rolledFrom s1, awaitingPrompt
    h.detachApp(3)
    h.setAppPid(null)
    await h.exitsHandoverRuns() // the 3 s sweep: s1 ended, p2 names it as rolledFrom
    await vi.waitFor(() => expect(h.dispatch().sessionId).toBe('s2'))
    await vi.waitFor(() => expect(h.dispatch().endedAt).toBeUndefined())
    h.graceEnds()
    h.statuslineAppears('s2')
    await h.advance(2_000)
    // The handover text is built over real git and disk (buildResumePacket), so it lands in real time.
    await vi.waitFor(() => expect(h.typedInto('p2').length).toBeGreaterThan(0), { timeout: 10_000 })
  })
  it('a respawned coordinator keeps its slot across a Host roll (R14)', async () => {
    const h = await rig({ coordinator: 'c1' })
    await h.spawnWorker('pc', 'c1', ['a1', 'a2']) // two accounts, so the forced limit respawns rather than waits
    h.statuslineAppears('c1') // a roll needs the session's own metadata (the rig's adaptation)
    h.forceRoll('c1')
    await h.settle()
    // Preflight C5: one exact check. The rig's fake spawner names the respawn s2.
    await vi.waitFor(() => expect(h.run().coordinatorSessionId).toBe('s2'))
  })
  it('a restored wait is not recorded as a second stop (preflight R5)', async () => {
    const h = await rig({ appPid: 100, openStop: true }) // the Dispatch on s1 already has the app's open stop
    h.attachApp(3, ['worktrees', 'dispatch', 'rolling'], [])
    await h.openAppSession('p1', 's1', ['a1'], { wait: { retryAt: h.now() + 60_000, target: 0, weekly: false } })
    h.detachApp(3)
    h.setAppPid(null)
    h.graceEnds()
    await h.settle()
    await vi.waitFor(() => expect(h.note('p1').rolledBy).toBe('host'))
    expect(h.dispatch().resumes).toHaveLength(1)
  })
  it('a restored wait that resumes in place closes the app’s stop, so runs wait stops ending limited (final review I1)', async () => {
    const h = await rig({ appPid: 100, openStop: true }) // the app recorded the stop, then went away
    h.attachApp(3, ['worktrees', 'dispatch', 'rolling'], [])
    await h.openAppSession('p1', 's1', ['a1'], { wait: { retryAt: h.now() + 30_000, target: 0, weekly: false } })
    h.detachApp(3)
    h.setAppPid(null)
    h.graceEnds()
    await vi.waitFor(() => expect(h.note('p1').rolledBy).toBe('host'))
    // While the worker waits, `runs wait` rightly ends limited.
    expect((await h.runsWait()).body).toMatchObject({ state: 'limited' })
    await h.advance(31_000)
    // Resumed in place, same session. The update line is built from the Dispatch's packet on disk
    // first, so the Enter lands after real I/O.
    await vi.waitFor(() => expect(h.typedInto('p1').some((d) => d === '\r')).toBe(true))
    await vi.waitFor(() => expect(h.dispatch().resumes?.[0].resumedAt).toBeDefined())
    expect(h.dispatch().resumes).toHaveLength(1)
    expect(h.dispatch().resumes?.[0].toAccountId).toBe('a1')
    // The worker works again: `runs wait` keeps waiting instead of ending limited on a past reset.
    expect((await h.runsWait()).body).toMatchObject({ state: 'timeout' })
  })
  it('a session skipped at the gone decision is taken on a later tick (preflight R13)', async () => {
    const h = await rig({ appPid: 100 })
    h.attachApp(3, ['worktrees', 'dispatch', 'rolling'], [])
    await h.openAppSession('p9', 't9', ['a1'], {}, { withoutSnapshot: true })
    h.detachApp(3)
    h.setAppPid(null)
    h.graceEnds()
    expect(h.note('p9').rolledBy).toBeUndefined() // no snapshot yet: skipped
    h.writeSnapshot('p9', ['a1'])
    await h.tick()
    expect(h.note('p9').rolledBy).toBe('host')
  })
  it('nothing fires once the wiring is disposed: no takeover after retire starts (carry 5)', async () => {
    const h = await rig({ appPid: 100 })
    h.attachApp(3, ['worktrees', 'dispatch', 'rolling'], [])
    await h.openAppSession('p9', 't9', ['a1'], {})
    h.detachApp(3)
    h.setAppPid(null)
    for (const c of cleanups.splice(0)) c() // the wiring's dispose, as leave() calls it
    expect(h.gracesPending()).toBe(0) // the watch's grace is cancelled
    expect(vi.getTimerCount()).toBe(0) // and the 15 s tick is stopped
    h.graceEnds()
    await h.tick()
    expect(h.note('p9').rolledBy).toBeUndefined()
  })
  it('composes before the server exists, as index.ts does (preflight B2)', () => {
    expect(() => composeWithoutServer()).not.toThrow()
  })
})
