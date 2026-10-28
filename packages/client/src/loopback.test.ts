import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { connectLoopback, loopbackUrl } from './loopback.js'
import { ensureHostKey, hostProof } from './hostKey.js'
import type { ConnectionHostMessage, HostConnection } from './connect.js'

const servers: http.Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r())))
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

async function profile(): Promise<{ dir: string; key: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-loopback-'))
  dirs.push(dir)
  return { dir, key: await ensureHostKey(dir) }
}

/** A stand-in for the Host's route: `key` is the key its hello is proved with; `onCall` answers /astera/call. */
async function endpoint(o: {
  key?: string
  helloStatus?: number
  helloBody?: unknown
  onCall?: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void
}): Promise<string> {
  const s = http.createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c: string) => (body += c))
    req.on('end', () => {
      if (req.url === '/astera/hello') {
        if (o.helloStatus !== undefined) return void res.writeHead(o.helloStatus, { 'content-type': 'application/json' }).end(JSON.stringify(o.helloBody))
        const nonce = (JSON.parse(body) as { nonce: string }).nonce
        return void res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ host: '9.9.9', pid: 4242, startedAt: 'then', features: ['orch', 'requests', 'mcp'], proof: hostProof(o.key ?? 'a'.repeat(64), nonce) }))
      }
      o.onCall?.(req, body, res)
    })
  })
  servers.push(s)
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`
}

const next = (c: HostConnection): Promise<ConnectionHostMessage> => new Promise((resolve) => c.onMessage(resolve))
const closed = (c: HostConnection): Promise<void> => new Promise((resolve) => c.onClose(resolve))
const opened = async (p: Promise<HostConnection | { error: string }>): Promise<HostConnection> => {
  const c = await p
  if ('error' in c) throw new Error(`not connected: ${c.error}`)
  return c
}

describe('connectLoopback', () => {
  it('proves the Host, then posts the call with the bearer token and answers as an orch-result', async () => {
    const { dir, key } = await profile()
    let seen: { method?: string; url?: string; auth?: string; origin?: string; body: string } | null = null
    const url = await endpoint({
      key,
      onCall: (req, body, res) => {
        seen = { method: req.method, url: req.url, auth: req.headers.authorization, origin: req.headers.origin, body }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 200, body: { ok: 1 }, replayed: true }))
      }
    })
    const c = await opened(connectLoopback({ url, token: 'T'.repeat(43), profileDir: dir }))
    // The hello is the Host's own
    // Final fix pass (minor 3): it serves orch-call only, so it offers orch and requests and nothing else the Host's
    // hello lists (no ping a keepalive would wait on, no pty)
    expect(c.hello).toEqual({ host: '9.9.9', pid: 4242, startedAt: 'then', features: ['orch', 'requests'] })
    const got = next(c)
    c.call({ t: 'orch-call', call: 'cli_1', cmd: 'status', args: { a: 1 }, session: 'ignored', request: 'r1', token: 'T'.repeat(43) })
    expect(await got).toEqual({ t: 'orch-result', call: 'cli_1', status: 200, body: { ok: 1 }, replayed: true })
    expect(seen).toMatchObject({ method: 'POST', url: '/astera/call', auth: `Bearer ${'T'.repeat(43)}`, origin: undefined })
    // Only what the route reads; the session is the token's, so it is not sent
    expect(JSON.parse(seen!.body)).toEqual({ cmd: 'status', args: { a: 1 }, request: 'r1' })
  })

  it('a wrong proof, or a profile with no key, is an impostor and nothing is sent to it', async () => {
    const { dir } = await profile()
    let calls = 0
    const url = await endpoint({ key: 'b'.repeat(64), onCall: (_r, _b, res) => (calls++, res.end('{}')) })
    expect(await connectLoopback({ url, token: 'x', profileDir: dir })).toEqual({ error: 'impostor' })
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-loopback-'))
    dirs.push(empty)
    expect(await connectLoopback({ url, token: 'x', profileDir: empty })).toEqual({ error: 'impostor' })
    // A 200 that is no hello at all
    const plain = await endpoint({ helloStatus: 200, helloBody: { hello: 1 } })
    expect(await connectLoopback({ url: plain, token: 'x', profileDir: dir })).toEqual({ error: 'impostor' })
    expect(calls).toBe(0)
  })

  it('shows the endpoint’s refusal of the token as the answer to the call, and sends no command', async () => {
    const { dir } = await profile()
    let calls = 0
    const url = await endpoint({ helloStatus: 401, helloBody: { error: 'workload token not recognised' }, onCall: (_r, _b, res) => (calls++, res.end('{}')) })
    const c = await opened(connectLoopback({ url, token: 'x', profileDir: dir }))
    const got = next(c)
    c.call({ t: 'orch-call', call: 'cli_1', cmd: 'status', args: {} })
    expect(await got).toEqual({ t: 'orch-result', call: 'cli_1', status: 401, body: { error: 'workload token not recognised' } })
    expect(calls).toBe(0)
  })

  it('an endpoint nobody listens at is unreachable at the hello, not a lost answer', async () => {
    const { dir } = await profile()
    const s = http.createServer()
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    const port = (s.address() as AddressInfo).port
    await new Promise<void>((r) => s.close(() => r()))
    expect(await connectLoopback({ url: `http://127.0.0.1:${port}`, token: 'x', profileDir: dir })).toEqual({ error: 'unreachable' })
  })

  it('an endpoint that connects and says nothing is a timeout', async () => {
    const { dir } = await profile()
    const s = http.createServer(() => {})
    servers.push(s)
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`
    expect(await connectLoopback({ url, token: 'x', profileDir: dir, timeoutMs: 100 })).toEqual({ error: 'timeout' })
  })

  it('a call whose answer is lost after it was sent closes the connection', async () => {
    const { dir, key } = await profile()
    const url = await endpoint({ key, onCall: (req) => req.socket.destroy() })
    const c = await opened(connectLoopback({ url, token: 'x', profileDir: dir }))
    const gone = closed(c)
    c.call({ t: 'orch-call', call: 'cli_1', cmd: 'status', args: {} })
    await gone
    // and so does an answer that is no result
    const html = await endpoint({ key, onCall: (_r, _b, res) => res.writeHead(200).end('<html>') })
    const d = await opened(connectLoopback({ url: html, token: 'x', profileDir: dir }))
    const gone2 = closed(d)
    d.call({ t: 'orch-call', call: 'cli_1', cmd: 'status', args: {} })
    await gone2
  })
})

describe('loopbackUrl', () => {
  it('accepts http://127.0.0.1:<port> and nothing else', () => {
    expect(loopbackUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
    expect(loopbackUrl('http://127.0.0.1:65535')).toBe('http://127.0.0.1:65535')
    for (const bad of [undefined, '', 'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:080', 'http://127.0.0.1', 'https://127.0.0.1:80', 'http://localhost:80', 'http://evil.example:80', 'http://127.0.0.1:80/', 'http://127.0.0.1:80/x', 'http://user@127.0.0.1:80', 'http://127.0.0.1:80 ', 'http://127.0.0.1:123456'])
      expect(loopbackUrl(bad), String(bad)).toBeNull()
  })
})
