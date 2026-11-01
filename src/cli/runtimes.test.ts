import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveRuntime, runRuntimesCommand, controllerRegistry, type RuntimesDeps } from './runtimes'
import { RemoteError, type RuntimeLink } from '../core/remote/client'
import { formatPairing } from '../core/remote/pairing'
import type { RuntimeProfile } from '../core/runtimes/registry'
import type { RemoteAnswer, RemoteLink, RemoteTarget } from '../core/remote/link'
import type { ClientInfo, HelloFrame } from '../core/remote/frames'
import { REPORT_CAPABILITY, type ControlPlaneReport, type ReportExtension } from '../core/controlPlane/report'

const FP = 'A'.repeat(43)
const NOW = '2026-10-08T00:00:00.000Z'
let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-runtimes-'))
})
afterEach(async () => fs.rm(dir, { recursive: true, force: true }))

const profile = (over: Partial<RuntimeProfile> = {}): RuntimeProfile => ({
  runtimeId: 'rt_a', name: 'Office', address: '10.0.0.2', port: 47831, fingerprint: FP, permission: 'full-control', createdAt: NOW, lastSeenAt: null, ...over
})

/** A Runtime that pairs with code `GOODCODE01` and pins FP. */
function deps(over: Partial<RuntimesDeps> = {}) {
  const seen: Array<{ host: string; port: number; pin: string }> = []
  const redeemed: Array<{ code: string; name: string }> = []
  const clients: unknown[] = []
  const d: RuntimesDeps = {
    registry: () => controllerRegistry(dir),
    connect: async (o) => {
      seen.push(o)
      if (o.pin !== FP) throw Object.assign(new Error('the Runtime presented a different identity'), { code: 'RUNTIME_IDENTITY_CHANGED' })
      const link: RuntimeLink = {
        redeem: async (code, name) => {
          redeemed.push({ code, name })
          if (code !== 'GOODCODE01') throw new RemoteError('RUNTIME_AUTH_FAILED', 'that pairing code is not valid')
          return { clientId: 'cl_1', token: 'tok-secret-value' }
        },
        auth: async (token, client) => {
          clients.push(client)
          if (token !== 'tok-secret-value') throw new RemoteError('RUNTIME_AUTH_FAILED', 'unknown token')
          return { t: 'hello', runtimeId: 'rt_office', displayName: 'Office PC', asteraVersion: '1.4.8', hostProtocol: 4, gatewayProtocol: 1, bootId: 'b', platform: 'win32', pathStyle: 'windows', permission: 'full-control', capabilities: [] }
        },
        call: async () => ({ status: 200, body: {} }),
        close: () => {},
        closed: new Promise(() => {})
      }
      return link
    },
    hostname: () => 'laptop',
    now: () => NOW,
    version: '1.4.8',
    ...over
  }
  return { d, seen, redeemed, clients }
}

describe('resolveRuntime', () => {
  const list = [profile(), profile({ runtimeId: 'rt_b', name: 'Build' }), profile({ runtimeId: 'rt_c', name: 'build' })]
  it('takes the id first, then a name ignoring case', () => {
    expect(resolveRuntime(list, 'rt_b')).toMatchObject({ runtimeId: 'rt_b' })
    expect(resolveRuntime(list, 'office')).toMatchObject({ runtimeId: 'rt_a' })
  })
  // Phase 4 review M7: a key that is one Runtime's id and another's name is refused, not taken as the id silently.
  it('refuses a key that is one id and another name', () => {
    const odd = [profile(), profile({ runtimeId: 'rt_b', name: 'rt_a' })]
    const r = resolveRuntime(odd, 'rt_a')
    expect(r).toMatchObject({ code: 'RUNTIME_NOT_FOUND' })
    expect((r as { message: string }).message).toMatch(/rt_a.*rt_b|rt_b.*rt_a/)
  })
  it('refuses a name two Runtimes share, naming both ids, and an unknown one', () => {
    const two = resolveRuntime(list, 'BUILD')
    expect(two).toMatchObject({ code: 'RUNTIME_NOT_FOUND' })
    expect((two as { message: string }).message).toMatch(/rt_b.*rt_c/)
    expect(resolveRuntime(list, 'nope')).toMatchObject({ code: 'RUNTIME_NOT_FOUND' })
  })
})

