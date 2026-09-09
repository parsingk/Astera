import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { hostAddress } from '../../host/address'
import { startHostServer, type HostServer } from '../../host/server'
import { HOST_PROTOCOL, type HostMessage } from '../../core/host/protocol'
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

/** Same shape as `settled`, for a condition that is not the client's status — here, whether a
 *  message broadcast from the server has made it across the real socket to a subscriber yet. */
const waitFor = async (want: () => boolean): Promise<void> => {
  for (let i = 0; i < 60; i++) {
    if (want()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('condition never became true')
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

  // A peer that accepts and then says nothing is not a dropped connection: nothing closes, so the
  // close-and-backoff path never runs. Without a deadline of its own the status would sit at
  // "not connected, no reason" for the app's whole life, with no retry.
  it('gives up on a peer that accepts and never says hello', async () => {
    const addr = addressFor('silent')
    if (addr.dirToPrepare) await fs.mkdir(addr.dirToPrepare, { recursive: true, mode: 0o700 })
    const held: net.Socket[] = []
    const silent = net.createServer((sock) => held.push(sock))
    await new Promise<void>((r) => silent.listen(addr.address, r))
    try {
      const c = new HostClient({
        address: addr.address,
        appVersion: '9.0.0',
        spawnHost: () => {},
        log: () => {},
        helloMs: 60
      })
      c.start()
      await settled(c, (s) => s.problem !== null)
      expect(c.status().connected).toBe(false)
      expect(c.status().problem).toContain('did not answer')
      await c.stop()
    } finally {
      for (const sock of held) sock.destroy()
      await new Promise<void>((r) => silent.close(() => r()))
    }
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

  // The pty-* messages this task adds all arrive this way, over a real connection, not through the
  // fake transport ptyFactory.test.ts drives — this is the class actually doing the fan-out.
  it('fans a message out to every subscriber, survives one that throws, and stops after unsubscribe', async () => {
    const addr = addressFor('fan-out')
    const server = await serveAt(addr)
    const logs: string[] = []
    const c = new HostClient({ address: addr.address, appVersion: '9.0.0', spawnHost: () => {}, log: (m) => logs.push(m) })
    c.start()
    await settled(c, (s) => s.connected)

    const received: HostMessage[] = []
    c.onMessage(() => {
      throw new Error('subscriber one blew up')
    })
    const unsubTwo = c.onMessage((m) => received.push(m))

    server.broadcast({ t: 'pty-data', id: 'p1', data: 'hi' })
    await waitFor(() => received.length > 0)
    expect(received).toEqual([{ t: 'pty-data', id: 'p1', data: 'hi' }])
    expect(logs.some((l) => l.includes('subscriber threw') && l.includes('subscriber one blew up'))).toBe(true)

    unsubTwo()
    server.broadcast({ t: 'pty-data', id: 'p1', data: 'after unsubscribe' })
    // Nothing to wait for that would prove absence, so give the real socket a beat to have delivered
    // it if it were going to.
    await new Promise((r) => setTimeout(r, 150))
    expect(received).toEqual([{ t: 'pty-data', id: 'p1', data: 'hi' }])

    await c.stop()
  })

  // Every pty the Host held went with it, and nothing else says so — ptyFactory.ts's onHostGone
  // handle relies on this firing so a Host-backed pty does not read as "running" forever once the
  // Host itself is gone.
  it('tells its subscribers when the connection to the Host drops, and survives one that throws', async () => {
    const addr = addressFor('disconnect')
    const server = await serveAt(addr)
    const logs: string[] = []
    const c = new HostClient({ address: addr.address, appVersion: '9.0.0', spawnHost: () => {}, log: (m) => logs.push(m) })
    c.start()
    await settled(c, (s) => s.connected)

    let gone = 0
    c.onDisconnect(() => {
      throw new Error('disconnect subscriber one blew up')
    })
    c.onDisconnect(() => {
      gone += 1
    })
    await server.close()
    await waitFor(() => gone > 0)
    expect(gone).toBe(1)
    expect(logs.some((l) => l.includes('disconnect subscriber threw') && l.includes('blew up'))).toBe(true)

    await c.stop()
  })

  // stop() destroys the socket too, but that is the app choosing to leave, not the Host going away —
  // onHostGone must not treat the two alike, or every ordinary shutdown would read as a dead pty.
  it('does not treat a deliberate stop as the Host disappearing', async () => {
    const addr = addressFor('stop-is-quiet')
    await serveAt(addr)
    const c = new HostClient({ address: addr.address, appVersion: '9.0.0', spawnHost: () => {}, log: () => {} })
    c.start()
    await settled(c, (s) => s.connected)

    let gone = 0
    c.onDisconnect(() => {
      gone += 1
    })
    await c.stop()
    await new Promise((r) => setTimeout(r, 150))
    expect(gone).toBe(0)
  })

  // A dropped-and-reconnected Host is not the same event happening twice. The subscriber set must
  // survive the first firing (no going quiet on the next drop) and each drop must still cost exactly
  // one notification (no double-firing).
  it('re-arms after a reconnect, rather than firing twice for one drop or going quiet for the next', async () => {
    const addr = addressFor('disconnect-rearm')
    let server = await serveAt(addr)
    const c = new HostClient({
      address: addr.address,
      appVersion: '9.0.0',
      spawnHost: () => {
        void serveAt(addr).then((s) => {
          server = s
        })
      },
      log: () => {},
      retryMs: 10
    })
    c.start()
    await settled(c, (s) => s.connected)

    let gone = 0
    c.onDisconnect(() => {
      gone += 1
    })

    await server.close()
    await waitFor(() => gone === 1)
    await settled(c, (s) => s.connected) // reconnected to the Host spawnHost brought back
    expect(gone).toBe(1) // reconnecting on its own must not have fired a second notification

    await server.close()
    await waitFor(() => gone === 2)

    await c.stop()
  })

  // ready() is what lets startup decide the ptyRouter fallback without blocking on a Host that never
  // answers — see reattach.ts and its report for why HostClient grew this beyond what the brief named.
  it('ready() resolves once the handshake completes, well before its own timeout', async () => {
    const addr = addressFor('ready-connects')
    await serveAt(addr)
    const c = new HostClient({ address: addr.address, appVersion: '9.0.0', spawnHost: () => {}, log: () => {} })
    c.start()
    const start = Date.now()
    await c.ready(5_000)
    expect(Date.now() - start).toBeLessThan(2_000)
    expect(c.status().connected).toBe(true)
    await c.stop()
  })

  it('ready() resolves once the client gives up, without waiting out the full timeout', async () => {
    const addr = addressFor('ready-gives-up')
    const c = new HostClient({
      address: addr.address,
      appVersion: '9.0.0',
      spawnHost: () => {},
      log: () => {},
      attempts: 2,
      retryMs: 10
    })
    c.start()
    const start = Date.now()
    await c.ready(5_000)
    expect(Date.now() - start).toBeLessThan(2_000)
    expect(c.status().connected).toBe(false)
    expect(c.status().problem).not.toBeNull()
    await c.stop()
  })

  it('ready() gives up waiting at its own timeout while the client is still trying', async () => {
    const addr = addressFor('ready-times-out')
    const c = new HostClient({
      address: addr.address,
      appVersion: '9.0.0',
      spawnHost: () => {},
      log: () => {},
      attempts: 100,
      retryMs: 50
    })
    c.start()
    const start = Date.now()
    await c.ready(120)
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(100)
    expect(elapsed).toBeLessThan(1_000)
    expect(c.status().connected).toBe(false)
    await c.stop()
  })
})
