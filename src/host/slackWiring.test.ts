import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PtyRegistry, type RegistryPty } from './registry'
import { ProcRegistry } from './procRegistry'
import { composeHostSlack, createAccountSnapshot, hostSlackLog } from './slackWiring'
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
  const sdk: HostSlackSdk = {
    createPoster: () => ({ chat: { postMessage: async (m) => { posts.push(m); return { ok: true, ts: `t${++ts}` } } } }),
    createClient: () => {
      const handlers = new Map<string, (arg: never) => void>()
      const n = clients.length + 1
      const c = {
        on: (e: string, l: (arg: never) => void) => { handlers.set(e, l) },
        start: async () => { trail.push(`open ${n}`); live.add(c); peak = Math.max(peak, live.size); await wait() },
        disconnect: async () => { await wait(); live.delete(c); trail.push(`close ${n}`) },
        emit: (e: string, arg: unknown) => handlers.get(e)?.(arg as never)
      }
      clients.push(c)
      return c
    }
  }
  return { sdk, live, clients, posts, trail, peak: () => peak }
}

function fakePty(): RegistryPty & { emit(d: string): void } {
  let onData: (d: string) => void = () => {}
  return { pid: 1, onData: (cb) => { onData = cb }, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {}, pause: () => {}, resume: () => {}, emit: (d) => onData(d) }
}

async function rig(o: { keep?: boolean; sdk?: boolean; delay?: number; profileDir?: string; readConfig?: (() => Promise<SlackConfig>) | null; statusLinePayload?: () => Promise<unknown> } = {}) {
  const slack = fakeSlack({ delay: o.delay })
  const ptys = new Map<string, ReturnType<typeof fakePty>>()
  let next = ''
  const registry = new PtyRegistry({ spawn: () => { const p = fakePty(); ptys.set(next, p); return p }, log: () => {} })
  const procs = new ProcRegistry({ spawn: () => { throw new Error('no procs here') }, log: () => {} })
  const state = { keep: o.keep ?? false }
  const logs: string[] = []
  const wiring = composeHostSlack({
    profileDir: o.profileDir ?? mkdtempSync(path.join(os.tmpdir(), 'astera-host-slack-')),
    sdk: o.sdk === false ? null : slack.sdk,
    registry,
    procs,
    statusLinePayload: o.statusLinePayload ?? (async () => null),
    accountOf: () => account,
    server: () => ({ appsKeep: () => state.keep, hasApp: () => state.keep, act: vi.fn(async () => null) }),
    lang: () => 'en',
    log: (m) => logs.push(m),
    ...(o.readConfig === null ? {} : { readConfig: o.readConfig ?? (async () => ({ ...CFG })) }),
    every: () => () => {}
  })
  const openSession = (id: string, restore: Record<string, unknown> = {}) => {
    next = `p-${id}`
    registry.open({ id: next, file: 'x', args: [], opts: { cwd: 'D:/p', cols: 80, rows: 24, env: {} }, meta: { kind: 'session', id, restore: { accountId: 'a1', cwd: 'D:/p', title: id, slackNotify: true, ...restore } } })
  }
  return { wiring, slack, registry, ptys, state, logs, openSession, active: () => vi.waitFor(() => expect(wiring.active()).toBe(true)) }
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
    await vi.waitFor(() => expect(h.registry.metaOf('p-s1')?.restore).toMatchObject({ slackThreadTs: 't1', slackChannel: 'C1' }))
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

  it('createAccountSnapshot answers from its last read, refreshes after the window, and survives a failed read', async () => {
    let now = 0
    let reads = 0
    let fail = false
    const snap = createAccountSnapshot({
      read: async () => { reads += 1; if (fail) throw new Error('RepairNeeded'); return [account] },
      log: () => {},
      now: () => now,
      maxAgeMs: 15_000
    })
    expect(snap.of('a1')).toBeNull()
    await vi.waitFor(() => expect(snap.of('a1')).toEqual(account))
    expect(reads).toBe(1)
    now = 10_000
    snap.of('a1')
    expect(reads).toBe(1)
    fail = true
    now = 20_000
    expect(snap.of('a1')).toEqual(account)
    await new Promise((r) => setTimeout(r, 5))
    expect(reads).toBe(2)
    expect(snap.of('a1')).toEqual(account)
    expect(snap.of('nope')).toBeNull()
  })
})
