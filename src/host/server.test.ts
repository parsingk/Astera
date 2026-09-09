import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { hostAddress } from './address'
import { encodeLine, createLineReader } from './framing'
import { startHostServer, ADDRESS_TAKEN, UNSAFE_ADDRESS_DIR, type HostServer } from './server'
import { HOST_PROTOCOL } from '../core/host/protocol'

let dir: string
let open: HostServer[] = []
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-host-'))
  open = []
})
afterEach(async () => {
  for (const s of open) await s.close().catch(() => {})
  await fs.rm(dir, { recursive: true, force: true })
})

/** A server at an address of this test's own, with everything injectable. */
const server = async (over: { idleMs?: number; onIdle?: () => void; profile?: string } = {}): Promise<{
  s: HostServer
  address: string
  logs: string[]
}> => {
  const logs: string[] = []
  const addr = hostAddress({
    profileDir: path.join(dir, over.profile ?? 'profile'),
    platform: process.platform,
    tmpDir: dir
  })
  const s = await startHostServer({
    address: addr.address,
    dirToPrepare: addr.dirToPrepare,
    version: '9.9.9',
    idleMs: over.idleMs ?? 60_000,
    onIdle: over.onIdle ?? ((): void => {}),
    log: { write: (m) => logs.push(m), close: () => {} }
  })
  open.push(s)
  return { s, address: addr.address, logs }
}

/** Connects, sends the given lines, and resolves with everything the server said back. */
const talk = (address: string, lines: unknown[], waitFor = 1): Promise<unknown[]> =>
  new Promise((resolve, reject) => {
    const got: unknown[] = []
    const sock = net.connect(address)
    const read = createLineReader({ onMessage: (v) => { got.push(v); if (got.length >= waitFor) { sock.end(); resolve(got) } }, onBadLine: () => {} })
    sock.setEncoding('utf8')
    sock.on('data', read)
    sock.on('error', reject)
    sock.on('connect', () => { for (const l of lines) sock.write(encodeLine(l)) })
    setTimeout(() => { sock.destroy(); resolve(got) }, 3000)
  })

