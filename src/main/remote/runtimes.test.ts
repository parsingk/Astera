import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRemoteRuntimes } from './runtimes'
import { controllerRegistry } from '../../cli/runtimes'
import type { RemoteLink, RemoteTarget } from '../../core/remote/link'
import type { HelloFrame } from '../../core/remote/frames'
import { staleRuntimeFindings } from '../../core/findings/rules/runtimes'
import { RemoteError } from '../../core/remote/client'
import { REPORT_CAPABILITY, type ControlPlaneReport, type ReportExtension } from '../../core/controlPlane/report'
import { SNAPSHOT_TOO_LARGE } from '../../core/runtimes/registry'

const FP = 'F'.repeat(43)
let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-app-runtimes-'))
  await (await controllerRegistry(dir)).add(
    { runtimeId: 'rt_a', name: 'Office', address: '10.0.0.2', port: 47831, fingerprint: FP, permission: 'full-control', createdAt: 'x', lastSeenAt: null },
    'tok-a'
  )
})
afterEach(async () => fs.rm(dir, { recursive: true, force: true }))

const opener = () => {
  const opened: RemoteTarget[] = []
  const closed: string[] = []
  const open = (t: RemoteTarget): RemoteLink => {
    opened.push(t)
    return { hello: () => null, call: async () => ({ status: 200, body: {} }), subscribe: () => () => {}, close: () => void closed.push(t.token) }
  }
  return { open, opened, closed }
}

const HELLO: HelloFrame = {
  t: 'hello', runtimeId: 'rt_a', displayName: 'Office', asteraVersion: '1.5.0', hostProtocol: 4, gatewayProtocol: 1, bootId: 'b1',
  platform: 'darwin', pathStyle: 'posix', permission: 'full-control', capabilities: ['pty.seq']
}
/** Links that say hello at their first call, as a real one does at its first connection. */
const helloing = () => {
  const open = (_t: RemoteTarget, o?: { onHello?(h: HelloFrame): void }): RemoteLink => {
    let said = false
    return {
      hello: () => (said ? HELLO : null),
      call: async () => {
        if (!said) {
          said = true
          o?.onHello?.(HELLO)
        }
        return { status: 200, body: [] }
      },
      subscribe: () => () => {},
      close: () => {}
    }
  }
  return { open }
}

