// Remote Runtime Phase 9b acceptance from the app's main process: a Runtime (real pty registry, the Host's session
// reader and remote sessions, its command entry, the Gateway link and the Gateway on pinned TLS) and the app's own path
// to it (createRemoteRuntimeClient over a link, and createRemoteStreams forwarding to what would be the renderer). A
// session is started there and attached here; its output arrives as a checkpoint then data, once each across a dropped
// connection; a flood past its stream's share ends in a fresh checkpoint with the latest output; a roll is followed;
// a read-only pairing reads and cannot type.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { generateKeyPairSync } from 'node:crypto'
import { PtyRegistry, type RegistryPty } from '../../host/registry'
import { ProcRegistry, type RegistryProc } from '../../host/procRegistry'
import { registrySessions } from '../../host/sessions'
import { createRemoteSessions } from '../../host/remoteSessions'
import { createHostOrch } from '../../host/orch'
import { attachGatewayLink } from '../../host/gatewayLink'
import { createControllerRegistry } from '../../host/controllers'
import { emptyState } from '../../core/orchestration/state'
import { buildCertificate, certificatePem, spkiSha256 } from '../../core/remote/cert'
import { connectRuntime, type RuntimeLink } from '../../core/remote/client'
import { openRemoteLink } from '../../core/remote/link'
import type { Account } from '../../core/types'
import { startGateway } from '../../cli/runtime/gateway'
import { createRemoteRuntimeClient, type RemoteRuntimeClient } from './runtimeClient'
import { createRemoteStreams } from './remoteStreams'
import { followRolls, refOf, type RemoteSessionRow } from '../../renderer/src/lib/remoteSessions'

const identity = (() => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    certPem: certificatePem(buildCertificate({ privateKey, publicKey, runtimeId: 'rt_p9b', san: '127.0.0.1', now: new Date() })),
    spkiSha256: spkiSha256(publicKey)
  }
})()
const HELLO = {
  runtimeId: 'rt_p9b',
  displayName: 'Office',
  asteraVersion: '9.9.9',
  hostProtocol: 4,
  gatewayProtocol: 1,
  bootId: 'boot-p9b',
  platform: process.platform,
  pathStyle: 'windows' as const,
  capabilities: ['pty.seq', 'pty.checkpoint']
}

let dir: string
const cleanups: Array<() => Promise<void> | void> = []
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-p9b-'))
  // The folder is a registered project there: a controller starts sessions only in one (§4.8).
  const state = { ...emptyState(), projects: [{ id: 'proj', path: dir, name: 'repo', addedAt: new Date().toISOString() }] }
  await fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(state), 'utf8')
})
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const eventually = (check: () => void | Promise<void>): Promise<void> => vi.waitFor(check, { timeout: 15_000, interval: 20 })

async function runtime(o: { streamPerKey?: number } = {}) {
  const made = new Map<string, { sent: string[]; emit(d: string): void }>()
  let next = ''
  const ptys = new PtyRegistry({
    spawn: () => {
      let onData: (d: string) => void = () => {}
      let onExit: (e: { exitCode: number }) => void = () => {}
      const rec = { sent: [] as string[], emit: (d: string) => onData(d) }
      made.set(next, rec)
      return {
        pid: 1,
        onData: (cb) => void (onData = cb),
        onExit: (cb) => void (onExit = cb),
        write: (d) => void rec.sent.push(d),
        resize: () => {},
        kill: () => onExit({ exitCode: 0 }),
        pause: () => {},
        resume: () => {}
      } satisfies RegistryPty
    },
    log: () => {},
    bootId: 'boot-p9b'
  })
  const procs = new ProcRegistry({ spawn: (): RegistryProc => ({ pid: 2, onData: () => {}, onExit: () => {}, write: () => {}, kill: () => {} }), log: () => {} })
  const hooks = path.join(dir, 'hook-events')
  await fs.mkdir(hooks, { recursive: true })
  const accounts: Account[] = [{ id: 'cl', label: 'Claude', configDir: path.join(dir, 'cl'), color: '#000', createdAt: 'x', provider: 'claude' }]
  await fs.writeFile(path.join(dir, 'accounts.json'), JSON.stringify({ accounts }), 'utf8')
  const sessions = registrySessions({ ptys, procs, hookEventsDir: hooks, accounts: async () => accounts })
  const remote = createRemoteSessions({
    ptys,
    procs,
    sessions,
    holdersOf: () => [],
    hasApp: () => false,
    askApp: async () => null,
    statusLinePayload: async () => null,
    accounts: async () => accounts,
    chats: null as never
  })
  let n = 0
  const open = (sessionId: string, accountId: string, extra: Record<string, unknown> = {}) => {
    const ptyId = `pty-${sessionId}`
    next = ptyId
    ptys.open({ id: ptyId, file: 'agent', args: [], opts: { cwd: dir, cols: 80, rows: 24, env: {} }, meta: { kind: 'session', id: sessionId, restore: { accountId, cwd: dir, title: sessionId, ...extra } } })
    return made.get(ptyId)!
  }
  const orch = createHostOrch({
    profileDir: dir,
    version: '9.9.9',
    now: () => new Date().toISOString(),
    hostStartedAt: () => new Date().toISOString(),
    runningSessions: () => 1,
    aliveSessionIds: () => new Set(),
    act: async () => ({}),
    hasApp: () => false,
    onState: () => {},
    log: () => {},
    sessions: { ...sessions, sendChat: async () => {}, serial: (_id, run) => run() },
    remoteSessions: remote,
    // The Host's starter, as far as this test needs it: a terminal session in a new pty, answered as its row.
    createSession: async (spec) => {
      const id = `s${++n}`
      open(id, spec.accountId)
      return { id, kind: 'terminal', title: spec.title ?? id, accountId: spec.accountId, cwd: spec.cwd, alive: true, state: 'running', ptyId: `pty-${id}`, provider: 'claude' } as never
    }
  })
  const controllers = createControllerRegistry()
  const logs: string[] = []
  const toHost = new PassThrough()
  const fromHost = new PassThrough()
  // What the Host writes to the Gateway goes through here, so a test can stop the Gateway reading it (a slow link).
  const hostOut = new PassThrough({ highWaterMark: 1024 })
  hostOut.pipe(fromHost)
  const link = attachGatewayLink({
    linkGen: 1,
    input: toHost,
    output: hostOut,
    controllers,
    orch: { call: (c) => orch.call(c) },
    hello: () => HELLO,
    log: (m) => void logs.push(m),
    onReady: () => {},
    onFailed: () => {},
    onHardCap: () => {},
    ptys,
    ...(o.streamPerKey !== undefined ? { streamPerKey: o.streamPerKey } : {})
  })
  const started = await startGateway({ identity, listen: '127.0.0.1', port: 0, link: { input: fromHost, output: toHost } })
  if ('error' in started) throw new Error(started.error.message)
  cleanups.push(async () => {
    link.detach()
    await started.close()
    remote.dispose()
  })
  return {
    port: started.port,
    controllers,
    made,
    logs,
    open,
    jam: () => {
      hostOut.unpipe(fromHost)
      hostOut.pause()
    },
    unjam: () => void hostOut.pipe(fromHost)
  }
}

