import { describe, it, expect, afterEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { parseMcpHttpArgs, serveMcpHttp } from './http'
import type { HostLink } from './hostLink'

const TOKEN = 'tok-' + 'A'.repeat(40)
const OTHER = 'tok-' + 'B'.repeat(40)

type Made = { client(): { name: string; version?: string } | undefined; remote: string | undefined; calls: string[]; closed: boolean }

let dir = ''
let served: Awaited<ReturnType<typeof serveMcpHttp>> | null = null
const clients: Client[] = []

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  await served?.close()
  served = null
  if (dir) await fs.rm(dir, { recursive: true, force: true })
  dir = ''
})

async function start(extra: { idleMs?: number; hosts?: string[] } = {}) {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-mcp-http-'))
  const tokenFile = path.join(dir, 'mcp-http-token')
  await fs.writeFile(tokenFile, `${TOKEN}\n`)
  const logs: string[] = []
  const links: Made[] = []
  served = await serveMcpHttp({
    port: 0,
    bind: '127.0.0.1',
    hosts: extra.hosts ?? [],
    tokenFile,
    version: '1.4.1',
    env: {},
    platform: process.platform,
    home: '/nonexistent',
    log: (m) => logs.push(m),
    ...(extra.idleMs !== undefined ? { idleMs: extra.idleMs } : {}),
    link: ({ client, remote }) => {
      const made: Made = { client, remote, calls: [], closed: false }
      links.push(made)
      const link: HostLink = {
        call: async (cmd) => {
          made.calls.push(cmd)
          return { status: 200, body: [] }
        },
        close: () => void (made.closed = true)
      }
      return link
    }
  })
  const port = served.address().port
  return { port, tokenFile, logs, links, url: new URL(`http://127.0.0.1:${port}/mcp`) }
}

async function connect(url: URL, token: string | null, name = 'test-client') {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: token === null ? {} : { headers: { Authorization: `Bearer ${token}` } }
  })
  const client = new Client({ name, version: '0' })
  await client.connect(transport)
  clients.push(client)
  return { client, transport }
}

/** A raw request, so the Host header and the body can be anything. */
function raw(port: number, a: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer }) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: a.method ?? 'POST', path: a.path ?? '/mcp', headers: a.headers ?? {} },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      }
    )
    req.on('error', reject)
    if (a.body !== undefined) req.write(a.body)
    req.end()
  })
}

const INIT = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } }
})
const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }

