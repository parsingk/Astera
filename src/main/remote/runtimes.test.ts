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
    return { hello: () => null, call: async () => ({ status: 200, body: {} }), close: () => void closed.push(t.token) }
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
})
