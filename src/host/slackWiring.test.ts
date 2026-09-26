import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PtyRegistry, type RegistryPty } from './registry'
import { ProcRegistry } from './procRegistry'
import { composeHostSlack, hostSlackLog, HOST_SLACK_START_GRACE_MS } from './slackWiring'
import type { HostSlackSdk } from './slackSdk'
import type { SlackConfig } from '../core/slack/config'
import type { Account } from '../core/types'

const CFG: SlackConfig = { webhookUrl: null, botToken: 'xoxb-fake', channelId: 'C1', appToken: 'xapp-fake', memberId: 'U1' }
const account: Account = { id: 'a1', label: 'home', configDir: 'C:\\c1', color: '#fff', createdAt: '2026-09-26T00:00:00Z' }

/** A fake SDK. `live` is the set of open sockets; `peak` the most ever open at once; `trail` the order
 *  of opens and closes. `delay` makes start and disconnect take a turn of the timer queue, so a close
 *  and an open that were not serialized would overlap. */
function fakeSlack(o: { delay?: number } = {}) {
  const live = new Set<object>()
  const clients: Array<{ emit(ev: string, arg: unknown): void }> = []
  const posts: Array<{ channel: string; text: string; thread_ts?: string }> = []
  const trail: string[] = []
  let peak = 0
  let ts = 0
  const wait = (): Promise<void> => (o.delay ? new Promise((r) => setTimeout(r, o.delay)) : Promise.resolve())
  let posters = 0
  const sdk: HostSlackSdk = {
    createPoster: () => { posters++; return { chat: { postMessage: async (m) => { posts.push(m); return { ok: true, ts: `t${++ts}` } } } } },
    createClient: () => {
      const handlers = new Map<string, (arg: never) => void>()
      const n = clients.length + 1
      const c = {
        on: (e: string, l: (arg: never) => void) => { handlers.set(e, l) },
        start: async () => { trail.push(`open ${n}`); live.add(c); peak = Math.max(peak, live.size); await wait() },
        // A disconnect of a socket already closed closes nothing (the inbox closes a start that resolves
        // after its stop, final review C1).
        disconnect: async () => { await wait(); if (live.delete(c)) trail.push(`close ${n}`) },
        emit: (e: string, arg: unknown) => handlers.get(e)?.(arg as never)
      }
      clients.push(c)
      return c
    }
  }
  return { sdk, live, clients, posts, trail, peak: () => peak, posters: () => posters }
}

function fakePty(): RegistryPty & { emit(d: string): void; sent: string[] } {
  let onData: (d: string) => void = () => {}
  const sent: string[] = []
  return { pid: 1, sent, onData: (cb) => { onData = cb }, onExit: () => {}, write: (d) => { sent.push(d) }, resize: () => {}, kill: () => {}, pause: () => {}, resume: () => {}, emit: (d) => onData(d) }
}

async function rig(o: { keep?: boolean; sdk?: boolean; delay?: number; profileDir?: string; readConfig?: (() => Promise<SlackConfig>) | null; statusLinePayload?: () => Promise<unknown>; hostChains?: string[]; manualGrace?: boolean } = {}) {
  const slack = fakeSlack({ delay: o.delay })
  const ptys = new Map<string, ReturnType<typeof fakePty>>()
  let next = ''
  const registry = new PtyRegistry({ spawn: () => { const p = fakePty(); ptys.set(next, p); return p }, log: () => {} })
  const procs = new ProcRegistry({ spawn: () => { throw new Error('no procs here') }, log: () => {} })
  // `app`: a greeted app is attached (it may yield Slack); `keep`: one that keeps Slack is.
  const state = { keep: o.keep ?? false, app: false }
  // The start grace (final review I1). By default it ends at once, so a rig with no app activates on
  // start as before; `manualGrace` holds it until the test calls `grace.fire()`.
  const grace = { ms: -1, fn: null as (() => void) | null, cancelled: false, fire: () => grace.fn?.() }
  const after = o.manualGrace
    ? (ms: number, fn: () => void) => {
        grace.ms = ms
        grace.fn = () => { if (!grace.cancelled) fn() }
        return () => { grace.cancelled = true }
      }
    : (_ms: number, fn: () => void) => { queueMicrotask(fn); return () => {} }
  const logs: string[] = []
  const wiring = composeHostSlack({
    profileDir: o.profileDir ?? mkdtempSync(path.join(os.tmpdir(), 'astera-host-slack-')),
    sdk: o.sdk === false ? null : slack.sdk,
    registry,
    procs,
    statusLinePayload: o.statusLinePayload ?? (async () => null),
    chats: null,
    rolling: { has: (id: string) => (o.hostChains ?? []).includes(id), account: (id: string) => (id === account.id ? account : null) },
    server: () => ({ appsKeep: () => state.keep, hasApp: () => state.keep || state.app, act: vi.fn(async () => null) }),
    lang: () => 'en',
    log: (m) => logs.push(m),
    ...(o.readConfig === null ? {} : { readConfig: o.readConfig ?? (async () => ({ ...CFG })) }),
    every: () => () => {},
    after
  })
  const openSession = (id: string, restore: Record<string, unknown> = {}) => {
    next = `p-${id}`
    registry.open({ id: next, file: 'x', args: [], opts: { cwd: 'D:/p', cols: 80, rows: 24, env: {} }, meta: { kind: 'session', id, restore: { accountId: 'a1', cwd: 'D:/p', title: id, slackNotify: true, ...restore } } })
  }
  return { wiring, slack, registry, ptys, state, logs, openSession, grace, active: () => vi.waitFor(() => expect(wiring.active()).toBe(true)) }
}

