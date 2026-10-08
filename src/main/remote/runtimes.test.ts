import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRemoteRuntimes } from './runtimes'
import { controllerRegistry } from '../../cli/runtimes'
import type { RemoteLink, RemoteTarget } from '../../core/remote/link'

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
})