describe('serveMcpHttp', () => {
  it('serves initialize, the 34 tools and a tool call to a client with the token', async () => {
    const s = await start()
    const { client } = await connect(s.url, TOKEN, 'alpha')
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(34)
    const r = await client.callTool({ name: 'list_projects', arguments: {} })
    expect(r.isError).toBeFalsy()
    expect(s.links).toHaveLength(1)
    expect(s.links[0].calls).toEqual(['projects-list'])
    expect(s.links[0].client()).toMatchObject({ name: 'alpha' })
    expect(s.links[0].remote).toBe('127.0.0.1')
  })

  it('refuses a request without a token, with a wrong one and with a replaced one: 401 and one log line', async () => {
    const s = await start()
    const none = await raw(s.port, { headers: JSON_HEADERS, body: INIT })
    expect(none.status).toBe(401)
    expect(JSON.parse(none.body)).toEqual({})
    const wrong = await raw(s.port, { headers: { ...JSON_HEADERS, authorization: `Bearer ${OTHER}` }, body: INIT })
    expect(wrong.status).toBe(401)
    await expect(connect(s.url, null)).rejects.toThrow()
    await expect(connect(s.url, OTHER)).rejects.toThrow()

    // The token file is replaced the way newToken does it: the old token stops working at once.
    await connect(s.url, TOKEN)
    const tmp = `${s.tokenFile}.tmp`
    await fs.writeFile(tmp, `${OTHER}\n`)
    await fs.rename(tmp, s.tokenFile)
    const old = await raw(s.port, { headers: { ...JSON_HEADERS, authorization: `Bearer ${TOKEN}` }, body: INIT })
    expect(old.status).toBe(401)
    await connect(s.url, OTHER)

    const refused = s.logs.filter((l) => l.includes('401'))
    expect(refused.length).toBeGreaterThanOrEqual(5)
    for (const l of refused) expect(l).toContain('127.0.0.1')
    for (const l of s.logs) {
      expect(l).not.toContain(TOKEN)
      expect(l).not.toContain(OTHER)
    }
  })

  it('refuses a foreign Host header and a foreign Origin with 403, and lets an allowed one through', async () => {
    const s = await start({ hosts: ['studio.tail.net'] })
    const auth = { ...JSON_HEADERS, authorization: `Bearer ${TOKEN}` }
    expect((await raw(s.port, { headers: { ...auth, host: `evil.example:${s.port}` }, body: INIT })).status).toBe(403)
    expect((await raw(s.port, { headers: { ...auth, host: `127.0.0.1:${s.port + 1}` }, body: INIT })).status).toBe(403)
    expect((await raw(s.port, { headers: { ...auth, origin: 'http://evil.example' }, body: INIT })).status).toBe(403)
    expect((await raw(s.port, { headers: { ...auth, origin: 'null' }, body: INIT })).status).toBe(403)
    expect((await raw(s.port, { headers: { ...auth, host: `localhost:${s.port}` }, body: INIT })).status).toBe(200)
    expect((await raw(s.port, { headers: { ...auth, host: `studio.tail.net:${s.port}` }, body: INIT })).status).toBe(200)
    expect((await raw(s.port, { headers: { ...auth, origin: `http://localhost:${s.port}` }, body: INIT })).status).toBe(200)
  })

  it('gives each client its own link, named by its own initialize, and DELETE closes only that one', async () => {
    const s = await start()
    const a = await connect(s.url, TOKEN, 'alpha')
    const b = await connect(s.url, TOKEN, 'beta')
    await a.client.callTool({ name: 'list_projects', arguments: {} })
    await b.client.callTool({ name: 'list_projects', arguments: {} })
    expect(s.links.map((l) => l.client()?.name)).toEqual(['alpha', 'beta'])
    expect(s.links.map((l) => l.calls)).toEqual([['projects-list'], ['projects-list']])

    await a.transport.terminateSession()
    expect(s.links.map((l) => l.closed)).toEqual([true, false])
    // The other session still answers.
    expect((await b.client.listTools()).tools).toHaveLength(34)
  })

  it('closes a session unseen for the idle time, and its link with it', async () => {
    const s = await start({ idleMs: 50 })
    const a = await connect(s.url, TOKEN, 'alpha')
    await a.client.callTool({ name: 'list_projects', arguments: {} })
    await expect.poll(() => s.links[0].closed, { timeout: 5000 }).toBe(true)
  })

  it('answers 413 to a body over 4 MB and 404 off /mcp', async () => {
    const s = await start()
    const auth = { ...JSON_HEADERS, authorization: `Bearer ${TOKEN}` }
    const big = Buffer.alloc(4 * 1024 * 1024 + 1, 0x20)
    expect((await raw(s.port, { headers: auth, body: big })).status).toBe(413)
    expect((await raw(s.port, { headers: auth, path: '/other', body: INIT })).status).toBe(404)
    // Auth comes first: off /mcp without a token is still 401.
    expect((await raw(s.port, { headers: JSON_HEADERS, path: '/other', body: INIT })).status).toBe(401)
  })

  it('rejects with EADDRINUSE when the port is taken', async () => {
    const s = await start()
    const second = serveMcpHttp({
      port: s.port,
      bind: '127.0.0.1',
      hosts: [],
      tokenFile: s.tokenFile,
      version: '1.4.1',
      env: {},
      platform: process.platform,
      home: '/nonexistent',
      log: () => {}
    })
    await expect(second).rejects.toMatchObject({ code: 'EADDRINUSE' })
  })
})

describe('parseMcpHttpArgs', () => {
  it('reads the port, bind, token file and hosts', () => {
    expect(parseMcpHttpArgs(['--port', '7871', '--bind', '0.0.0.0', '--token-file', '/p/t', '--hosts', 'a.lan, b:9000,'])).toEqual({
      port: 7871,
      bind: '0.0.0.0',
      tokenFile: '/p/t',
      hosts: ['a.lan', 'b:9000']
    })
    expect(parseMcpHttpArgs(['--port', '1', '--bind', '127.0.0.1', '--token-file', 't'])).toMatchObject({ hosts: [] })
  })

  it('refuses a missing or bad flag', () => {
    expect(parseMcpHttpArgs(['--bind', '127.0.0.1', '--token-file', 't'])).toHaveProperty('error')
    expect(parseMcpHttpArgs(['--port', '70000', '--bind', '127.0.0.1', '--token-file', 't'])).toHaveProperty('error')
    expect(parseMcpHttpArgs(['--port', '1', '--token-file', 't'])).toHaveProperty('error')
    expect(parseMcpHttpArgs(['--port', '1', '--bind', '127.0.0.1'])).toHaveProperty('error')
    expect(parseMcpHttpArgs(['--port', '1', '--bind', '127.0.0.1', '--token-file', 't', '--nope'])).toHaveProperty('error')
  })
})