describe('astera runtimes (remote runtime design §4.4, §4.5)', () => {
  // Remote governance design §7.1: the first sign-in says whether a person asked; left out, it says an agent did.
  it('add signs in with the agent flag its caller gave, and as an agent when none was given', async () => {
    const pair = formatPairing({ address: '10.0.0.2', port: 47831, code: 'GOODCODE01', fingerprint: FP })
    const person = deps({ agent: false })
    await runRuntimesCommand('runtimes-add', { pair }, person.d)
    expect(person.clients).toEqual([{ name: 'astera cli', version: '1.4.8', surface: 'cli', agent: false }])
    await fs.rm(dir, { recursive: true, force: true })
    const unsaid = deps()
    await runRuntimesCommand('runtimes-add', { pair }, unsaid.d)
    expect(unsaid.clients).toEqual([{ name: 'astera cli', version: '1.4.8', surface: 'cli', agent: true }])
  })
  it('add with a pairing string pins, redeems, reads the hello, and stores the profile and token; prints no token', async () => {
    const h = deps()
    const pair = formatPairing({ address: '10.0.0.2', port: 47831, code: 'GOODCODE01', fingerprint: FP })
    const r = await runRuntimesCommand('runtimes-add', { pair }, h.d)
    expect(r).toMatchObject({ ok: true, body: { runtimeId: 'rt_office', name: 'Office PC', address: '10.0.0.2', port: 47831, permission: 'full-control' } })
    expect(JSON.stringify(r)).not.toContain('tok-secret-value')
    expect(h.redeemed).toEqual([{ code: 'GOODCODE01', name: 'laptop' }])
    const reg = await controllerRegistry(dir)
    expect(await reg.list()).toEqual([expect.objectContaining({ runtimeId: 'rt_office', fingerprint: FP })])
    expect(await reg.token('rt_office')).toBe('tok-secret-value')
  })
  // Security audit SEC-4: the id comes from the Runtime; under another key it does not replace the Runtime paired here.
  it('add refuses a Runtime that says the id of another one paired here, stores nothing, and --replace takes it', async () => {
    const reg = await controllerRegistry(dir)
    await reg.add(profile({ runtimeId: 'rt_office', fingerprint: 'B'.repeat(43), address: '10.0.0.9' }), 'old-token')
    const h = deps()
    const pair = formatPairing({ address: '10.0.0.2', port: 47831, code: 'GOODCODE01', fingerprint: FP })
    const r = await runRuntimesCommand('runtimes-add', { pair }, h.d)
    expect(r).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(JSON.stringify(r)).toContain('--replace')
    expect(await reg.token('rt_office')).toBe('old-token')
    const again = await runRuntimesCommand('runtimes-add', { pair, replace: true }, h.d)
    expect(again).toMatchObject({ ok: true, body: { runtimeId: 'rt_office', address: '10.0.0.2' } })
  })
  // Final review M-4: the app has no --replace, and a Runtime makes a new id with every new key, so the same id under
  // another key is another machine claiming to be the paired one: the app says that, with no CLI flag in it.
  it('in the app, a Runtime claiming a paired id is refused without pointing at a command-line flag', async () => {
    const reg = await controllerRegistry(dir)
    await reg.add(profile({ runtimeId: 'rt_office', fingerprint: 'B'.repeat(43) }), 'old-token')
    const h = deps({ surface: 'app' })
    const pair = formatPairing({ address: '10.0.0.2', port: 47831, code: 'GOODCODE01', fingerprint: FP })
    const r = await runRuntimesCommand('runtimes-add', { pair }, h.d)
    expect(r).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(JSON.stringify(r)).not.toContain('--replace')
    expect(JSON.stringify(r)).toContain('another machine')
  })
  // Security audit SEC-6: a pairing string on the command line is in the process list for anyone on the machine to
  // read and redeem first. `--pair -` reads it from stdin; a value read that way ends in a newline.
  it('pairs with values read from stdin, their newline and all', async () => {
    const h = deps()
    const pair = `${formatPairing({ address: '10.0.0.2', port: 47831, code: 'GOODCODE01', fingerprint: FP })}\n`
    expect(await runRuntimesCommand('runtimes-add', { pair }, h.d)).toMatchObject({ ok: true })
    const parts = deps()
    const r = await runRuntimesCommand('runtimes-add', { address: '10.0.0.2', code: 'GOODCODE01\r\n', fingerprint: `${FP}\n` }, parts.d)
    expect(r).toMatchObject({ ok: true })
    expect(parts.redeemed[0].code).toBe('GOODCODE01')
  })
  it('add takes --address over the hint, and --name', async () => {
    const h = deps()
    const pair = formatPairing({ address: '10.0.0.2', port: 47831, code: 'GOODCODE01', fingerprint: FP })
    const r = await runRuntimesCommand('runtimes-add', { pair, address: 'office.tail.net', name: 'Desk' }, h.d)
    expect(h.seen[0]).toMatchObject({ host: 'office.tail.net', port: 47831 })
    expect(r).toMatchObject({ ok: true, body: { name: 'Desk', address: 'office.tail.net' } })
  })
  it('the decomposed form needs the fingerprint', async () => {
    const r = await runRuntimesCommand('runtimes-add', { address: '10.0.0.2', code: 'GOODCODE01' }, deps().d)
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'pairing needs the fingerprint the Runtime printed' } })
  })
  it('a different key refuses before the code is sent, and stores nothing', async () => {
    const h = deps()
    const pair = formatPairing({ address: '10.0.0.2', port: 47831, code: 'GOODCODE01', fingerprint: 'B'.repeat(43) })
    expect(await runRuntimesCommand('runtimes-add', { pair }, h.d)).toMatchObject({ ok: false, error: { code: 'RUNTIME_IDENTITY_CHANGED' } })
    expect(h.redeemed).toEqual([])
    expect(await (await controllerRegistry(dir)).list()).toEqual([])
  })
  it('a wrong code says so and stores nothing', async () => {
    const pair = formatPairing({ address: '10.0.0.2', port: 47831, code: 'WRONGCODE1', fingerprint: FP })
    expect(await runRuntimesCommand('runtimes-add', { pair }, deps().d)).toMatchObject({ ok: false, error: { code: 'RUNTIME_AUTH_FAILED' } })
    expect(await (await controllerRegistry(dir)).list()).toEqual([])
  })
  // Phase 4 review M5: a Runtime of another remote protocol is not stored, and a pairing left behind is named.
  it('a Runtime of another remote protocol is refused and not stored, and the message says the pairing stays there', async () => {
    const h = deps()
    const base = h.d.connect
    h.d.connect = async (o) => {
      const l = await base(o)
      return { ...l, auth: async (t, c) => ({ ...(await l.auth(t, c)), gatewayProtocol: 2 }) }
    }
    const pair = formatPairing({ address: '10.0.0.2', port: 47831, code: 'GOODCODE01', fingerprint: FP })
    const r = await runRuntimesCommand('runtimes-add', { pair }, h.d)
    expect(r).toMatchObject({ ok: false, error: { code: 'RUNTIME_PROTOCOL_MISMATCH', message: expect.stringMatching(/runtime revoke/) } })
    expect(await (await controllerRegistry(dir)).list()).toEqual([])
  })
  it('a first sign-in that fails after the code was redeemed says the pairing stays on the Runtime', async () => {
    const h = deps()
    const base = h.d.connect
    let n = 0
    h.d.connect = async (o) => (++n === 1 ? base(o) : Promise.reject(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' })))
    const pair = formatPairing({ address: '10.0.0.2', port: 47831, code: 'GOODCODE01', fingerprint: FP })
    const r = await runRuntimesCommand('runtimes-add', { pair }, h.d)
    expect(r).toMatchObject({ ok: false, error: { message: expect.stringMatching(/runtime revoke/) } })
  })
  // Second pass RR-5: a mistyped or firewalled address held the Pair button for the OS's connect wait, and a Runtime that
  // took the code and never answered held it for good.
  it('a Runtime that does not answer the pairing in time is RUNTIME_OFFLINE, and the connection is closed', async () => {
    let closed = 0
    const h = deps({
      connect: async () => ({
        redeem: () => new Promise(() => {}),
        auth: () => new Promise(() => {}),
        call: async () => ({ status: 200, body: {} }),
        close: () => void closed++,
        closed: new Promise(() => {})
      }),
      timeoutMs: 30
    })
    const pair = formatPairing({ address: '10.0.0.2', port: 47831, code: 'GOODCODE01', fingerprint: FP })
    expect(await runRuntimesCommand('runtimes-add', { pair }, h.d)).toMatchObject({ ok: false, error: { code: 'RUNTIME_OFFLINE' } })
    expect(closed).toBe(1)
  })
  it('a connect that never completes is RUNTIME_OFFLINE in time', async () => {
    const h = deps({ connect: () => new Promise(() => {}), timeoutMs: 30 })
    const pair = formatPairing({ address: '10.0.0.2', port: 47831, code: 'GOODCODE01', fingerprint: FP })
    expect(await runRuntimesCommand('runtimes-add', { pair }, h.d)).toMatchObject({ ok: false, error: { code: 'RUNTIME_OFFLINE' } })
  })
  it('an unreachable Runtime is RUNTIME_OFFLINE', async () => {
    const h = deps({ connect: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) } })
    const pair = formatPairing({ address: '10.0.0.2', port: 47831, code: 'GOODCODE01', fingerprint: FP })
    expect(await runRuntimesCommand('runtimes-add', { pair }, h.d)).toMatchObject({ ok: false, error: { code: 'RUNTIME_OFFLINE' } })
  })
  it('list shows the profiles and no token; remove deletes one and says it did not revoke', async () => {
    const reg = await controllerRegistry(dir)
    await reg.add(profile(), 'tok-a')
    const listed = await runRuntimesCommand('runtimes-list', {}, deps().d)
    expect(listed).toMatchObject({ ok: true, body: [expect.objectContaining({ runtimeId: 'rt_a' })] })
    expect(JSON.stringify(listed)).not.toContain('tok-a')
    const removed = await runRuntimesCommand('runtimes-remove', { id: 'Office' }, deps().d)
    expect(removed).toMatchObject({ ok: true, body: { removed: 'rt_a', revoked: false } })
    expect(await reg.list()).toEqual([])
    expect(await runRuntimesCommand('runtimes-remove', { id: 'rt_a' }, deps().d)).toMatchObject({ ok: false, error: { code: 'RUNTIME_NOT_FOUND' } })
  })
  // Remote governance design §4.1, ruling C9: the sign-in hello's facts are kept with the pairing
  it('add keeps the facts the sign-in hello said', async () => {
    const pair = formatPairing({ address: '10.0.0.2', port: 47831, code: 'GOODCODE01', fingerprint: FP })
    await runRuntimesCommand('runtimes-add', { pair }, deps().d)
    const [kept] = await (await controllerRegistry(dir)).list()
    expect(kept.facts).toMatchObject({ asteraVersion: '1.4.8', platform: 'win32', hostProtocol: 4, capabilities: [] })
  })
})