/** The app's side: a paired client over a link whose connection a test can drop and hold, and the streams that forward
 *  a tab's pty to the renderer, here a list of the messages it would get. */
async function app(rt: Awaited<ReturnType<typeof runtime>>, permission: 'read-only' | 'full-control' = 'full-control') {
  const pairing = rt.controllers.createPairing({ permission })
  const first = await connectRuntime({ host: '127.0.0.1', port: rt.port, pin: identity.spkiSha256 })
  const paired = await first.redeem(pairing.code, 'laptop', {})
  first.close()
  let current: RuntimeLink | null = null
  let gate: Promise<void> | null = null
  let release: () => void = () => {}
  const link = openRemoteLink({
    target: { runtimeId: 'rt_p9b', address: '127.0.0.1', port: rt.port, fingerprint: identity.spkiSha256, token: paired.token },
    client: { surface: 'desktop' },
    connect: async (c) => {
      if (gate) await gate
      current = await connectRuntime(c)
      return current
    },
    sleep: async () => {},
    random: () => 0.5
  })
  const client: RemoteRuntimeClient = createRemoteRuntimeClient({ runtimeId: 'rt_p9b', link })
  const sent: Array<{ channel: string; payload: Record<string, unknown> }> = []
  const streams = createRemoteStreams({ clientOf: async () => client, send: (channel, payload) => void sent.push({ channel, payload: payload as Record<string, unknown> }) })
  cleanups.push(() => {
    streams.close()
    client.close()
  })
  /** What the tab would show for `key`: its last checkpoint, then the data after it. */
  const shown = (key: string): string => {
    const mine = sent.filter((s) => s.payload.sessionId === key)
    const at = mine.map((s) => s.channel).lastIndexOf('session:reset')
    if (at < 0) return ''
    const reset = mine[at].payload as { state: string; pending: string }
    return reset.state + reset.pending + mine.slice(at + 1).filter((s) => s.channel === 'session:data').map((s) => s.payload.data).join('')
  }
  return {
    client,
    streams,
    sent,
    shown,
    resets: (key: string) => sent.filter((s) => s.channel === 'session:reset' && s.payload.sessionId === key).length,
    offline: async () => {
      gate = new Promise((r) => (release = r))
      const was = current
      was?.close()
      await was?.closed
    },
    online: () => {
      gate = null
      release()
    }
  }
}

const count = (text: string, part: string): number => text.split(part).length - 1

