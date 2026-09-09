import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hostAddress } from '../../host/address'
import { startHostServer, type HostServer } from '../../host/server'
import { HOST_PROTOCOL } from '../../core/host/protocol'
import { HostClient } from './client'

let dir: string
let servers: HostServer[] = []
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-host-client-'))
  servers = []
})
afterEach(async () => {
  for (const s of servers) await s.close().catch(() => {})
  await fs.rm(dir, { recursive: true, force: true })
})

const addressFor = (name: string): ReturnType<typeof hostAddress> =>
  hostAddress({ profileDir: path.join(dir, name), platform: process.platform, tmpDir: dir })

const serveAt = async (
  addr: ReturnType<typeof hostAddress>,
  over: { version?: string; onIdle?: () => void } = {}
): Promise<HostServer> => {
  const s = await startHostServer({
    address: addr.address,
    dirToPrepare: addr.dirToPrepare,
    version: over.version ?? '9.9.9',
    idleMs: 60_000,
    onIdle: over.onIdle ?? ((): void => {}),
    log: { write: () => {}, close: () => {} }
  })
  servers.push(s)
  return s
}

const settled = async (c: HostClient, want: (s: ReturnType<HostClient['status']>) => boolean): Promise<void> => {
  for (let i = 0; i < 60; i++) {
    if (want(c.status())) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`status never settled: ${JSON.stringify(c.status())}`)
}

describe('HostClient', () => {
  it('connects to a Host that is already there and reports what it found', async () => {
    const addr = addressFor('already')
    await serveAt(addr, { version: '1.2.3' })
    const c = new HostClient({ address: addr.address, appVersion: '9.0.0', spawnHost: () => {}, log: () => {} })
    c.start()
    await settled(c, (s) => s.connected)
    expect(c.status()).toMatchObject({ connected: true, protocol: HOST_PROTOCOL, hostVersion: '1.2.3', problem: null })
    expect(c.status().pid).toBe(process.pid)
    await c.stop()
  })

  it('asks for a Host when none answers, and connects once it appears', async () => {
    const addr = addressFor('spawned')
    let asked = 0
    const c = new HostClient({
      address: addr.address,
      appVersion: '9.0.0',
      spawnHost: () => {
        asked += 1
        void serveAt(addr)
      },
      log: () => {}
    })
    c.start()
    await settled(c, (s) => s.connected)
    expect(asked).toBe(1)
    await c.stop()
  })

  // A Host on another protocol holds nothing in slice 1, so the app tells it to leave. What comes
  // next is the ordinary reconnect: the Host the app then starts is from its own build, so it speaks
  // the app's protocol. Slice 2 has to answer this differently.
  it('retires a Host on another protocol', async () => {
    const addr = addressFor('mismatch')
    let retired = false
    let old: HostServer | null = null
    old = await serveAt(addr, { onIdle: () => { retired = true; void old?.close() } })
    const c = new HostClient({
      address: addr.address,
      appVersion: '9.0.0',
      protocol: HOST_PROTOCOL + 1,
      spawnHost: () => {},
      log: () => {}
    })
    c.start()
    await settled(c, () => retired)
    expect(retired).toBe(true)
    await c.stop()
  })

  it('reports the reason when there is no Host and none can be started', async () => {
    const addr = addressFor('never')
    const c = new HostClient({ address: addr.address, appVersion: '9.0.0', spawnHost: () => {}, log: () => {}, attempts: 2, retryMs: 10 })
    c.start()
    await settled(c, (s) => s.problem !== null)
    expect(c.status().connected).toBe(false)
    expect(c.status().problem).toContain('no Host')
    await c.stop()
  })

  it('keeps its status once it is stopped', async () => {
    const addr = addressFor('stopped')
    const c = new HostClient({ address: addr.address, appVersion: '9.0.0', spawnHost: () => {}, log: () => {}, attempts: 1, retryMs: 10 })
    c.start()
    await c.stop()
    const before = c.status()
    await new Promise((r) => setTimeout(r, 100))
    expect(c.status()).toEqual(before)
  })

  it('does not connect after it has been stopped', async () => {
    const addr = addressFor('stop-races-connect')
    await serveAt(addr)
    const c = new HostClient({ address: addr.address, appVersion: '9.0.0', spawnHost: () => {}, log: () => {} })
    c.start()
    await c.stop()
    await new Promise((r) => setTimeout(r, 300))
    expect(c.status().connected).toBe(false)
  })

  // A no-op spawn hides this in a test; in the app this call launches a real detached process.
  it('does not start a Host after it has been stopped', async () => {
    const addr = addressFor('stop-before-spawn')
    let asked = 0
    const c = new HostClient({
      address: addr.address,
      appVersion: '9.0.0',
      spawnHost: () => { asked += 1 },
      log: () => {},
      attempts: 5,
      retryMs: 10
    })
    c.start()
    await c.stop()
    await new Promise((r) => setTimeout(r, 200))
    expect(asked).toBe(0)
  })
})