describe('createRemoteRuntimes (remote runtime design §2.7, D1.1)', () => {
  it('an id nobody paired is RUNTIME_NOT_FOUND', async () => {
    const r = createRemoteRuntimes({ profileDir: dir, version: '1.4.8', open: opener().open })
    expect(await r.client('rt_nope')).toMatchObject({ code: 'RUNTIME_NOT_FOUND' })
  })
  it('keeps one client per Runtime', async () => {
    const o = opener()
    const r = createRemoteRuntimes({ profileDir: dir, version: '1.4.8', open: o.open })
    const a = await r.client('rt_a')
    const b = await r.client('rt_a')
    expect(a).toBe(b)
    expect(o.opened).toHaveLength(1)
  })
  it('a re-pair opens a new client and closes the old one; close closes all', async () => {
    const o = opener()
    const r = createRemoteRuntimes({ profileDir: dir, version: '1.4.8', open: o.open })
    await r.client('rt_a')
    await (await controllerRegistry(dir)).add(
      { runtimeId: 'rt_a', name: 'Office', address: '10.0.0.2', port: 47831, fingerprint: FP, permission: 'full-control', createdAt: 'y', lastSeenAt: null },
      'tok-b'
    )
    await r.client('rt_a')
    expect(o.opened.map((t) => t.token)).toEqual(['tok-a', 'tok-b'])
    expect(o.closed).toEqual(['tok-a'])
    r.close()
    expect(o.closed).toEqual(['tok-a', 'tok-b'])
  })

  // Phase 5 review I-1: two first calls at once share one client and one link.
  it('two first calls at once open one link', async () => {
    const o = opener()
    const r = createRemoteRuntimes({ profileDir: dir, version: '1.4.8', open: o.open })
    const [a, b] = await Promise.all([r.client('rt_a'), r.client('rt_a')])
    expect(a).toBe(b)
    expect(o.opened).toHaveLength(1)
  })

  // Phase 6: what Settings › Remote Runtimes shows and does.
  it('list shows each paired Runtime without its token, with offline unknown until asked', async () => {
    const r = createRemoteRuntimes({ profileDir: dir, version: '1.4.8', open: opener().open })
    const listed = await r.list()
    expect(listed).toEqual([expect.objectContaining({ runtimeId: 'rt_a', name: 'Office', offline: null })])
    expect(JSON.stringify(listed)).not.toContain('tok-a')
  })
  // Phase 6 review minor: what the list says about a Runtime is what this app last heard from it.
  it('list says offline and last seen from the last call this app made', async () => {
    const r = createRemoteRuntimes({
      profileDir: dir,
      version: '1.4.8',
      open: () => ({ hello: () => null, call: async () => ({ status: 200, body: [] }), subscribe: () => () => {}, close: () => {} })
    })
    const c = await r.client('rt_a')
    if ('code' in c) throw new Error(c.code)
    await c.projects()
    const [listed] = await r.list()
    expect(listed.offline).toBe(false)
    expect(listed.lastSeenAt).not.toBeNull()
  })
  // Remote governance design §4.1, §4.4, §9.1: what the app reaches is saved, so the findings and the CLI see it too.
  it('an answered call saves lastSeenAt and the hello\'s facts', async () => {
    const r = createRemoteRuntimes({ profileDir: dir, version: '1.4.8', open: helloing().open })
    const c = await r.client('rt_a')
    if ('code' in c) throw new Error(c.code)
    await c.projects()
    await vi.waitFor(async () => {
      const [p] = await (await controllerRegistry(dir)).list()
      expect(p.lastSeenAt).not.toBeNull()
      expect(p.facts).toMatchObject({ asteraVersion: '1.5.0', platform: 'darwin', hostProtocol: 4, capabilities: ['pty.seq'] })
    })
  })
  it('list() carries asteraVersion and platform from the kept facts', async () => {
    const r = createRemoteRuntimes({ profileDir: dir, version: '1.4.8', open: helloing().open })
    expect((await r.list())[0]).not.toHaveProperty('asteraVersion')
    const c = await r.client('rt_a')
    if ('code' in c) throw new Error(c.code)
    await c.projects()
    await vi.waitFor(async () => expect((await r.list())[0]).toMatchObject({ asteraVersion: '1.5.0', platform: 'darwin' }))
  })
  // Remote governance design §9.1: only the CLI saved lastSeenAt, so a Runtime the app used every day read as never
  // reached, and stale, 30 days after it was paired.
  it('a Runtime the app reached yesterday raises no stale-runtime', async () => {
    const registry = await controllerRegistry(dir)
    const DAY = 24 * 60 * 60 * 1000
    await registry.add(
      { runtimeId: 'rt_a', name: 'Office', address: '10.0.0.2', port: 47831, fingerprint: FP, permission: 'full-control', createdAt: new Date(Date.now() - 100 * DAY).toISOString(), lastSeenAt: null },
      'tok-a'
    )
    const r = createRemoteRuntimes({ profileDir: dir, version: '1.4.8', open: opener().open })
    const c = await r.client('rt_a')
    if ('code' in c) throw new Error(c.code)
    await c.projects()
    await vi.waitFor(async () => expect((await registry.list())[0].lastSeenAt).not.toBeNull())
    const nowMs = Date.now() + DAY
    expect(staleRuntimeFindings({ nowMs, platform: 'linux', findingsSince: new Date(nowMs - 400 * DAY).toISOString(), runtimes: await registry.list() })).toEqual([])
  })
  it('remove forgets a Runtime and closes its client; an unknown id is NOT_FOUND', async () => {
    const o = opener()
    const r = createRemoteRuntimes({ profileDir: dir, version: '1.4.8', open: o.open })
    await r.client('rt_a')
    expect(await r.remove('rt_a')).toEqual({ ok: true })
    expect(o.closed).toEqual(['tok-a'])
    expect(await r.list()).toEqual([])
    expect(await r.remove('rt_a')).toMatchObject({ ok: false, code: 'RUNTIME_NOT_FOUND' })
  })
  it('add refuses a string that is not a pairing string, storing nothing', async () => {
    const r = createRemoteRuntimes({ profileDir: dir, version: '1.4.8', open: opener().open })
    expect(await r.add('hello')).toMatchObject({ ok: false, code: 'INVALID_ARGUMENTS' })
    expect((await r.list()).map((x) => x.runtimeId)).toEqual(['rt_a'])
  })
})

