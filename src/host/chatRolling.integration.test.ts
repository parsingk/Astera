// The chat rig (chat takeover spec §5, Task 6): the Host rolls a conversation-window session it took over
// from a gone app, over the wiring index.ts builds (`composeHostRolling`). Its scaffold is the S6 rig's
// (rolling.integration.test.ts): a temp profile, the real `createHostOrch` and `createHostExits`, the fake
// server with `apps` and `broadcasts`, the fake spawner, `afters` and `quietDeps`. What differs: a real
// `ProcRegistry` over fake claude stream-json processes and a real `createProcHolders()` go in, the fake
// server's `act` records its calls and answers `{ sent: true }`, and the transcript lookup finds nothing.
//
// Fake timers for `setTimeout`/`setInterval`/`Date` only: the store's disk I/O stays real.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { composeHostRolling, type HostRollingWiring } from './rollingWiring'
import { createHostOrch } from './orch'
import { createHostExits } from './exits'
import { PtyRegistry, type RegistryPty } from './registry'
import { ProcRegistry, type RegistryProc } from './procRegistry'
import { createProcHolders } from './procHolders'
import { tempDir } from '../core/worktrees/testRepo'
import { emptyState } from '../core/orchestration/state'
import { ROLL_SNAPSHOT_VERSION } from '../core/rolling/snapshot'
import { HOST_YIELD_CHAT_TAKEOVER, HOST_YIELD_ROLLING, type HostMessage } from '../core/host/protocol'
import * as F from '../core/chat/claudeFixtures'
import type { Account, SessionInfo } from '../core/types'

const NOW = '2026-09-26T00:00:00.000Z'
const cleanups: Array<() => Promise<void> | void> = []
const dirs: string[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) c()
  vi.useRealTimers()
  await new Promise((r) => setTimeout(r, 50))
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** The rolling seams every rig passes: nothing of this machine's accounts, keychain or network is read. */
const quietDeps = (accounts: () => Promise<Account[]>) => ({
  readAccounts: accounts,
  readStrategy: async () => 'original' as const,
  isLoggedIn: async () => true,
  fetchUsage: async () => null,
  copy: async () => {},
  log: () => {},
  logCodex: () => {},
  watchHooks: false,
  findTranscript: async () => null
})

type FakeChat = RegistryProc & { sent: Array<Record<string, unknown>>; say(o: unknown): void; killed: boolean }
/** A claude stream-json process: answers `initialize` and records every frame it is sent. */
function fakeClaude(pid: number): FakeChat {
  let onData: (c: string) => void = () => {}
  let onExit: (e: { exitCode: number }) => void = () => {}
  const p: FakeChat = {
    pid, sent: [], killed: false,
    onData: (cb) => { onData = cb },
    onExit: (cb) => { onExit = cb },
    write: (d) => {
      for (const line of d.split('\n').filter(Boolean)) {
        const f = JSON.parse(line) as { type: string; request_id?: string; request?: { subtype?: string } }
        p.sent.push(f as Record<string, unknown>)
        if (f.type === 'control_request' && f.request?.subtype === 'initialize')
          queueMicrotask(() => p.say({ type: 'control_response', response: { subtype: 'success', request_id: f.request_id, response: {} } }))
      }
    },
    kill: () => { p.killed = true; onExit({ exitCode: 143 }) },
    say: (o) => onData(`${JSON.stringify(o)}\n`)
  }
  return p
}
const turns = (p: FakeChat, text: string) => p.sent.filter((f) => f.type === 'user' && JSON.stringify(f).includes(text)).length
const rejected = (resetsAtMs: number) => ({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(resetsAtMs / 1000), rateLimitType: 'five_hour' } })

