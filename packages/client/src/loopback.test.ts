import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { connectLoopback } from './loopback.js'
import type { ConnectionHostMessage } from './connect.js'

const servers: http.Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r())))
})

async function endpoint(handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void): Promise<string> {
  const s = http.createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c: string) => (body += c))
    req.on('end', () => handler(req, body, res))
  })
  servers.push(s)
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`
}

const next = (c: ReturnType<typeof connectLoopback>): Promise<ConnectionHostMessage> => new Promise((resolve) => c.onMessage(resolve))
const closed = (c: ReturnType<typeof connectLoopback>): Promise<void> => new Promise((resolve) => c.onClose(resolve))

describe('connectLoopback', () => {
  it('posts the call with the bearer token and answers as an orch-result', async () => {
    let seen: { method?: string; url?: string; auth?: string; origin?: string; body: string } | null = null
    const url = await endpoint((req, body, res) => {
      seen = { method: req.method, url: req.url, auth: req.headers.authorization, origin: req.headers.origin, body }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 200, body: { ok: 1 }, replayed: true }))
    })
    const c = connectLoopback({ url, token: 'T'.repeat(43) })
    expect(c.hello.features).toEqual(['orch', 'requests'])
    const got = next(c)
    c.call({ t: 'orch-call', call: 'cli_1', cmd: 'status', args: { a: 1 }, session: 'ignored', request: 'r1', token: 'T'.repeat(43) })
    expect(await got).toEqual({ t: 'orch-result', call: 'cli_1', status: 200, body: { ok: 1 }, replayed: true })
    expect(seen).toMatchObject({ method: 'POST', url: '/astera/call', auth: `Bearer ${'T'.repeat(43)}`, origin: undefined })
    // Only what the route reads; the session is the token's, so it is not sent
    expect(JSON.parse(seen!.body)).toEqual({ cmd: 'status', args: { a: 1 }, request: 'r1' })
  })

  it('delivers a refusal of the route as the result it is', async () => {
    const url = await endpoint((_req, _body, res) => res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'workload token not recognised' })))
    const c = connectLoopback({ url, token: 'x' })
    const got = next(c)
    c.call({ t: 'orch-call', call: 'cli_1', cmd: 'status', args: {} })
    expect(await got).toEqual({ t: 'orch-result', call: 'cli_1', status: 401, body: { error: 'workload token not recognised' } })
  })

  it('a refused or unreachable endpoint answers unreachable', async () => {
    // A port nothing listens on: bind one, read it, close it
    const s = http.createServer()
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    const port = (s.address() as AddressInfo).port
    await new Promise<void>((r) => s.close(() => r()))
    const c = connectLoopback({ url: `http://127.0.0.1:${port}`, token: 'x' })
    const gone = closed(c)
    c.call({ t: 'orch-call', call: 'cli_1', cmd: 'status', args: {} })
    await gone
    // and so does an answer that is no result
    const url = await endpoint((_req, _body, res) => res.writeHead(200).end('<html>'))
    const d = connectLoopback({ url, token: 'x' })
    const gone2 = closed(d)
    d.call({ t: 'orch-call', call: 'cli_1', cmd: 'status', args: {} })
    await gone2
  })
})