// Phase 9b: a remote session tab's stream rides the client's link, which does not tell its streams it was closed; the
// owner of those streams hears when a Runtime's client is replaced or removed.
describe('a client replaced or removed is announced', () => {
  it('a re-pair and a remove each call onClientChange; the first open does not', async () => {
    const o = opener()
    const changed: string[] = []
    const r = createRemoteRuntimes({ profileDir: dir, version: '1.4.8', open: o.open, onClientChange: (id) => void changed.push(id) })
    await r.client('rt_a')
    await r.client('rt_a')
    await Promise.resolve()
    expect(changed).toEqual([])
    await (await controllerRegistry(dir)).add(
      { runtimeId: 'rt_a', name: 'Office', address: '10.0.0.2', port: 47831, fingerprint: FP, permission: 'full-control', createdAt: 'y', lastSeenAt: null },
      'tok-b'
    )
    await r.client('rt_a')
    await new Promise((res) => setTimeout(res, 0))
    expect(changed).toEqual(['rt_a'])
    await r.remove('rt_a')
    await new Promise((res) => setTimeout(res, 0))
    expect(changed).toEqual(['rt_a', 'rt_a'])
  })

  // Second pass M2-7: a Runtime removed with `astera runtimes remove` while the app ran kept its client and its link.
  it('a Runtime removed outside the app has its client closed and announced at the next lookup', async () => {
    const o = opener()
    const changed: string[] = []
    const r = createRemoteRuntimes({ profileDir: dir, version: '1.4.8', open: o.open, onClientChange: (id) => void changed.push(id) })
    await r.client('rt_a')
    await (await controllerRegistry(dir)).remove('rt_a')
    expect(await r.client('rt_a')).toMatchObject({ code: 'RUNTIME_NOT_FOUND' })
    await new Promise((res) => setTimeout(res, 0))
    expect(o.closed).toEqual(['tok-a'])
    expect(changed).toEqual(['rt_a'])
  })

  // Performance audit M4: every remote call looked its Runtime up again, reading and checking the registry and the
  // token file. While the registry file is as it was, the kept client answers without reading either.
  it('a call while the registry is unchanged reads neither the registry nor the token again', async () => {
    const o = opener()
    const r = createRemoteRuntimes({ profileDir: dir, version: '1.4.8', open: o.open })
    await r.client('rt_a')
    await fs.writeFile(path.join(dir, 'runtimes', 'rt_a.token'), 'tok-z')
    await r.client('rt_a')
    expect(o.opened.map((t) => t.token)).toEqual(['tok-a'])
  })
})

