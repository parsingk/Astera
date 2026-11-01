import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openSecretStore } from '../secrets/secretStore'
import type { ControlPlaneReport } from '../controlPlane/report'
import {
  factsNoter,
  factsOf,
  listPairedRuntimes,
  openRuntimeRegistry,
  registryStamp,
  seenRecorder,
  type RuntimeFacts,
  type RuntimeProfile
} from './registry'

let profile: string
const store = () => openSecretStore({ dir: path.join(profile, 'runtimes'), profileDir: profile })
const p = (id: string): RuntimeProfile => ({
  runtimeId: id,
  name: id,
  address: '10.0.0.2',
  port: 47831,
  fingerprint: 'f',
  permission: 'full-control',
  createdAt: 'T',
  lastSeenAt: null
})
beforeEach(async () => {
  profile = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-runtimes-'))
})
afterEach(async () => fs.rm(profile, { recursive: true, force: true }))

describe('runtime registry (remote runtime design §4.6, N8)', () => {
  it('adds a profile with its token, lists it, and removes both', async () => {
    const r = await openRuntimeRegistry(store())
    await r.add(p('rt_a'), 'tok-a')
    expect((await r.list()).map((x) => x.runtimeId)).toEqual(['rt_a'])
    expect(await r.token('rt_a')).toBe('tok-a')
    expect(JSON.stringify(await r.list())).not.toContain('tok-a')
    expect(await r.remove('rt_a')).toBe(true)
    expect(await r.token('rt_a')).toBeNull()
    expect(await r.remove('rt_a')).toBe(false)
  })
  it('a crash between the token and the registry entry leaves a token that the next open deletes', async () => {
    const s = store()
    await s.withLock((tx) => tx.write('rt_lost.token', 'tok'))
    const r = await openRuntimeRegistry(s)
    expect(await r.list()).toEqual([])
    expect(await s.read('rt_lost.token')).toBeNull()
  })
  it('a crash after the entry was removed but before the token was leaves a token the next open deletes', async () => {
    const s = store()
    const r = await openRuntimeRegistry(s)
    await r.add(p('rt_a'), 'tok')
    await s.withLock((tx) => tx.write('runtimes.json', JSON.stringify({ runtimes: [] })))
    await openRuntimeRegistry(s)
    expect(await s.read('rt_a.token')).toBeNull()
  })
  it('refuses a runtime id that is a path (Review Focus 1)', async () => {
    const r = await openRuntimeRegistry(store())
    await expect(r.add(p('../x'), 't')).rejects.toThrow(/runtime id/)
    await expect(r.token('..')).rejects.toThrow(/runtime id/)
    expect(await fs.readdir(profile)).not.toContain('x.token')
    expect(await r.list()).toEqual([])
  })
  it('adding the same runtime again replaces its profile and token', async () => {
    const r = await openRuntimeRegistry(store())
    await r.add(p('rt_a'), 'one')
    await r.add({ ...p('rt_a'), name: 'renamed' }, 'two')
    expect((await r.list()).map((x) => x.name)).toEqual(['renamed'])
    expect(await r.token('rt_a')).toBe('two')
  })
  // Security audit SEC-4: a Runtime picks the id it says it has, so a hostile one paired here could say another paired
  // Runtime's id and silently take its place: its address, its key, and every command and keystroke meant for it.
  it('refuses another key under an id it already has, unless told to replace it', async () => {
    const r = await openRuntimeRegistry(store())
    await r.add(p('rt_a'), 'one')
    await expect(r.add({ ...p('rt_a'), fingerprint: 'other', address: '10.6.6.6' }, 'evil')).rejects.toMatchObject({ code: 'RUNTIME_ALREADY_PAIRED' })
    expect(await r.list()).toEqual([p('rt_a')])
    expect(await r.token('rt_a')).toBe('one')
    await r.add({ ...p('rt_a'), fingerprint: 'other' }, 'two', { replace: true })
    expect((await r.list())[0].fingerprint).toBe('other')
  })
})