async function rig() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] })
  const profileDir = await tempDir('astera-chat-rig-')
  dirs.push(profileDir)
  const accounts: Account[] = ['a1', 'a2'].map((id) => ({ id, label: id, configDir: path.join(profileDir, id), color: '#fff', createdAt: NOW }))
  await fs.writeFile(path.join(profileDir, 'orchestration.json'), JSON.stringify(emptyState()), 'utf8')

  // No pty is ever opened in this rig: a chat chain that reached the pty spawner would show here.
  const ptysOpened: string[] = []
  const registry = new PtyRegistry({
    spawn: () => {
      const p: RegistryPty = { pid: 1, onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {}, pause: () => {}, resume: () => {} }
      return p
    },
    log: () => {}
  })
  const fakes: FakeChat[] = []
  let pid = 100
  const procs = new ProcRegistry({ spawn: () => { const p = fakeClaude(++pid); fakes.push(p); return p }, log: () => {} })
  const holders = createProcHolders()
  procs.onExit((id) => holders.ended(id))
  const openProc = (procId: string, sessionId: string, restore: Record<string, unknown>): void => {
    const r = procs.open({ id: procId, file: 'claude', args: [], opts: { cwd: profileDir, env: {} }, meta: { kind: 'chat', id: sessionId, restore } })
    if (!r.ok) throw new Error(r.error)
  }
  const procList = () => procs.list()
  const procsOpened = () => procList().map((e) => e.id)
  const proc = (id: string): FakeChat => {
    const e = procList().find((x) => x.id === id)
    const f = e ? fakes.find((x) => x.pid === e.pid) : undefined
    if (!f) throw new Error(`no fake proc ${id}`)
    return f
  }

  const apps = new Map<number, Set<string>>()
  const broadcasts: HostMessage[] = []
  /** What each attached app received: [app number, message]. */
  const delivered: Array<[number, HostMessage]> = []
  const acts: Array<[string, unknown[]]> = []
  const server = {
    hasApp: () => apps.size > 0,
    yieldsOf: (s: number) => apps.get(s) ?? null,
    broadcast: (m: HostMessage, to?: (yields: ReadonlySet<string>) => boolean) => {
      broadcasts.push(m)
      for (const [no, y] of apps) if (!to || to(y)) delivered.push([no, m])
    },
    act: async (name: string, args: unknown) => { acts.push([name, args as unknown[]]); return { sent: true } }
  }
  const spawner = {
    prepareRollSpawn: async () => {},
    rollSpawn: (x: { account: Account; cwd: string }) => {
      ptysOpened.push(x.account.id)
      return { id: 'pty-session', accountId: x.account.id, cwd: x.cwd, status: 'running', title: 't' } as SessionInfo
    },
    statusLinePayload: async () => null,
    onSpawned: () => {},
    onRolloutLocated: () => {},
    retarget: () => {},
    isRetiring: () => false
  }
  const afters: Array<() => void> = []
  const logs: string[] = []
  const box: { orch?: ReturnType<typeof createHostOrch>; exits?: ReturnType<typeof createHostExits> } = {}
  const wiring: HostRollingWiring = composeHostRolling({
    profileDir, platform: process.platform, registry, spawner: spawner as never,
    procs, procHolders: holders, version: '0.0.0', exits: () => box.exits!, server: () => server,
    orch: () => box.orch!, lang: () => 'en', log: (m) => logs.push(m), nowIso: () => new Date().toISOString(),
    after: (_ms, fn) => { afters.push(fn); return () => { const i = afters.indexOf(fn); if (i >= 0) afters.splice(i, 1) } },
    appPid: () => null,
    rollingDeps: quietDeps(async () => accounts)
  })
  cleanups.push(() => wiring.dispose())
  const orch = createHostOrch({
    profileDir, version: '0.0.0', now: () => new Date().toISOString(), hostStartedAt: () => NOW, runningSessions: () => registry.liveCount(),
    aliveSessionIds: () => new Set<string>(),
    act: async () => { throw new Error('the rig’s app answers no act') },
    hasApp: () => server.hasApp(), onState: () => {}, log: (m) => logs.push(m),
    sessions: {
      listSessions: async () => [],
      readSession: async () => ({ cols: 80, rows: 24, screen: [], scrollback: [] }),
      sendSession: async () => {},
      readChat: async () => [],
      sendChat: async () => {},
      serial: (_id, run) => run()
    },
    ...wiring.orchHooks
  })
  box.orch = orch
  box.exits = createHostExits({ registry, sessionExited: (e) => orch.sessionExited(e), orphanedSessions: (f) => orch.orphanedSessions(f), log: () => {} })
  await vi.advanceTimersByTimeAsync(0)
  return {
    profileDir, wiring, holders, acts, broadcasts, delivered, logs, ptysOpened,
    openProc, proc, procsOpened, procList,
    appAttach: (socket: number, yields: string[]) => { apps.set(socket, new Set(yields)); wiring.onAppsChanged() },
    appLeave: (socket: number) => { apps.delete(socket); holders.appGone(socket); wiring.onAppsChanged() },
    fireAfters: () => { for (const fn of afters.splice(0)) fn() }
  }
}
type Rig = Awaited<ReturnType<typeof rig>>