// Remote governance design §5.4, §10.1: Settings shows a Runtime's report, read at most every five minutes or on
// refresh and kept; the expected list is this computer's choice of its own extensions.
describe('reports and the expected list (remote governance design §5.4, §6.1, §10.1)', () => {
  const MIN = 60_000
  const LOCAL: ReportExtension[] = [{ id: 'skill-a', kind: 'skill', name: 'skill-a', enabled: true, providers: ['claude'] }]
  const REPORT: ControlPlaneReport = {
    version: 1,
    astera: { version: '1.5.0', platform: 'darwin' },
    extensions: [],
    profiles: [],
    appBypass: false,
    policy: null,
    sandbox: { claude: { kind: 'sandbox', blocker: null }, codex: { kind: 'deny-only', blocker: null } },
    credentials: null,
    secretStore: { kind: 'owner-only-files', ok: true },
    findings: null
  }
  const REPORTING: HelloFrame = { ...HELLO, capabilities: [REPORT_CAPABILITY] }
  /** Links to Runtimes that answer their report, except the ids in `offline`, which never answer. */
  const reporting = (offline: string[] = []) => {
    const calls: Array<{ runtimeId: string; cmd: string }> = []
    const open = (t: RemoteTarget, o?: { onHello?(h: HelloFrame): void }): RemoteLink => {
      let said = false
      return {
        hello: () => (said ? REPORTING : null),
        call: async (cmd) => {
          calls.push({ runtimeId: t.runtimeId, cmd })
          if (offline.includes(t.runtimeId)) return new RemoteError('RUNTIME_OFFLINE', 'connect ECONNREFUSED')
          said = true
          o?.onHello?.(REPORTING)
          return cmd === 'control-plane-report' ? { status: 200, body: REPORT } : { status: 200, body: [] }
        },
        subscribe: () => () => {},
        close: () => {}
      }
    }
    return { open, reads: (id = 'rt_a') => calls.filter((c) => c.cmd === 'control-plane-report' && c.runtimeId === id).length }
  }
  let t: number
  beforeEach(() => {
    t = Date.parse('2026-11-01T00:00:00.000Z')
  })
  const runtimes = (open: ReturnType<typeof reporting>['open'], version = '1.5.0') =>
    createRemoteRuntimes({ profileDir: dir, version, open, now: () => t, localExtensions: async () => LOCAL })

  it('detail reads a report once and answers the kept one within five minutes', async () => {
    const o = reporting()
    const r = runtimes(o.open)
    const first = await r.detail('rt_a')
    expect(first).toMatchObject({ runtimeId: 'rt_a', answering: true, snapshot: { readAt: '2026-11-01T00:00:00.000Z', report: { astera: { version: '1.5.0' } } } })
    expect((await (await controllerRegistry(dir)).list())[0].snapshot?.readAt).toBe('2026-11-01T00:00:00.000Z')
    t += 4 * MIN
    expect(await r.detail('rt_a')).toMatchObject({ answering: null, snapshot: { readAt: '2026-11-01T00:00:00.000Z' } })
    expect(o.reads()).toBe(1)
  })

  it('refresh reads again at once', async () => {
    const o = reporting()
    const r = runtimes(o.open)
    await r.detail('rt_a')
    t += MIN
    expect(await r.detail('rt_a', { refresh: true })).toMatchObject({ answering: true, snapshot: { readAt: '2026-11-01T00:01:00.000Z' } })
    expect(o.reads()).toBe(2)
  })

  it('past five minutes it reads again', async () => {
    const o = reporting()
    const r = runtimes(o.open)
    await r.detail('rt_a')
    t += 5 * MIN
    expect(await r.detail('rt_a')).toMatchObject({ snapshot: { readAt: '2026-11-01T00:05:00.000Z' } })
    expect(o.reads()).toBe(2)
  })

  it('an offline Runtime answers its last snapshot with its time and the refusal', async () => {
    await (await controllerRegistry(dir)).keepSnapshot('rt_a', { readAt: '2026-10-31T00:00:00.000Z', report: REPORT })
    const r = runtimes(reporting(['rt_a']).open)
    expect(await r.detail('rt_a')).toMatchObject({
      answering: false,
      snapshot: { readAt: '2026-10-31T00:00:00.000Z' },
      refusal: { code: 'RUNTIME_OFFLINE' }
    })
    expect((await (await controllerRegistry(dir)).list())[0].snapshot?.readAt).toBe('2026-10-31T00:00:00.000Z')
  })

  // Final review F12: a report too large to keep is FAILED, and the old snapshot stays
  it('a report over 1 MiB is refused FAILED with the old snapshot kept', async () => {
    await (await controllerRegistry(dir)).keepSnapshot('rt_a', { readAt: '2026-10-31T00:00:00.000Z', report: REPORT })
    const ext = (i: number) => ({ id: `${i}`.padStart(256, 'x'), kind: 'skill', name: 'n'.repeat(256), enabled: true, providers: ['claude'] })
    const big = { ...REPORT, extensions: Array.from({ length: 2000 }, (_, i) => ext(i)) }
    const open = (_t: RemoteTarget, o?: { onHello?(h: HelloFrame): void }): RemoteLink => ({
      hello: () => REPORTING,
      call: async () => (o?.onHello?.(REPORTING), { status: 200, body: big }),
      subscribe: () => () => {},
      close: () => {}
    })
    expect(await runtimes(open).detail('rt_a', { refresh: true })).toMatchObject({
      answering: true,
      snapshot: { readAt: '2026-10-31T00:00:00.000Z' },
      refusal: { code: 'FAILED', message: SNAPSHOT_TOO_LARGE }
    })
    expect((await (await controllerRegistry(dir)).list())[0].snapshot).toEqual({ readAt: '2026-10-31T00:00:00.000Z', report: REPORT })
  })

  it('readReports reads each paired Runtime under the same rule and never rejects', async () => {
    const reg = await controllerRegistry(dir)
    await reg.add({ runtimeId: 'rt_b', name: 'Home', address: '10.0.0.3', port: 47831, fingerprint: FP, permission: 'read-only', createdAt: 'x', lastSeenAt: null }, 'tok-b')
    const o = reporting(['rt_b'])
    const r = runtimes(o.open)
    await expect(r.readReports()).resolves.toBeUndefined()
    expect([o.reads('rt_a'), o.reads('rt_b')]).toEqual([1, 1])
    expect((await reg.list()).find((p) => p.runtimeId === 'rt_a')?.snapshot?.readAt).toBe('2026-11-01T00:00:00.000Z')
    t += 4 * MIN
    await r.readReports()
    // rt_a's report is fresh, and rt_b's failed read stands (ruling R16-1)
    expect([o.reads('rt_a'), o.reads('rt_b')]).toEqual([1, 1])
    t += MIN
    await r.readReports()
    expect([o.reads('rt_a'), o.reads('rt_b')]).toEqual([2, 2])
    // A registry that cannot be read still resolves
    const broken = createRemoteRuntimes({ profileDir: path.join(dir, 'runtimes', 'rt_a.token'), version: '1.5.0', open: o.open })
    await expect(broken.readReports()).resolves.toBeUndefined()
  })

  it('expect keeps the list, and an id this computer does not have is refused', async () => {
    const r = runtimes(reporting().open)
    expect(await r.expect('rt_a', ['skill-a'], [])).toEqual({ ok: true, expected: ['skill-a'] })
    expect((await (await controllerRegistry(dir)).list())[0].expected).toEqual(['skill-a'])
    expect(await r.expect('rt_a', ['nope'], [])).toMatchObject({ ok: false, code: 'INVALID_ARGUMENTS', message: expect.stringContaining('nope') })
    expect(await r.expect('rt_a', [], ['typo'])).toMatchObject({ ok: false, code: 'INVALID_ARGUMENTS' })
    expect((await (await controllerRegistry(dir)).list())[0].expected).toEqual(['skill-a'])
    expect(await r.expect('rt_a', [], ['skill-a'])).toEqual({ ok: true, expected: [] })
    expect(await r.expect('rt_nope', [], [])).toMatchObject({ ok: false, code: 'RUNTIME_NOT_FOUND' })
  })

  it('list marks a Runtime older than this app', async () => {
    const r = runtimes(reporting().open, '1.6.0')
    expect((await r.list())[0]).not.toHaveProperty('older')
    await r.detail('rt_a')
    await vi.waitFor(async () => expect((await r.list())[0]).toMatchObject({ asteraVersion: '1.5.0', older: true }))
    const same = runtimes(reporting().open, '1.5.0')
    expect((await same.list())[0]).toMatchObject({ older: false })
  })
})