describe('runtime ids and case (Phase 2 review)', () => {
  it('refuses an id with capitals, which on a case-insensitive disk would share another runtime’s token file', async () => {
    const r = await openRuntimeRegistry(store())
    await r.add(p('rt_ab'), 'mine')
    await expect(r.add(p('RT_AB'), 'theirs')).rejects.toThrow(/runtime id/)
    expect(await r.token('rt_ab')).toBe('mine')
  })

  // Phase 3 minor (design §4.5): the controller keeps when it last reached each Runtime.
  it('touch sets lastSeenAt and keeps the token; an unknown id changes nothing', async () => {
    const r = await openRuntimeRegistry(store())
    await r.add(p('rt_a'), 'tok-a')
    await r.touch('rt_a', '2026-10-08T00:00:00.000Z')
    expect((await r.list())[0].lastSeenAt).toBe('2026-10-08T00:00:00.000Z')
    expect(await r.token('rt_a')).toBe('tok-a')
    await r.touch('rt_b', 'x')
    expect((await r.list()).map((x) => x.runtimeId)).toEqual(['rt_a'])
  })
})

// Final fix pass, M-6: the findings list the Runtimes at every compute, and most people never paired one
describe('listPairedRuntimes', () => {
  it('answers none while runtimes.json does not exist, without opening the store or making its folder', async () => {
    let opened = 0
    const once = () => (opened++, store())
    expect(await listPairedRuntimes(path.join(profile, 'runtimes'), once)).toEqual([])
    expect(opened).toBe(0)
    await expect(fs.stat(path.join(profile, 'runtimes'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('lists the paired ones through the store once there is a registry', async () => {
    await (await openRuntimeRegistry(store())).add(p('rt_a'), 'tok-a')
    let opened = 0
    const s = store()
    const once = () => (opened++, s)
    expect((await listPairedRuntimes(path.join(profile, 'runtimes'), once)).map((r) => r.runtimeId)).toEqual(['rt_a'])
    expect(opened).toBe(1)
  })
})

// Remote governance design §4.1, §5.4, §6.1: what the controller keeps beside each pairing
describe('facts, snapshot and expected list per Runtime', () => {
  const registryFile = () => path.join(profile, 'runtimes', 'runtimes.json')
  const facts = (readAt: string, asteraVersion = '1.5.0'): RuntimeFacts =>
    factsOf({ asteraVersion, platform: 'darwin', hostProtocol: 4, capabilities: ['control-plane.report'] }, readAt)
  const report = (): ControlPlaneReport => ({
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
  })
  const fileOf = async () => JSON.parse(await fs.readFile(registryFile(), 'utf8')) as { runtimes: Array<Record<string, unknown>> }

  it('a profile written before this release reads with no facts, snapshot or expected', async () => {
    await (await openRuntimeRegistry(store())).add(p('rt_a'), 'tok')
    await fs.writeFile(registryFile(), JSON.stringify({ runtimes: [p('rt_a')] }))
    const listed = await (await openRuntimeRegistry(store())).list()
    expect(listed).toEqual([p('rt_a')])
    expect(Object.keys(listed[0]).sort()).toEqual(Object.keys(p('rt_a')).sort())
  })

  it('noteFacts writes once and not again for the same facts', async () => {
    const r = await openRuntimeRegistry(store())
    await r.add(p('rt_a'), 'tok')
    expect(await r.noteFacts('rt_a', facts('2026-11-01T00:00:00.000Z'))).toBe(true)
    const mtime = (await fs.stat(registryFile())).mtimeMs
    expect(await r.noteFacts('rt_a', facts('2026-11-01T01:00:00.000Z'))).toBe(false)
    expect((await fs.stat(registryFile())).mtimeMs).toBe(mtime)
    expect((await r.list())[0].facts?.readAt).toBe('2026-11-01T00:00:00.000Z')
  })

  it('noteFacts writes again when the version changes', async () => {
    const r = await openRuntimeRegistry(store())
    await r.add(p('rt_a'), 'tok')
    await r.noteFacts('rt_a', facts('2026-11-01T00:00:00.000Z'))
    expect(await r.noteFacts('rt_a', facts('2026-11-02T00:00:00.000Z', '1.6.0'))).toBe(true)
    expect((await r.list())[0].facts).toEqual(facts('2026-11-02T00:00:00.000Z', '1.6.0'))
  })

  it('keepSnapshot keeps the report and its time; a snapshot that does not parse reads as absent', async () => {
    const r = await openRuntimeRegistry(store())
    await r.add(p('rt_a'), 'tok')
    await r.keepSnapshot('rt_a', { readAt: '2026-11-01T00:00:00.000Z', report: report() })
    expect((await r.list())[0].snapshot).toEqual({ readAt: '2026-11-01T00:00:00.000Z', report: report() })
    const file = await fileOf()
    ;(file.runtimes[0].snapshot as { report: { version: number } }).report.version = 9
    await fs.writeFile(registryFile(), JSON.stringify(file))
    const listed = await r.list()
    expect(listed[0]).not.toHaveProperty('snapshot')
    expect(listed[0].runtimeId).toBe('rt_a')
  })

  it('setExpected keeps the order and drops repeats', async () => {
    const r = await openRuntimeRegistry(store())
    await r.add(p('rt_a'), 'tok')
    await r.setExpected('rt_a', ['skill-b', 'mcp-a', 'skill-b', 'cmd-c', 'mcp-a'])
    expect((await r.list())[0].expected).toEqual(['skill-b', 'mcp-a', 'cmd-c'])
  })

  it('an id with no profile changes nothing in all three', async () => {
    const r = await openRuntimeRegistry(store())
    await r.add(p('rt_a'), 'tok')
    expect(await r.noteFacts('rt_b', facts('T'))).toBe(false)
    await r.keepSnapshot('rt_b', { readAt: 'T', report: report() })
    await r.setExpected('rt_b', ['x'])
    expect(await r.list()).toEqual([p('rt_a')])
  })

  it("touch, noteFacts and keepSnapshot keep each other's fields", async () => {
    const r = await openRuntimeRegistry(store())
    await r.add(p('rt_a'), 'tok')
    await r.setExpected('rt_a', ['skill-b'])
    await r.touch('rt_a', '2026-11-01T00:00:00.000Z')
    await r.noteFacts('rt_a', facts('2026-11-01T00:00:01.000Z'))
    await r.keepSnapshot('rt_a', { readAt: '2026-11-01T00:00:02.000Z', report: report() })
    expect((await r.list())[0]).toEqual({
      ...p('rt_a'),
      lastSeenAt: '2026-11-01T00:00:00.000Z',
      facts: facts('2026-11-01T00:00:01.000Z'),
      snapshot: { readAt: '2026-11-01T00:00:02.000Z', report: report() },
      expected: ['skill-b']
    })
  })

  // Review Focus 5: a new key is another machine, so what it said is not this one's; what the person expects stays.
  it('a re-pair under another key with replace drops facts and snapshot and keeps expected', async () => {
    const r = await openRuntimeRegistry(store())
    await r.add(p('rt_a'), 'tok')
    await r.noteFacts('rt_a', facts('T'))
    await r.keepSnapshot('rt_a', { readAt: 'T', report: report() })
    await r.setExpected('rt_a', ['skill-b'])
    await r.add({ ...p('rt_a'), fingerprint: 'other' }, 'two', { replace: true })
    expect(await r.list()).toEqual([{ ...p('rt_a'), fingerprint: 'other', expected: ['skill-b'] }])
  })

  // Ruling C9: add keeps no facts by itself; the sign-in hello writes them through noteFacts (Task 14).
  it('add keeps no facts or snapshot handed to it', async () => {
    const r = await openRuntimeRegistry(store())
    await r.add({ ...p('rt_a'), facts: facts('T'), snapshot: { readAt: 'T', report: report() } }, 'tok')
    expect(await r.list()).toEqual([p('rt_a')])
  })

  // Ruling C7: the Host's findings cache recomputes when this stamp changes (Task 12).
  it('registryStamp changes after keepSnapshot and setExpected, not after a noteFacts that writes nothing', async () => {
    const dir = path.join(profile, 'runtimes')
    expect(await registryStamp(dir)).toBeNull()
    const r = await openRuntimeRegistry(store())
    await r.add(p('rt_a'), 'tok')
    await r.noteFacts('rt_a', facts('T'))
    const first = await registryStamp(dir)
    expect(first).not.toBeNull()
    expect(await r.noteFacts('rt_a', facts('T2'))).toBe(false)
    expect(await registryStamp(dir)).toBe(first)
    await r.keepSnapshot('rt_a', { readAt: 'T', report: report() })
    const second = await registryStamp(dir)
    expect(second).not.toBe(first)
    await r.setExpected('rt_a', ['skill-b'])
    expect(await registryStamp(dir)).not.toBe(second)
  })

  it('seenRecorder touches at most once a minute', async () => {
    const touched: Array<[string, string]> = []
    let t = 0
    const seen = seenRecorder({ touch: async (id, at) => void touched.push([id, at]) }, 'rt_a', null, () => t)
    await seen()
    t = 30_000
    await seen()
    t = 61_000
    await seen()
    expect(touched).toEqual([
      ['rt_a', new Date(0).toISOString()],
      ['rt_a', new Date(61_000).toISOString()]
    ])
  })

  it('seenRecorder counts from the last time it was given and never rejects', async () => {
    const touched: string[] = []
    let t = Date.parse('2026-11-01T00:00:30.000Z')
    const seen = seenRecorder(
      {
        touch: async (_id, at) => {
          touched.push(at)
          throw new Error('locked')
        }
      },
      'rt_a',
      '2026-11-01T00:00:00.000Z',
      () => t
    )
    await seen()
    expect(touched).toEqual([])
    t = Date.parse('2026-11-01T00:01:01.000Z')
    await expect(seen()).resolves.toBeUndefined()
    expect(touched).toEqual(['2026-11-01T00:01:01.000Z'])
  })

  // Task 4 review: a write takes the store's cross-process lock, so held facts are not written again; and a write that
  // failed (a busy store) is tried again at the next hello, since an app's link lives long.
  const hi = { asteraVersion: '1.5.0', platform: 'linux', hostProtocol: 4, capabilities: ['pty.seq', 'pty.checkpoint'] }
  it('factsNoter makes no call for the facts already held, in any capability order', async () => {
    const calls: RuntimeFacts[] = []
    const note = factsNoter({ noteFacts: async (_id, f) => (calls.push(f), true) }, 'rt_a', factsOf({ ...hi, capabilities: ['pty.checkpoint', 'pty.seq'] }, 'T'))
    await note(hi)
    expect(calls).toEqual([])
  })
  it('factsNoter calls again after a rejected write, and never rejects', async () => {
    let calls = 0
    const note = factsNoter(
      {
        noteFacts: async () => {
          calls++
          throw new Error('busy')
        }
      },
      'rt_a',
      undefined
    )
    await expect(note(hi)).resolves.toBeUndefined()
    await note(hi)
    expect(calls).toBe(2)
  })
  it('factsNoter does not call again after a resolved write', async () => {
    const calls: Array<[string, RuntimeFacts]> = []
    const note = factsNoter({ noteFacts: async (id, f) => (calls.push([id, f]), true) }, 'rt_a', undefined)
    await note(hi)
    await note(hi)
    expect(calls).toEqual([['rt_a', expect.objectContaining({ asteraVersion: '1.5.0', capabilities: ['pty.seq', 'pty.checkpoint'] })]])
    await note({ ...hi, asteraVersion: '1.5.1' })
    expect(calls).toHaveLength(2)
  })
})