/** An app chat proc the way a chat-takeover app leaves it: snapshot, policy, thread, transcript. */
const appChat = (h: Rig, over: { accounts?: string[]; transcript: string }) =>
  h.openProc('pa', 'c1', {
    accountId: 'a1', cwd: h.profileDir, title: 't', provider: 'claude', threadId: 'th1', unattendedPermission: 'hold',
    rollAccountIds: over.accounts ?? ['a1', 'a2'],
    roll: { v: ROLL_SNAPSHOT_VERSION, provider: 'claude', accountIds: over.accounts ?? ['a1', 'a2'], currentIndex: 0, streak: 0,
      recovery: (over.accounts ?? ['a1', 'a2']).map(() => null), blocks: {}, wait: null, inPlaceUsed: false, rolledAt: null,
      awaitingPrompt: false, claude: { sessionId: 'th1', transcriptPath: over.transcript, tailOffset: 0, tailSince: 0 }, writtenAt: Date.now() }
  })

describe('the chat rig (chat takeover spec §5)', () => {
  it('with no app, a limit rolls the chat session and types the carry-on once', async () => {
    const h = await rig()
    const transcript = path.join(h.profileDir, 'th1.jsonl'); await fs.writeFile(transcript, '')
    appChat(h, { transcript })
    h.appAttach(1, [HOST_YIELD_ROLLING, HOST_YIELD_CHAT_TAKEOVER]); h.appLeave(1); h.fireAfters()
    // Task 5 review M12: the wiring's takeover really adopts (a mutation `adopt: () => false` fails here).
    await vi.waitFor(() => expect(h.wiring.chats.has('c1')).toBe(true))
    h.proc('pa').say(rejected(Date.now() + 3_600_000))
    await vi.waitFor(() => expect(h.proc('pa').killed).toBe(true))
    const next = await vi.waitFor(() => { const p = h.procsOpened().find((x) => x !== 'pa'); expect(p).toBeDefined(); return p! })
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(turns(h.proc(next), '')).toBe(1))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(turns(h.proc(next), '')).toBe(1)
    const e = h.procList().find((x) => x.id === next)!
    expect(e.meta?.restore).toMatchObject({ rolledBy: 'host', rolledFrom: 'c1', carrySent: true, hostStarting: null })
    // Task 5 review hard carry: the chat chain rolled to a chat proc and never opened a pty.
    expect(h.ptysOpened).toEqual([])
  })

  // Final review M4: the chat roll push names a proc, which only an app that yields chat-takeover
  // adopts as the new half of a roll. An older app attached beside it is not sent it.
  it('sends the chat roll push only to the apps that yield chat-takeover', async () => {
    const h = await rig()
    const transcript = path.join(h.profileDir, 'th1.jsonl'); await fs.writeFile(transcript, '')
    appChat(h, { transcript })
    h.appAttach(1, [HOST_YIELD_ROLLING, HOST_YIELD_CHAT_TAKEOVER]); h.appLeave(1); h.fireAfters()
    await vi.waitFor(() => expect(h.wiring.chats.has('c1')).toBe(true))
    h.appAttach(2, [HOST_YIELD_ROLLING, HOST_YIELD_CHAT_TAKEOVER]); h.holders.heldBy('pa', 2)
    h.appAttach(3, [HOST_YIELD_ROLLING])
    h.proc('pa').say(rejected(Date.now() + 3_600_000))
    await vi.waitFor(() => expect(h.broadcasts.some((x) => x.t === 'session-rolled')).toBe(true))
    const rolledTo = h.delivered.filter(([, m]) => m.t === 'session-rolled').map(([no]) => no)
    expect(rolledTo).toEqual([2])
  })

  it('with an app attached, the roll is pushed with the new proc after its handshake, and the app becomes its writer', async () => {
    const h = await rig()
    const transcript = path.join(h.profileDir, 'th1.jsonl'); await fs.writeFile(transcript, '')
    appChat(h, { transcript })
    h.appAttach(1, [HOST_YIELD_ROLLING, HOST_YIELD_CHAT_TAKEOVER]); h.appLeave(1); h.fireAfters()
    await vi.waitFor(() => expect(h.wiring.chats.has('c1')).toBe(true))
    h.appAttach(2, [HOST_YIELD_ROLLING, HOST_YIELD_CHAT_TAKEOVER]); h.holders.heldBy('pa', 2)
    expect(h.wiring.chats.isWriter('c1')).toBe(false)
    h.proc('pa').say(rejected(Date.now() + 3_600_000))
    const pushed = await vi.waitFor(() => { const m = h.broadcasts.find((x) => x.t === 'session-rolled'); expect(m).toBeDefined(); return m as Extract<HostMessage, { t: 'session-rolled' }> })
    expect(pushed.ptyId).toBeNull()
    expect(pushed.procId).toBeDefined()
    expect(h.procList().find((x) => x.id === pushed.procId)!.meta?.restore.hostStarting).toBeNull()
    h.holders.heldBy(pushed.procId!, 2)
    expect(h.wiring.chats.isWriter(pushed.info.id)).toBe(false)
    expect(h.ptysOpened).toEqual([])
  })

  it('a single-account chain resumes in place after the reset, through the app when the app is the writer', async () => {
    const h = await rig()
    const transcript = path.join(h.profileDir, 'th1.jsonl'); await fs.writeFile(transcript, '')
    appChat(h, { accounts: ['a1'], transcript })
    h.appAttach(1, [HOST_YIELD_ROLLING, HOST_YIELD_CHAT_TAKEOVER]); h.appLeave(1); h.fireAfters()
    await vi.waitFor(() => expect(h.wiring.chats.has('c1')).toBe(true))
    h.appAttach(2, [HOST_YIELD_ROLLING, HOST_YIELD_CHAT_TAKEOVER]); h.holders.heldBy('pa', 2)
    h.proc('pa').say(rejected(Date.now() + 60_000))
    // The limit's evidence gate awaits real I/O, so the wait is planned before the clock is moved. With no
    // usage figure the wait is the cycle's 15-minute fallback, past the event's own reset time.
    await vi.waitFor(() => expect(h.wiring.rolling.stateOf('c1')?.state).toBe('waiting'))
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    await vi.waitFor(() => expect(h.acts.filter((c) => c[0] === 'chatSend' && c[1][0] === 'c1')).toHaveLength(1))
    expect(h.proc('pa').killed).toBe(false)
    // Nothing was typed on the wire by the Host: the app is the writer.
    expect(turns(h.proc('pa'), '')).toBe(0)
  })

  it('an app that yields rolling but not chat-takeover and holds the proc quiets the chain (review I1)', async () => {
    const h = await rig()
    const transcript = path.join(h.profileDir, 'th1.jsonl'); await fs.writeFile(transcript, '')
    appChat(h, { transcript })
    h.appAttach(1, [HOST_YIELD_ROLLING, HOST_YIELD_CHAT_TAKEOVER]); h.appLeave(1); h.fireAfters()
    await vi.waitFor(() => expect(h.wiring.chats.has('c1')).toBe(true))
    h.appAttach(2, [HOST_YIELD_ROLLING]); h.holders.heldBy('pa', 2)
    h.proc('pa').say(rejected(Date.now() + 3_600_000))
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(h.proc('pa').killed).toBe(false)
    expect(h.procsOpened()).toEqual(['pa'])
    expect(h.broadcasts.filter((m) => m.t === 'session-rolled')).toEqual([])
  })

  // Task 8 fix round 1 (Minor 2): the wiring's chatAppAnswers reads the proc's holders and their yields.
  it('says an app without the chat-takeover yield that holds the proc cannot answer its prompts', async () => {
    const h = await rig()
    const transcript = path.join(h.profileDir, 'th1.jsonl'); await fs.writeFile(transcript, '')
    appChat(h, { transcript })
    expect(h.wiring.orchHooks.chatAppAnswers('c1')).toBe(true)
    h.appAttach(2, [HOST_YIELD_ROLLING]); h.holders.heldBy('pa', 2)
    expect(h.wiring.orchHooks.chatAppAnswers('c1')).toBe(false)
    h.appAttach(3, [HOST_YIELD_ROLLING, HOST_YIELD_CHAT_TAKEOVER]); h.appLeave(2); h.holders.heldBy('pa', 3)
    expect(h.wiring.orchHooks.chatAppAnswers('c1')).toBe(true)
    expect(h.wiring.orchHooks.chatAppAnswers('nobody')).toBe(true)
  })

  it('does not roll while a permission prompt is open', async () => {
    const h = await rig()
    const transcript = path.join(h.profileDir, 'th1.jsonl'); await fs.writeFile(transcript, '')
    appChat(h, { transcript })
    h.appAttach(1, [HOST_YIELD_ROLLING, HOST_YIELD_CHAT_TAKEOVER]); h.appLeave(1); h.fireAfters()
    await vi.waitFor(() => expect(h.wiring.chats.has('c1')).toBe(true))
    h.proc('pa').say(JSON.parse(F.CAN_USE_TOOL_WRITE))
    expect(h.wiring.chats.hasOpenRequest('c1')).toBe(true)
    h.proc('pa').say(rejected(Date.now() + 3_600_000))
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(h.proc('pa').killed).toBe(false)
    expect(h.procsOpened()).toEqual(['pa'])
  })
})