// Ruling R16-1: a Runtime that does not answer is not dialled on every ask, the list and the detail agree on its
// health, a damaged registry here does not hide the snapshot, and a time ahead of the clock is not fresh.
describe('report reads after review (ruling R16-1)', () => {
  const MIN = 60_000
  const REPORT: ControlPlaneReport = {
    version: 1,
    astera: { version: '1.5.0', platform: 'darwin' },
    extensions: [],
    profiles: [],
    appBypass: false,
    policy: null,
    sandbox: { claude: { kind: 'sandbox', blocker: null }, codex: { kind: 'deny-only', blocker: null } },
    credentials: null,
    secretStore: { kind: 'owner-only-files', ok: true },
    findings: null
  }
  const REPORTING: HelloFrame = { ...HELLO, capabilities: [REPORT_CAPABILITY] }
  /** Links that answer their report while `state.offline` is false. */
  const reporting = (state = { offline: false }) => {
    let reads = 0
    const open = (_t: RemoteTarget, o?: { onHello?(h: HelloFrame): void }): RemoteLink => ({
      hello: () => REPORTING,
      call: async (cmd) => {
        if (cmd === 'control-plane-report') reads++
        if (state.offline) return new RemoteError('RUNTIME_OFFLINE', 'connect ECONNREFUSED')
        o?.onHello?.(REPORTING)
        return cmd === 'control-plane-report' ? { status: 200, body: REPORT } : { status: 200, body: [] }
      },
      subscribe: () => () => {},
      close: () => {}
    })
    return { open, state, reads: () => reads }
  }
  let t: number
  beforeEach(() => {
    t = Date.parse('2026-11-01T00:00:00.000Z')
  })
  const runtimes = (open: ReturnType<typeof reporting>['open'], local: () => Promise<ReportExtension[]> = async () => []) =>
    createRemoteRuntimes({ profileDir: dir, version: '1.5.0', open, now: () => t, localExtensions: local })

  it('an offline Runtime is dialled once across two detail calls inside the window, and again after it or on refresh', async () => {
    await (await controllerRegistry(dir)).keepSnapshot('rt_a', { readAt: '2026-10-31T00:00:00.000Z', report: REPORT })
    const o = reporting({ offline: true })
    const r = runtimes(o.open)
    expect(await r.detail('rt_a')).toMatchObject({ answering: false, refusal: { code: 'RUNTIME_OFFLINE' } })
    t += 4 * MIN
    expect(await r.detail('rt_a')).toMatchObject({ answering: null, snapshot: { readAt: '2026-10-31T00:00:00.000Z' }, refusal: { code: 'RUNTIME_OFFLINE' } })
    await r.readReports()
    expect(o.reads()).toBe(1)
    t += MIN
    await r.detail('rt_a')
    expect(o.reads()).toBe(2)
    await r.detail('rt_a', { refresh: true })
    expect(o.reads()).toBe(3)
  })

  it('a successful read clears the remembered refusal', async () => {
    const o = reporting({ offline: true })
    const r = runtimes(o.open)
    await r.detail('rt_a')
    o.state.offline = false
    t += MIN
    expect(await r.detail('rt_a', { refresh: true })).not.toHaveProperty('refusal')
    o.state.offline = true
    t += MIN
    expect(await r.detail('rt_a')).not.toHaveProperty('refusal')
    expect(o.reads()).toBe(2)
  })

  it('a report read tells the list the Runtime answers, and the list shows the later last seen', async () => {
    const o = reporting({ offline: true })
    const r = runtimes(o.open)
    await r.detail('rt_a')
    expect((await r.list())[0].offline).toBe(true)
    o.state.offline = false
    await r.detail('rt_a', { refresh: true })
    const [listed] = await r.list()
    expect(listed.offline).toBe(false)
    expect(listed.lastSeenAt).not.toBeNull()
    await (await controllerRegistry(dir)).touch('rt_a', '2030-01-01T00:00:00.000Z')
    expect((await r.list())[0].lastSeenAt).toBe('2030-01-01T00:00:00.000Z')
  })

  it('a damaged registry here answers the kept snapshot with no comparison and localError', async () => {
    await (await controllerRegistry(dir)).keepSnapshot('rt_a', { readAt: '2026-10-31T23:58:00.000Z', report: REPORT })
    const r = runtimes(reporting().open, async () => {
      throw new Error('extensions.json is damaged')
    })
    expect(await r.detail('rt_a')).toMatchObject({ snapshot: { readAt: '2026-10-31T23:58:00.000Z' }, comparison: [], localError: true })
  })

  it('a snapshot time ahead of the clock is not fresh', async () => {
    await (await controllerRegistry(dir)).keepSnapshot('rt_a', { readAt: '2026-11-01T01:00:00.000Z', report: REPORT })
    const o = reporting()
    await runtimes(o.open).detail('rt_a')
    expect(o.reads()).toBe(1)
  })

  it('expect refuses more than 2000 ids to add or to remove, writing nothing', async () => {
    const r = runtimes(reporting().open, async () => [{ id: 'skill-a', kind: 'skill', name: 'skill-a', enabled: true, providers: ['claude'] }])
    const many = Array.from({ length: 2001 }, () => 'skill-a')
    expect(await r.expect('rt_a', many, [])).toMatchObject({ ok: false, code: 'INVALID_ARGUMENTS' })
    expect(await r.expect('rt_a', [], many)).toMatchObject({ ok: false, code: 'INVALID_ARGUMENTS' })
    expect((await (await controllerRegistry(dir)).list())[0].expected).toBeUndefined()
    expect(await r.expect('rt_a', many.slice(1), [])).toEqual({ ok: true, expected: ['skill-a'] })
  })
})