describe('startHostServer', () => {
  it('answers a hello on the same protocol with its own version and pid', async () => {
    const h = await server()
    const [reply] = await talk(h.address, [{ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' }])
    expect(reply).toMatchObject({ t: 'hello', protocol: HOST_PROTOCOL, host: '9.9.9', pid: process.pid })
    expect((reply as { startedAt: string }).startedAt).toMatch(/^\d{4}-/)
  })

  it('answers a hello on another protocol with a mismatch, and does not hang up', async () => {
    const h = await server()
    const [reply] = await talk(h.address, [{ t: 'hello', protocol: HOST_PROTOCOL + 1, app: '1.0.0' }])
    expect(reply).toEqual({ t: 'protocol-mismatch', protocol: HOST_PROTOCOL })
  })

  it('answers a second client with the same identity', async () => {
    const h = await server()
    const [first] = await talk(h.address, [{ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' }])
    const [second] = await talk(h.address, [{ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' }])
    expect((first as { pid: number }).pid).toBe((second as { pid: number }).pid)
  })

  // Losing the race must not cost the winner its address: a second Host that unlinked the socket it
  // found would take a working Host offline.
  it('refuses to start when the address is already served, and leaves it working', async () => {
    const h = await server()
    await expect(
      startHostServer({
        address: h.address,
        dirToPrepare: null,
        version: '9.9.9',
        idleMs: 60_000,
        onIdle: () => {},
        log: { write: () => {}, close: () => {} }
      })
    ).rejects.toThrow(ADDRESS_TAKEN)
    const [reply] = await talk(h.address, [{ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' }])
    expect(reply).toMatchObject({ t: 'hello', host: '9.9.9' })
  })

  it('retire asks the caller to leave', async () => {
    let retired = false
    const h = await server({ onIdle: () => { retired = true } })
    await talk(h.address, [{ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' }, { t: 'retire' }])
    await new Promise((r) => setTimeout(r, 200))
    expect(retired).toBe(true)
  })

  // `close()` destroys the sockets it still holds, and each one's 'close' event arrives after
  // `close()` has returned. Without a guard that deferred event re-arms the idle timer and the Host
  // is told to leave a second time, on a server that has already gone.
  it('does not ask to leave again when it is closed with a client still connected', async () => {
    let asked = 0
    const h = await server({ idleMs: 50, onIdle: () => { asked += 1 } })
    await new Promise<void>((resolve) => {
      const sock = net.connect(h.address)
      sock.setEncoding('utf8')
      sock.on('connect', () => {
        sock.write(encodeLine({ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' }))
        sock.write(encodeLine({ t: 'retire' }))
        resolve()
      })
    })
    await new Promise((r) => setTimeout(r, 100))
    expect(asked).toBe(1)
    await h.s.close()
    await new Promise((r) => setTimeout(r, 300))
    expect(asked).toBe(1)
    await expect(h.s.close()).resolves.toBeUndefined()
  })

  // The idle timer is injected rather than waited out: a test that sleeps sixty seconds is a test
  // nobody runs.
  it('calls back when nobody has been connected for the idle time', async () => {
    let idle = false
    const h = await server({ idleMs: 50, onIdle: () => { idle = true } })
    await talk(h.address, [{ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' }])
    await new Promise((r) => setTimeout(r, 300))
    expect(idle).toBe(true)
    expect(h.s.clients()).toBe(0)
  })

  it('a line that is not JSON is logged and the connection survives it', async () => {
    const h = await server()
    const got = await new Promise<unknown[]>((resolve) => {
      const out: unknown[] = []
      const sock = net.connect(h.address)
      const read = createLineReader({ onMessage: (v) => { out.push(v); sock.end(); resolve(out) }, onBadLine: () => {} })
      sock.setEncoding('utf8')
      sock.on('data', read)
      sock.on('connect', () => {
        sock.write('not json\n')
        sock.write(encodeLine({ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' }))
      })
      setTimeout(() => { sock.destroy(); resolve(out) }, 3000)
    })
    expect(got).toHaveLength(1)
    expect(h.logs.some((l) => l.includes('not json'))).toBe(true)
  })
})

// posix only: on win32 a pipe name disappears with the process that made it, so there is nothing
// stale to find.
describe.runIf(process.platform !== 'win32')('a socket file left behind', () => {
  it('is replaced when nobody is listening on it', async () => {
    const addr = hostAddress({ profileDir: path.join(dir, 'stale'), platform: process.platform, tmpDir: dir })
    await fs.mkdir(addr.dirToPrepare!, { recursive: true, mode: 0o700 })
    await fs.writeFile(addr.address, '')
    const s = await startHostServer({
      address: addr.address,
      dirToPrepare: addr.dirToPrepare,
      version: '9.9.9',
      idleMs: 60_000,
      onIdle: () => {},
      log: { write: () => {}, close: () => {} }
    })
    open.push(s)
    const [reply] = await talk(addr.address, [{ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' }])
    expect(reply).toMatchObject({ t: 'hello' })
  })

  it('puts the socket in a directory only this user can open', async () => {
    const h = await server({ profile: 'perms' })
    const st = await fs.stat(path.dirname(h.address))
    expect(st.mode & 0o777).toBe(0o700)
  })

  // The test above only covers the directory this Host made. `mkdir` with `recursive: true` neither
  // errors nor changes the mode of a directory that is already there, so on linux — where the parent
  // is /tmp at 1777 and the address key is a hash of a guessable profile path — another local user
  // can create the name first and leave it open to everyone. Binding inside it would put the channel
  // where anybody can reach it, so the Host refuses the address instead.
  it('refuses an address whose directory is open to everyone', async () => {
    const logs: string[] = []
    const addr = hostAddress({ profileDir: path.join(dir, 'loose'), platform: process.platform, tmpDir: dir })
    await fs.mkdir(addr.dirToPrepare!, { recursive: true })
    // chmod rather than mkdir's `mode`, which the umask trims.
    await fs.chmod(addr.dirToPrepare!, 0o777)
    await expect(
      startHostServer({
        address: addr.address,
        dirToPrepare: addr.dirToPrepare,
        version: '9.9.9',
        idleMs: 60_000,
        onIdle: () => {},
        log: { write: (m) => logs.push(m), close: () => {} }
      })
    ).rejects.toThrow(UNSAFE_ADDRESS_DIR)
    expect(logs.some((l) => l.includes(addr.dirToPrepare!))).toBe(true)
    // Nothing was bound: the refusal happens before listen.
    await expect(fs.stat(addr.address)).rejects.toThrow()
  })
})
