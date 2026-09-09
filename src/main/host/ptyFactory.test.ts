import { describe, it, expect } from 'vitest'
import { createHostPtyFactory, type HostPtyTransport } from './ptyFactory'
import type { ClientMessage, HostMessage } from '../../core/host/protocol'

/** A transport the test drives from both ends. `connected` starts true — set it false to make
 *  `send` behave the way `HostClient.send` does with no socket: refuse, and record nothing. */
const transport = (): HostPtyTransport & { sent: ClientMessage[]; connected: boolean; logs: string[]; deliver(m: HostMessage): void; hostGone(): void } => {
  const subs = new Set<(m: HostMessage) => void>()
  const gone = new Set<() => void>()
  return {
    sent: [],
    connected: true,
    logs: [],
    send(m) {
      if (!this.connected) return false
      this.sent.push(m)
      return true
    },
    onHostMessage(cb) {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    onHostGone(cb) {
      gone.add(cb)
      return () => gone.delete(cb)
    },
    log(m) {
      this.logs.push(m)
    },
    deliver: (m) => { for (const cb of [...subs]) cb(m) },
    hostGone: () => { for (const cb of [...gone]) cb() }
  }
}

const opts = { cwd: 'D:/p', cols: 80, rows: 24, env: {} }
const spawned = (t: ReturnType<typeof transport>): string => (t.sent.find((m) => m.t === 'pty-spawn') as { id: string }).id

describe('createHostPtyFactory', () => {
  it('asks the Host to spawn and hands back a handle at once', () => {
    const t = transport()
    const { factory } = createHostPtyFactory(t)
    const p = factory('cmd.exe', ['/k'], opts)
    expect(p.pid).toBe(0)
    const msg = t.sent[0] as Extract<ClientMessage, { t: 'pty-spawn' }>
    expect(msg).toMatchObject({ t: 'pty-spawn', file: 'cmd.exe', args: ['/k'], opts })
    expect(msg.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('carries meta through when the caller gave one', () => {
    const t = transport()
    const { factory } = createHostPtyFactory(t)
    factory('cmd.exe', [], { ...opts, meta: { kind: 'terminal', id: 'trm_1', restore: { projectPath: 'D:/p' } } })
    expect((t.sent[0] as Extract<ClientMessage, { t: 'pty-spawn' }>).meta).toEqual({
      kind: 'terminal',
      id: 'trm_1',
      restore: { projectPath: 'D:/p' }
    })
  })

  // RunManager's shellSpawn hands node-pty's verbatim command line — a string, not an argv array —
  // on win32 for every Run. The wire has to carry that shape unchanged, the same way it carries an
  // array, rather than the handle refusing it: RunManager routed through the Host is the primary
  // platform's every Run.
  it('carries a string args (node-pty\'s verbatim command line) through, live and usable', () => {
    const t = transport()
    const { factory } = createHostPtyFactory(t)
    const p = factory('cmd.exe', '/s /c "npm run build"', opts)
    const msg = t.sent[0] as Extract<ClientMessage, { t: 'pty-spawn' }>
    expect(msg.args).toBe('/s /c "npm run build"')
    t.deliver({ t: 'pty-spawned', id: spawned(t), pid: 1 })
    expect(p.pid).toBe(1)
    p.write('after')
    expect(t.sent.at(-1)).toEqual({ t: 'pty-write', id: spawned(t), data: 'after' })
  })

  // pid is read in exactly one place in this repository, RunManager's tree-kill, long after the
  // spawn — which is what lets the factory stay synchronous (slice 2 design §3).
  it('fills the pid in when the Host answers', () => {
    const t = transport()
    const { factory } = createHostPtyFactory(t)
    const p = factory('cmd.exe', [], opts)
    t.deliver({ t: 'pty-spawned', id: spawned(t), pid: 4321 })
    expect(p.pid).toBe(4321)
  })

  it('queues what was written before the Host answered, in order', () => {
    const t = transport()
    const { factory } = createHostPtyFactory(t)
    const p = factory('cmd.exe', [], opts)
    p.write('one')
    p.resize(100, 40)
    p.write('two')
    expect(t.sent.filter((m) => m.t !== 'pty-spawn')).toEqual([])
    t.deliver({ t: 'pty-spawned', id: spawned(t), pid: 1 })
    expect(t.sent.slice(1)).toEqual([
      { t: 'pty-write', id: spawned(t), data: 'one' },
      { t: 'pty-resize', id: spawned(t), cols: 100, rows: 40 },
      { t: 'pty-write', id: spawned(t), data: 'two' }
    ])
  })

  // kill, pause and resume carry no payload the Host needs the pty to exist for, and the connection
  // delivers in order, so the Host sees them after the pty-spawn they are ordered behind — unlike
  // write and resize, which queue locally because their payload is real content (input, a size) that
  // must not be sent to a pty that turns out never to have started at all.
  it('sends kill, pause and resume immediately even while pending, right after the spawn they are ordered behind', () => {
    const t = transport()
    const { factory } = createHostPtyFactory(t)
    const p = factory('cmd.exe', [], opts)
    const id = spawned(t)
    p.kill()
    p.pause()
    p.resume()
    expect(t.sent.slice(1)).toEqual([
      { t: 'pty-kill', id },
      { t: 'pty-pause', id },
      { t: 'pty-resume', id }
    ])
  })

  it('a kill sent before the spawn is confirmed does not mark the handle dead early — it waits for the Host to say so', () => {
    const t = transport()
    const { factory } = createHostPtyFactory(t)
    const p = factory('cmd.exe', [], opts)
    const id = spawned(t)
    let exit: number | null = null
    p.onExit((e) => { exit = e.exitCode })
    p.kill()
    // The Host processes pty-spawn before the pty-kill that followed it on the same connection, so it
    // still answers spawned — the app is not left thinking the handle is dead while the Host has a
    // live pty, nor does the app's own kill() end the handle early and get out of step with the Host.
    t.deliver({ t: 'pty-spawned', id, pid: 1 })
    expect(p.pid).toBe(1)
    expect(exit).toBeNull()
    t.deliver({ t: 'pty-exit', id, exitCode: 0 })
    expect(exit).toBe(0)
  })

  it('sends straight through once the pty is live', () => {
    const t = transport()
    const { factory } = createHostPtyFactory(t)
    const p = factory('cmd.exe', [], opts)
    t.deliver({ t: 'pty-spawned', id: spawned(t), pid: 1 })
    p.write('after')
    expect(t.sent.at(-1)).toEqual({ t: 'pty-write', id: spawned(t), data: 'after' })
  })

  it('passes data and exit to the handle, and only for its own id', () => {
    const t = transport()
    const { factory } = createHostPtyFactory(t)
    const p = factory('cmd.exe', [], opts)
    const id = spawned(t)
    const data: string[] = []
    let exit: number | null = null
    p.onData((d) => data.push(d))
    p.onExit((e) => { exit = e.exitCode })
    t.deliver({ t: 'pty-spawned', id, pid: 1 })
    t.deliver({ t: 'pty-data', id: 'someone-else', data: 'not mine' })
    t.deliver({ t: 'pty-data', id, data: 'mine' })
    t.deliver({ t: 'pty-exit', id, exitCode: 7 })
    expect(data).toEqual(['mine'])
    expect(exit).toBe(7)
  })

  // A refused spawn has to look like a session that died immediately, because that is a shape every
  // caller already handles.
  it('turns a refused spawn into an exit', () => {
    const t = transport()
    const { factory } = createHostPtyFactory(t)
    const p = factory('cmd.exe', [], opts)
    let exit: number | null = null
    p.onExit((e) => { exit = e.exitCode })
    t.deliver({ t: 'pty-failed', id: spawned(t), error: 'conpty said no' })
    expect(exit).toBe(1)
  })

  // A second line of defence beside ipc.ts installing this factory only once connected: the
  // connection can still drop again later, and a spawn attempted in that gap must not sit pending
  // forever with no pty-spawned or pty-failed ever coming to end it.
  it('ends a handle at once when the spawn never reaches the Host', async () => {
    const t = transport()
    t.connected = false
    const { factory } = createHostPtyFactory(t)
    const p = factory('cmd.exe', [], opts)
    let exit: number | null = null
    p.onExit((e) => { exit = e.exitCode })
    // Deferred, not synchronous — the caller above has not registered onExit yet at the point the
    // factory call itself returns.
    expect(exit).toBeNull()
    await new Promise((r) => setTimeout(r, 0))
    expect(exit).toBe(1)
    expect(t.sent).toEqual([])
  })

  // pty-exit and onHostGone both reach end() through HostClient's own per-subscriber try/catch, so a
  // caller's onExit throwing there is already contained. This deferred end() runs outside that
  // fan-out — nothing may throw out of this module into the app either.
  it('contains a throw from onExit for a spawn that never reached the Host, and logs it', async () => {
    const t = transport()
    t.connected = false
    const { factory } = createHostPtyFactory(t)
    const p = factory('cmd.exe', [], opts)
    p.onExit(() => {
      throw new Error('onExit blew up')
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(t.logs.some((l) => l.includes('onExit blew up'))).toBe(true)
  })

  it('drops what is written after the pty exited rather than sending it', () => {
    const t = transport()
    const { factory } = createHostPtyFactory(t)
    const p = factory('cmd.exe', [], opts)
    const id = spawned(t)
    t.deliver({ t: 'pty-spawned', id, pid: 1 })
    t.deliver({ t: 'pty-exit', id, exitCode: 0 })
    const before = t.sent.length
    p.write('too late')
    p.resize(1, 1)
    expect(t.sent).toHaveLength(before)
  })

  it('forwards pause and resume, which is how the app throttles a pty it no longer owns', () => {
    const t = transport()
    const { factory } = createHostPtyFactory(t)
    const p = factory('cmd.exe', [], opts)
    const id = spawned(t)
    t.deliver({ t: 'pty-spawned', id, pid: 1 })
    p.pause()
    p.resume()
    expect(t.sent.slice(-2)).toEqual([
      { t: 'pty-pause', id },
      { t: 'pty-resume', id }
    ])
  })

  // Nothing says "your pty died" when the Host itself dies, so the handle has to say it. Otherwise
  // the session stays running in the app for as long as the app does.
  it('ends every handle when the Host goes away', () => {
    const t = transport()
    const { factory } = createHostPtyFactory(t)
    const p = factory('cmd.exe', [], opts)
    let exit: number | null = null
    p.onExit((e) => { exit = e.exitCode })
    t.deliver({ t: 'pty-spawned', id: spawned(t), pid: 1 })
    t.hostGone()
    expect(exit).toBe(-1)
    const before = t.sent.length
    p.write('nowhere to go')
    expect(t.sent).toHaveLength(before)
  })

  // The app learns things about a session after it has spawned — its new title, the rollout file a
  // codex session turned out to write to — and the note is where they have to land to survive a
  // restart. Sent at once even while pending, for the same reason kill, pause and resume are: the
  // Host sees it after the pty-spawn it is ordered behind, and a patch for a spawn that never
  // happened is a no-op there.
  it('remembers a patch against this pty, immediately even while the spawn is pending', () => {
    const t = transport()
    const { factory } = createHostPtyFactory(t)
    const p = factory('cmd.exe', [], opts)
    const id = spawned(t)
    p.remember?.({ title: 'renamed' })
    t.deliver({ t: 'pty-spawned', id, pid: 1 })
    p.remember?.({ rolloutPath: 'D:/r/one.jsonl' })
    expect(t.sent.slice(1)).toEqual([
      { t: 'pty-note', id, patch: { title: 'renamed' } },
      { t: 'pty-note', id, patch: { rolloutPath: 'D:/r/one.jsonl' } }
    ])
  })

  it('sends no note for a pty that has already exited', () => {
    const t = transport()
    const { factory } = createHostPtyFactory(t)
    const p = factory('cmd.exe', [], opts)
    t.deliver({ t: 'pty-exit', id: spawned(t), exitCode: 0 })
    const before = t.sent.length
    p.remember?.({ title: 'renamed' })
    expect(t.sent).toHaveLength(before)
  })

  // Adoption after a restart: the pty is already there, so the handle starts live with its pid and
  // nothing queued.
  it('attach gives a live handle for a pty that already exists', () => {
    const t = transport()
    const { attach } = createHostPtyFactory(t)
    const p = attach({ id: 'p9', pid: 555 })
    expect(p.pid).toBe(555)
    p.write('hello')
    expect(t.sent).toEqual([{ t: 'pty-write', id: 'p9', data: 'hello' }])
  })

  // An adopted session is renamed like any other, and the note it was adopted from is the one that
  // has to change — otherwise the next restart brings the old title back again.
  it('an attached handle remembers too', () => {
    const t = transport()
    const { attach } = createHostPtyFactory(t)
    attach({ id: 'p9', pid: 555 }).remember?.({ title: 'renamed again' })
    expect(t.sent).toEqual([{ t: 'pty-note', id: 'p9', patch: { title: 'renamed again' } }])
  })
})