describe('astera runtimes get, ping and expect (remote governance design §10.2, §4.3, §5.4, §6.1)', () => {
  const OLD = '2026-10-01T00:00:00.000Z'
  const HASH = (c: string): string => `cmp1:sha256:${c.repeat(64)}`
  const ext = (id: string, kind: ReportExtension['kind'], over: Partial<ReportExtension> = {}): ReportExtension => ({ id, kind, name: id, enabled: true, providers: ['claude'], ...over })
  const LOCAL: ReportExtension[] = [ext('skill-a', 'skill', { compareHash: HASH('a') }), ext('mcp-x', 'mcp', { secretNames: [] })]
  const report = (extensions: ReportExtension[] | null): ControlPlaneReport => ({
    version: 1,
    astera: { version: '1.5.0', platform: 'darwin' },
    extensions,
    profiles: [],
    appBypass: false,
    policy: null,
    sandbox: { claude: { kind: 'sandbox', blocker: null }, codex: { kind: 'deny-only', blocker: null } },
    credentials: null,
    secretStore: { kind: 'owner-only-files', ok: true },
    findings: null
  })
  const THERE = report([ext('skill-a', 'skill', { compareHash: HASH('b') }), ext('skill-z', 'skill', { compareHash: HASH('z') })])
  const hello = (over: Partial<HelloFrame> = {}): HelloFrame => ({
    t: 'hello', runtimeId: 'rt_a', displayName: 'Office', asteraVersion: '1.5.0', hostProtocol: 4, gatewayProtocol: 1, bootId: 'b', platform: 'darwin', pathStyle: 'posix', permission: 'full-control', capabilities: [REPORT_CAPABILITY], ...over
  })

  /** A paired Runtime behind the `link` seam: `h` null is one that never answers. Each call says the hello first, as a
   *  connection does. */
  function remote(answers: Record<string, RemoteAnswer>, h: HelloFrame | null = hello()) {
    const opened: Array<{ target: RemoteTarget; client: ClientInfo }> = []
    const calls: string[] = []
    let closed = 0
    const link = (target: RemoteTarget, o: { onHello(h: HelloFrame): void; client: ClientInfo }): RemoteLink => {
      opened.push({ target, client: o.client })
      let heard: HelloFrame | null = null
      return {
        hello: () => heard,
        call: async (cmd) => {
          calls.push(cmd)
          if (h === null) return new RemoteError('RUNTIME_OFFLINE', 'connect ECONNREFUSED 10.0.0.2:47831')
          heard = h
          o.onHello(h)
          return answers[cmd] ?? { status: 404, body: { error: `unknown ${cmd}` } }
        },
        subscribe: () => () => {},
        close: () => void closed++
      }
    }
    return { link, opened, calls, closedCount: () => closed }
  }
  const getDeps = (r: ReturnType<typeof remote>, over: Partial<RuntimesDeps> = {}) =>
    deps({ link: r.link, localExtensions: async () => LOCAL, version: '1.5.0', ...over }).d
  const pairOne = async (over: Partial<RuntimeProfile> = {}) => {
    const reg = await controllerRegistry(dir)
    await reg.add(profile(over), 'tok-a')
    return reg
  }

  it('get reads, keeps the snapshot with its time, and answers the comparison', async () => {
    const reg = await pairOne()
    await reg.setExpected('rt_a', ['skill-a', 'mcp-x'])
    const r = remote({ 'control-plane-report': { status: 200, body: THERE } })
    const got = await runRuntimesCommand('runtimes-get', { id: 'Office' }, getDeps(r))
    expect(got).toMatchObject({
      ok: true,
      body: {
        runtimeId: 'rt_a',
        name: 'Office',
        here: '1.5.0',
        older: false,
        answering: true,
        facts: { asteraVersion: '1.5.0', platform: 'darwin' },
        snapshot: { readAt: NOW, report: THERE }
      }
    })
    const body = (got as { body: { comparison: Array<{ id: string; state: string | null; expected: boolean }>; refusal?: unknown } }).body
    expect(body.refusal).toBeUndefined()
    expect(body.comparison.map((c) => [c.id, c.expected, c.state])).toEqual([
      ['mcp-x', true, 'missing'],
      ['skill-a', true, 'different'],
      ['skill-z', false, null]
    ])
    const [kept] = await reg.list()
    expect(kept.snapshot).toEqual({ readAt: NOW, report: THERE })
    // Ruling C9: the hello's facts and the time it answered are kept, as answerRemote keeps them
    expect(kept.facts).toMatchObject({ asteraVersion: '1.5.0', platform: 'darwin', capabilities: [REPORT_CAPABILITY] })
    expect(kept.lastSeenAt).not.toBeNull()
    expect(r.calls).toEqual(['control-plane-report'])
    expect(r.opened[0].target).toMatchObject({ runtimeId: 'rt_a', address: '10.0.0.2', port: 47831, fingerprint: FP, token: 'tok-a' })
    expect(r.closedCount()).toBe(1)
  })

  it('get with the Runtime offline answers the last snapshot and says so, exit 0', async () => {
    const reg = await pairOne()
    await reg.keepSnapshot('rt_a', { readAt: OLD, report: THERE })
    const got = await runRuntimesCommand('runtimes-get', { id: 'rt_a' }, getDeps(remote({}, null)))
    expect(got).toMatchObject({
      ok: true,
      body: { answering: false, snapshot: { readAt: OLD, report: THERE }, refusal: { code: 'RUNTIME_OFFLINE' }, facts: null, lastSeenAt: null }
    })
    expect((await reg.list())[0]).toMatchObject({ snapshot: { readAt: OLD }, lastSeenAt: null })
  })

  // §4.3: a Runtime older than this app is shown with both versions and told to update, never refused bare
  it('get of an older Runtime shows its facts and the update message', async () => {
    await pairOne()
    const r = remote({ 'control-plane-report': { status: 501, body: { error: 'unknown command control-plane-report' } } }, hello({ asteraVersion: '1.4.8', capabilities: [] }))
    const got = await runRuntimesCommand('runtimes-get', { id: 'rt_a' }, getDeps(r))
    expect(got).toMatchObject({
      ok: true,
      body: {
        facts: { asteraVersion: '1.4.8' },
        here: '1.5.0',
        older: true,
        answering: true,
        snapshot: null,
        refusal: { code: 'RUNTIME_CAPABILITY_MISSING', message: 'this Runtime cannot report its setup; update Astera there' }
      }
    })
  })

  it('ping answers with version and OS, or does not answer with the code', async () => {
    const reg = await pairOne()
    const up = remote({ 'projects-list': { status: 200, body: [] } }, hello({ asteraVersion: '1.5.1', platform: 'linux' }))
    expect(await runRuntimesCommand('runtimes-ping', { id: 'Office' }, getDeps(up))).toEqual({
      ok: true,
      body: { runtimeId: 'rt_a', answers: true, asteraVersion: '1.5.1', platform: 'linux' }
    })
    expect(up.calls).toEqual(['projects-list'])
    // Ruling C9: what the hello said and when it answered
    expect((await reg.list())[0]).toMatchObject({ facts: { asteraVersion: '1.5.1', platform: 'linux' }, lastSeenAt: expect.any(String) })
    expect(await runRuntimesCommand('runtimes-ping', { id: 'rt_a' }, getDeps(remote({}, null)))).toEqual({
      ok: true,
      body: { runtimeId: 'rt_a', answers: false, code: 'RUNTIME_OFFLINE' }
    })
  })

  it('expect adds, removes and lists; an id unknown here is 400', async () => {
    const reg = await pairOne()
    const d = getDeps(remote({}))
    expect(await runRuntimesCommand('runtimes-expect', { id: 'Office', add: 'skill-a, mcp-x' }, d)).toEqual({ ok: true, body: { runtimeId: 'rt_a', expected: ['skill-a', 'mcp-x'] } })
    expect(await runRuntimesCommand('runtimes-expect', { id: 'Office', remove: 'skill-a' }, d)).toEqual({ ok: true, body: { runtimeId: 'rt_a', expected: ['mcp-x'] } })
    expect(await runRuntimesCommand('runtimes-expect', { id: 'Office' }, d)).toEqual({ ok: true, body: { runtimeId: 'rt_a', expected: ['mcp-x'] } })
    expect((await reg.list())[0].expected).toEqual(['mcp-x'])
    const unknown = await runRuntimesCommand('runtimes-expect', { id: 'Office', add: 'skill-a,nope' }, d)
    expect(unknown).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENTS', message: expect.stringContaining('nope') } })
    // Refused whole: the id that is here is not added either
    expect((await reg.list())[0].expected).toEqual(['mcp-x'])
  })

  // Remote governance design §7.1: the Runtime answers its report only to a person's shell
  it('the links get and ping open say agent false from a person\'s shell and true from a session', async () => {
    await pairOne()
    for (const [agent, said] of [[false, false], [true, true], [undefined, true]] as const) {
      const r = remote({ 'control-plane-report': { status: 200, body: THERE }, 'projects-list': { status: 200, body: [] } })
      await runRuntimesCommand('runtimes-get', { id: 'rt_a' }, getDeps(r, { agent }))
      await runRuntimesCommand('runtimes-ping', { id: 'rt_a' }, getDeps(r, { agent }))
      expect(r.opened.map((o) => o.client)).toEqual([0, 1].map(() => ({ name: 'astera cli', version: '1.5.0', surface: 'cli', agent: said })))
    }
  })
})