describe('Remote Runtime Phase 9b acceptance (remote session tabs from the app)', { timeout: 60_000 }, () => {
  it('a session started there is attached here: its checkpoint first, then its output, and the tab types into it', async () => {
    const rt = await runtime()
    const a = await app(rt)
    const created = await a.client.command('sessions-create', { kind: 'terminal', account: 'cl', cwd: dir, title: 'fix' })
    expect(created.status).toBe(200)
    const ref = refOf('rt_p9b', created.body as RemoteSessionRow)
    expect(ref).toMatchObject({ key: 'rt_p9b:s1', ptyId: 'pty-s1' })
    const pty = rt.made.get('pty-s1')!
    pty.emit('before attach ')

    expect(await a.streams.attach(ref.runtimeId, ref.sessionId, ref.ptyId!)).toBe(true)
    await eventually(() => expect(a.shown(ref.key)).toContain('before attach'))
    expect(a.sent.find((s) => s.payload.sessionId === ref.key)?.channel).toBe('session:reset')
    pty.emit('after attach')
    await eventually(() => expect(a.shown(ref.key)).toContain('after attach'))

    expect(await a.client.command('sessions-input', { id: ref.sessionId, data: 'go\r' })).toMatchObject({ status: 200 })
    expect(pty.sent).toEqual(['go\r'])
  })

  it('a dropped and restored connection carries on with each output once', async () => {
    const rt = await runtime()
    const a = await app(rt)
    const pty = rt.open('t1', 'cl')
    await a.streams.attach('rt_p9b', 't1', 'pty-t1')
    pty.emit('ONE ')
    await eventually(() => expect(a.shown('rt_p9b:t1')).toContain('ONE'))
    await a.offline()
    pty.emit('TWO ')
    a.online()
    await new Promise((r) => setTimeout(r, 50))
    pty.emit('THREE')
    await eventually(() => expect(a.shown('rt_p9b:t1')).toContain('THREE'))
    const text = a.shown('rt_p9b:t1')
    expect([count(text, 'ONE'), count(text, 'TWO'), count(text, 'THREE')]).toEqual([1, 1, 1])
  })

  // The stream ends with OUTPUT_GAP and the link asks again from the last seq it handed on: the Host replays what its
  // ring still holds, or sends a checkpoint when it is past it. Either way the tab shows each line once (Phase 9b ruling:
  // the plan's "a reset" is only the second case).
  it('a flood past the stream’s share is picked up again with every line once and the latest output', async () => {
    const rt = await runtime({ streamPerKey: 16 * 1024 })
    const a = await app(rt)
    const pty = rt.open('t1', 'cl')
    await a.streams.attach('rt_p9b', 't1', 'pty-t1')
    await eventually(() => expect(a.resets('rt_p9b:t1')).toBe(1))
    rt.jam()
    // In separate batches, as a busy program writes: the registry joins output that arrives together into one event,
    // and one event goes out whole.
    for (let b = 0; b < 40; b++) {
      for (let i = 0; i < 10; i++) pty.emit(`line ${b * 10 + i} ${'x'.repeat(100)}\r\n`)
      await new Promise((r) => setTimeout(r, 10))
    }
    pty.emit('LATEST')
    await new Promise((r) => setTimeout(r, 100))
    rt.unjam()
    await eventually(() => expect(a.shown('rt_p9b:t1')).toContain('LATEST'))
    expect(rt.logs.some((m) => m.includes('fell behind its budget'))).toBe(true)
    const text = a.shown('rt_p9b:t1')
    expect(count(text, 'LATEST')).toBe(1)
    const seen = Array.from({ length: 400 }, (_, i) => count(text, `line ${i} x`))
    expect(seen.every((c) => c === 1)).toBe(true)
  })

  it('a roll is followed: the tab’s session gives way to the one rolled from it, attached from its own checkpoint', async () => {
    const rt = await runtime()
    const a = await app(rt)
    rt.open('old', 'cl')
    const before = (await a.client.command('sessions-list', {})).body as RemoteSessionRow[]
    const open = [refOf('rt_p9b', before.find((r) => r.id === 'old')!)]
    const fresh = rt.open('new', 'cl', { rolledFrom: 'old' })
    fresh.emit('rolled in')
    const rows = (await a.client.command('sessions-list', {})).body as RemoteSessionRow[]
    const [roll] = followRolls(open, rows)
    expect(roll).toMatchObject({ from: 'rt_p9b:old', to: { key: 'rt_p9b:new', ptyId: 'pty-new' } })
    await a.streams.attach(roll.to.runtimeId, roll.to.sessionId, roll.to.ptyId!)
    await eventually(() => expect(a.shown('rt_p9b:new')).toContain('rolled in'))
  })

  it('a read-only pairing watches a session and cannot type into it, resize it or end it', async () => {
    const rt = await runtime()
    const a = await app(rt, 'read-only')
    const pty = rt.open('t1', 'cl')
    await a.streams.attach('rt_p9b', 't1', 'pty-t1')
    pty.emit('visible')
    await eventually(() => expect(a.shown('rt_p9b:t1')).toContain('visible'))
    for (const [cmd, args] of [
      ['sessions-input', { id: 't1', data: 'x' }],
      ['sessions-resize', { id: 't1', cols: 100, rows: 30 }],
      ['sessions-stop', { id: 't1' }]
    ] as const)
      expect((await a.client.command(cmd, args)).status).toBe(403)
    expect(pty.sent).toEqual([])
  })
})