describe('composeHostSlack (Slack in the Host Task 5, S1, S2, S4)', () => {
  // Review Focus 1, the Host half.
  it('holds exactly one socket while no attached app keeps Slack, none while one does', async () => {
    const h = await rig()
    h.wiring.start()
    await vi.waitFor(() => expect(h.slack.live.size).toBe(1))
    h.state.keep = true
    h.wiring.onAppsChanged()
    await vi.waitFor(() => expect(h.slack.live.size).toBe(0))
    expect(h.wiring.active()).toBe(false)
    h.state.keep = false
    h.wiring.onAppsChanged()
    await vi.waitFor(() => expect(h.slack.live.size).toBe(1))
    expect(h.slack.clients).toHaveLength(2)
    await h.wiring.dispose()
    expect(h.slack.live.size).toBe(0)
  })

  // The critical invariant under a race: an app that keeps Slack attaching while the Host's socket is
  // still opening, then leaving and coming back, faster than a socket opens or closes. Each close is
  // done before the next open starts, so there is never a second socket, and the last word wins.
  it('never has two sockets open at once, however fast apps come and go, and ends where the last change says', async () => {
    const h = await rig({ delay: 5 })
    h.wiring.start()
    for (const keep of [true, false, true, false, true]) {
      h.state.keep = keep
      h.wiring.onAppsChanged()
      await new Promise((r) => setTimeout(r, 1))
    }
    await vi.waitFor(() => expect(h.slack.live.size).toBe(0))
    await h.wiring.reload()
    expect(h.slack.peak()).toBe(1)
    // Opens and closes strictly alternate: open 1, close 1, open 2, close 2, ...
    const kinds = h.slack.trail.map((t) => t.split(' ')[0])
    kinds.forEach((k, i) => expect(k).toBe(i % 2 === 0 ? 'open' : 'close'))
    h.state.keep = false
    h.wiring.onAppsChanged()
    await vi.waitFor(() => expect(h.slack.live.size).toBe(1))
    await h.wiring.dispose()
    expect(h.slack.live.size).toBe(0)
    expect(h.slack.peak()).toBe(1)
  })

  it('an app that keeps Slack attaching closes the socket and stops the posts before anything else is posted', async () => {
    const h = await rig()
    h.wiring.start()
    await h.active()
    h.openSession('s1')
    await vi.waitFor(() => expect(h.slack.posts).toHaveLength(1))
    h.state.keep = true
    h.wiring.onAppsChanged()
    await vi.waitFor(() => expect(h.slack.live.size).toBe(0))
    h.openSession('s2')
    await h.wiring.reload()
    await new Promise((r) => setTimeout(r, 10))
    expect(h.slack.posts).toHaveLength(1)
    expect(h.logs.join('\n')).toMatch(/this Host leaves Slack alone/)
  })

  it('posts nothing while an attached app keeps Slack, and nothing at all without an SDK', async () => {
    for (const o of [{ keep: true }, { sdk: false }]) {
      const h = await rig(o)
      h.wiring.start()
      h.openSession('s1')
      await new Promise((r) => setTimeout(r, 10))
      expect(h.slack.posts).toEqual([])
      expect(h.slack.live.size).toBe(0)
      expect(h.wiring.active()).toBe(false)
    }
  })

  it('registers a Slack session when its pty opens, posts its root and notes the thread', async () => {
    const h = await rig()
    h.wiring.start()
    await h.active()
    h.openSession('s1', { title: 'Build' })
    await vi.waitFor(() => expect(h.slack.posts).toHaveLength(1))
    expect(h.slack.posts[0]).toMatchObject({ channel: 'C1' })
    expect(h.slack.posts[0].text).toContain('Build')
    // The account label comes from the rolling's own accounts snapshot (Task 6).
    expect(h.slack.posts[0].text).toContain('home')
    await vi.waitFor(() => expect(h.registry.metaOf('p-s1')?.restore).toMatchObject({ slackThreadTs: 't1', slackChannel: 'C1' }))
  })

  // Task 7: the inbox's reply writer is the Host's routes, not Task 5's `() => false`. Mutation: put the
  // stub back, and every reply in a terminal session's thread is answered "this session has ended".
  it("types a reply in a terminal session's thread into its pty, and says an unknown thread has ended", async () => {
    const h = await rig()
    h.wiring.start()
    await h.active()
    h.openSession('s1')
    await vi.waitFor(() => expect(h.slack.posts).toHaveLength(1))
    const socket = h.slack.clients[0]
    socket.emit('message', { ack: async () => {}, event: { ts: '9.1', thread_ts: 't1', channel: 'C1', user: 'U1', text: 'hi' } })
    await vi.waitFor(() => expect(h.ptys.get('p-s1')?.sent).toContain('hi'))
    socket.emit('message', { ack: async () => {}, event: { ts: '9.2', thread_ts: 'nope', channel: 'C1', user: 'U1', text: 'hi' } })
    await vi.waitFor(() => expect(h.slack.posts.some((m) => m.thread_ts === 'nope')).toBe(true))
    expect(h.ptys.get('p-s1')?.sent.filter((d) => d === 'hi')).toHaveLength(1)
    await h.wiring.dispose()
  })

  // Review Focus 4, the Host half: the app owned Slack and noted its root; the app leaves, and the Host
  // carries the same thread on with no second root.
  it('takes over the thread the app noted while it kept Slack: no second root', async () => {
    const h = await rig({ keep: true })
    h.wiring.start()
    h.openSession('s1')
    h.registry.note('p-s1', { slackThreadTs: 'app.1', slackChannel: 'C1' })
    await new Promise((r) => setTimeout(r, 5))
    h.state.keep = false
    h.wiring.onAppsChanged()
    await h.active()
    h.ptys.get('p-s1')!.emit('Claude usage limit ' + 'reached ∙ resets 3am')
    await vi.waitFor(() => expect(h.slack.posts.length).toBeGreaterThan(0))
    expect(h.slack.posts.every((p) => p.thread_ts === 'app.1')).toBe(true)
    expect(h.registry.metaOf('p-s1')?.restore).toMatchObject({ slackThreadTs: 'app.1', slackChannel: 'C1' })
  })

  // Slack in the Host Task 6 (the Task 5 carry): a record from an earlier activation must not keep its old
  // root when the app, owning Slack in between, noted a new one for the session in the same channel.
  it('prefers the thread the app noted meanwhile over the record from an earlier activation', async () => {
    const h = await rig()
    h.wiring.start()
    await h.active()
    h.openSession('s1')
    await vi.waitFor(() => expect(h.registry.metaOf('p-s1')?.restore).toMatchObject({ slackThreadTs: 't1' }))
    h.state.keep = true
    h.wiring.onAppsChanged()
    await vi.waitFor(() => expect(h.wiring.active()).toBe(false))
    h.registry.note('p-s1', { slackThreadTs: 'app.2', slackChannel: 'C1' })
    h.state.keep = false
    h.wiring.onAppsChanged()
    await h.active()
    const before = h.slack.posts.length
    h.ptys.get('p-s1')!.emit('Claude usage limit ' + 'reached ∙ resets 3am')
    await vi.waitFor(() => expect(h.slack.posts.length).toBeGreaterThan(before))
    expect(h.slack.posts.slice(before).every((p) => p.thread_ts === 'app.2')).toBe(true)
    expect(h.wiring.notifier.resolveSessionByThread('app.2')).toBe('s1')
    expect(h.wiring.notifier.resolveSessionByThread('t1')).toBeNull()
  })

  it('hands forwarded events, the Host roll events and hook events to the notifier, and drops a forward of its own chain', async () => {
    const h = await rig({ hostChains: ['s2'] })
    h.wiring.start()
    await h.active()
    h.openSession('s1')
    h.openSession('s2')
    await vi.waitFor(() => expect(h.slack.posts).toHaveLength(2))
    h.wiring.forwarded({ kind: 'roll-state', event: { sessionId: 's1', state: 'stalled' } })
    h.wiring.forwarded({ kind: 'roll-state', event: { sessionId: 's2', state: 'stalled' } })
    h.wiring.onRollEvent({ t: 'roll-state', event: { sessionId: 's2', state: 'nudged' } })
    h.wiring.onHookEvent('s1', { hook_event_name: 'StopFailure', error: 'overloaded' })
    await vi.waitFor(() => expect(h.slack.posts).toHaveLength(5))
    await new Promise((r) => setTimeout(r, 10))
    const inThread = (ts: string | undefined) => h.slack.posts.slice(2).filter((p) => p.thread_ts === ts)
    expect(inThread('t1')).toHaveLength(2)
    expect(inThread('t2').map((p) => p.text).join(' ')).toContain('Limit reset')
    expect(inThread('t2').map((p) => p.text).join(' ')).not.toContain('stuck')
    expect(h.logs.some((m) => m.includes('roll state of s2 dropped'))).toBe(true)
  })

  // Task 8 carry 2: an app-held roll. The app forwards the `rolled` in the same turn as the respawn's
  // pty-spawn, behind it on the socket, but the Host may open the new pty before or after it handles the
  // forward. Either way the new session goes on in the old root, and no second one is posted.
  it("an app roll's forwarded rolled and the new pty's note land in either order with no second root", async () => {
    for (const order of ['pty first', 'rolled first'] as const) {
      const h = await rig()
      h.wiring.start()
      await h.active()
      h.openSession('s1')
      await vi.waitFor(() => expect(h.registry.metaOf('p-s1')?.restore).toMatchObject({ slackThreadTs: 't1' }))
      const rolled = { kind: 'rolled' as const, oldSessionId: 's1', info: { id: 's2', accountId: 'a1', cwd: 'D:/p', title: 's1', slackNotify: true } as never }
      if (order === 'pty first') {
        h.openSession('s2', { rolledFrom: 's1', title: 's1' })
        h.wiring.forwarded(rolled)
      } else {
        h.wiring.forwarded(rolled)
        h.openSession('s2', { rolledFrom: 's1', title: 's1' })
      }
      await vi.waitFor(() => expect(h.registry.metaOf('p-s2')?.restore).toMatchObject({ slackThreadTs: 't1', slackChannel: 'C1' }))
      h.ptys.get('p-s2')!.emit('Claude usage limit ' + 'reached ∙ resets 3am')
      await vi.waitFor(() => expect(h.slack.posts.length).toBeGreaterThan(1))
      await new Promise((r) => setTimeout(r, 10))
      expect(h.slack.posts.filter((p) => p.thread_ts === undefined), order).toHaveLength(1)
      expect(h.slack.posts.slice(1).every((p) => p.thread_ts === 't1'), order).toBe(true)
      expect(h.wiring.notifier.resolveSessionByThread('t1'), order).toBe('s2')
      await h.wiring.dispose()
    }
  })

  it('reads slack.json from the profile and never writes it, a reload included (S4)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'astera-host-slack-'))
    try {
      const file = path.join(dir, 'slack.json')
      writeFileSync(file, JSON.stringify(CFG, null, 2))
      const bytes = readFileSync(file, 'utf8')
      const mtime = statSync(file).mtimeMs
      const h = await rig({ profileDir: dir, readConfig: null })
      h.wiring.start()
      await h.active()
      await h.wiring.reload()
      expect(readFileSync(file, 'utf8')).toBe(bytes)
      expect(statSync(file).mtimeMs).toBe(mtime)
      await h.wiring.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    for (const f of ['slackWiring.ts', 'slackSessions.ts'])
      expect(readFileSync(path.join(__dirname, f), 'utf8'), f).not.toMatch(/SlackConfigStore|writeFile|\.patch\(|\.save\(/)
  })

  it('a reload with another channel drops the noted threads from the notes', async () => {
    let cfg = { ...CFG }
    const h = await rig({ readConfig: async () => ({ ...cfg }) })
    h.wiring.start()
    await h.active()
    h.openSession('s1')
    await vi.waitFor(() => expect(h.registry.metaOf('p-s1')?.restore.slackThreadTs).toBe('t1'))
    cfg = { ...CFG, channelId: 'C2' }
    await h.wiring.reload()
    expect(h.registry.metaOf('p-s1')?.restore).toMatchObject({ slackThreadTs: null, slackChannel: null })
  })

  it('no unhandled rejection from a failing config read, statusline read or log (R3)', async () => {
    const seen: unknown[] = []
    const on = (e: unknown): void => { seen.push(e) }
    process.on('unhandledRejection', on)
    try {
      const h = await rig({ readConfig: async () => { throw new Error('EBUSY') }, statusLinePayload: async () => { throw new Error('boom') } })
      h.wiring.start()
      await h.wiring.reload()
      h.openSession('s1')
      h.ptys.get('p-s1')!.emit('Claude usage limit ' + 'reached ∙ resets 3am')
      await new Promise((r) => setTimeout(r, 20))
      expect(seen).toEqual([])
      expect(h.logs.join('\n')).toMatch(/slack\.json could not be read/)
      // The same with the config read fine and the statusline read failing, on a session that is registered.
      const g = await rig({ statusLinePayload: async () => { throw new Error('boom') } })
      g.wiring.start()
      await g.active()
      g.openSession('s1')
      g.ptys.get('p-s1')!.emit('Claude usage limit ' + 'reached ∙ resets 3am')
      await new Promise((r) => setTimeout(r, 20))
      expect(seen).toEqual([])
      await g.wiring.dispose()
    } finally {
      process.off('unhandledRejection', on)
    }
  })

  // Final review I1: a fresh Host that took Slack at start opened a second socket beside an app that holds
  // Slack, until that app's keeping hello arrived; a reply Slack routed to the new Host was answered
  // "this session has ended".
  it('a fresh Host waits for the first hello: an app that already holds Slack greets within the grace, and no socket ever opens', async () => {
    const h = await rig({ manualGrace: true })
    h.wiring.start()
    await new Promise((r) => setTimeout(r, 5))
    expect(h.slack.clients).toHaveLength(0)
    expect(h.grace.ms).toBe(HOST_SLACK_START_GRACE_MS)
    expect(HOST_SLACK_START_GRACE_MS).toBe(10_000)
    h.state.keep = true
    h.wiring.onAppsChanged()
    await new Promise((r) => setTimeout(r, 5))
    h.grace.fire()
    await new Promise((r) => setTimeout(r, 5))
    expect(h.slack.clients).toHaveLength(0)
    expect(h.wiring.active()).toBe(false)
    expect(h.grace.cancelled).toBe(true)
  })

  it('a headless Host takes Slack when the start grace ends with no app, and a yielding hello inside it takes Slack at once', async () => {
    const h = await rig({ manualGrace: true })
    h.wiring.start()
    await new Promise((r) => setTimeout(r, 5))
    expect(h.slack.clients).toHaveLength(0)
    h.grace.fire()
    await h.active()
    expect(h.slack.live.size).toBe(1)
    const g = await rig({ manualGrace: true })
    g.wiring.start()
    g.state.app = true
    g.wiring.onAppsChanged()
    await g.active()
    expect(g.slack.live.size).toBe(1)
    expect(g.grace.cancelled).toBe(true)
    await h.wiring.dispose()
    await g.wiring.dispose()
  })

  // Final review M1: every hello or close re-applied the config while the Host stayed active, which built
  // a new transport and dropped a root still in flight, so the next notice opened a second root.
  it('a hello, a close or a reload that changes nothing leaves the active config alone', async () => {
    let cfg = { ...CFG }
    const h = await rig({ readConfig: async () => ({ ...cfg }) })
    h.wiring.start()
    await h.active()
    const built = h.slack.posters()
    h.state.app = true
    h.wiring.onAppsChanged()
    h.state.app = false
    h.wiring.onAppsChanged()
    await h.wiring.reload()
    expect(h.slack.posters()).toBe(built)
    cfg = { ...CFG, channelId: 'C2' }
    await h.wiring.reload()
    expect(h.slack.posters()).toBe(built + 1)
    await h.wiring.dispose()
  })

  it('a forward that arrives while the Host is taking Slack is told once it has, not dropped', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((r) => { release = r })
    const h = await rig({ keep: true, readConfig: async () => { await gate; return { ...CFG } } })
    h.wiring.start()
    h.openSession('s1')
    h.state.keep = false
    h.wiring.onAppsChanged()
    h.wiring.forwarded({ kind: 'roll-state', event: { sessionId: 's1', state: 'stalled' } })
    release()
    await h.active()
    await vi.waitFor(() => expect(h.slack.posts.filter((p) => p.thread_ts === 't1')).toHaveLength(1))
    await h.wiring.dispose()
  })

  it('hostSlackLog appends [host] lines to <profile>/slack.log and never throws', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'astera-host-slack-'))
    try {
      hostSlackLog(dir)('hello')
      expect(readFileSync(path.join(dir, 'slack.log'), 'utf8')).toMatch(/^\S+ \[host\] hello\n$/)
      expect(() => hostSlackLog(path.join(dir, 'missing', 'deeper'))('x')).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
