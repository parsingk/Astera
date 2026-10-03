import { describe, it, expect, afterEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { allowedHosts, hostsWithoutPort, offeredHosts, parseMcpHttpArgs, readyLineOf, serveMcpHttp } from './http'
import { reachableUrls } from '../../core/mcp/httpUrls'
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

async function start(
  extra: { idleMs?: number; hosts?: string[]; closeThrows?: boolean } = {}
) {
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
        close: () => {
          made.closed = true
          if (extra.closeThrows) throw new Error('link close failed')
        }
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
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: a.method ?? 'POST', path: a.path ?? '/mcp', headers: a.headers ?? {} },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
      }
    )
    req.on('error', reject)
    if (a.body !== undefined) req.write(a.body)
    req.end()
  })
}

const CRLF = String.fromCharCode(13, 10)

/** A request written on a bare socket (its head lines, then the body): the reply as text once the server closes the connection. A
 *  server that kept the connection open would leave this pending and the test would time out. */
function closedAfter(port: number, head: string[], body = ''): Promise<string> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1')
    let got = ''
    sock.setEncoding('utf8')
    sock.on('data', (c: string) => (got += c))
    // The server may cut the connection while the body is still being written.
    sock.on('error', () => {})
    sock.on('close', () => resolve(got))
    sock.write([...head, '', body].join(CRLF))
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

  it('closes every open session, its GET stream included, once a request shows the token changed', async () => {
    const s = await start()
    const auth = { ...JSON_HEADERS, authorization: `Bearer ${TOKEN}` }
    const sid = String((await raw(s.port, { headers: auth, body: INIT })).headers['mcp-session-id'])
    // The standalone GET stream an MCP client keeps open for server messages.
    const stream = await new Promise<{ ended: Promise<void> }>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: s.port, method: 'GET', path: '/mcp', headers: { accept: 'text/event-stream', authorization: `Bearer ${TOKEN}`, 'mcp-session-id': sid } },
        (res) => {
          expect(res.statusCode).toBe(200)
          res.resume()
          resolve({ ended: new Promise<void>((done) => res.on('close', () => done())) })
        }
      )
      req.on('error', reject)
      req.end()
    })
    const tmp = `${s.tokenFile}.tmp`
    await fs.writeFile(tmp, `${OTHER}\n`)
    await fs.rename(tmp, s.tokenFile)
    // The next request (here a client with the new token) is when the process reads the new token.
    await connect(s.url, OTHER, 'after')
    await stream.ended
    expect(s.links[0].closed).toBe(true)
    expect(s.links[1].closed).toBe(false)
    const gone = await raw(s.port, { method: 'GET', headers: { accept: 'text/event-stream', authorization: `Bearer ${OTHER}`, 'mcp-session-id': sid } })
    expect(gone.status).toBe(404)
  })

  it('answers 503 to an initialize past 64 open sessions, concurrent ones included, and opens one again after a close', async () => {
    const s = await start()
    const auth = { ...JSON_HEADERS, authorization: `Bearer ${TOKEN}` }
    const answers = await Promise.all(Array.from({ length: 70 }, () => raw(s.port, { headers: auth, body: INIT })))
    expect(answers.filter((r) => r.status === 200)).toHaveLength(64)
    const busy = answers.filter((r) => r.status !== 200)
    expect(busy).toHaveLength(6)
    for (const r of busy) {
      expect(r.status).toBe(503)
      expect(JSON.parse(r.body)).toMatchObject({ error: { message: expect.stringContaining('64') } })
    }
    await expect(connect(s.url, TOKEN)).rejects.toThrow()
    expect(s.links.filter((l) => !l.closed)).toHaveLength(64)
    // A session closed by its client makes room for one more.
    const sid = String(answers.find((r) => r.status === 200)!.headers['mcp-session-id'])
    expect((await raw(s.port, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}`, 'mcp-session-id': sid } })).status).toBe(200)
    expect((await raw(s.port, { headers: auth, body: INIT })).status).toBe(200)
    expect((await raw(s.port, { headers: auth, body: INIT })).status).toBe(503)
  })

  it('answers 413 to a body over 4 MB, declared or streamed, and closes the connection; 404 off /mcp', async () => {
    const s = await start()
    const head = (more: string) => [
      'POST /mcp HTTP/1.1',
      `Host: 127.0.0.1:${s.port}`,
      `Authorization: Bearer ${TOKEN}`,
      'Content-Type: application/json',
      more
    ]
    // Declared: answered from the header, while the body is still to come.
    const declared = await closedAfter(s.port, head(`Content-Length: ${4 * 1024 * 1024 + 1}`), '{')
    expect(declared).toMatch(/^HTTP\/1\.1 413/)
    expect(declared.toLowerCase()).toContain('connection: close')
    // Streamed (chunked) past the cap.
    const chunk = 'x'.repeat(4 * 1024 * 1024 + 1)
    const streamed = await closedAfter(s.port, head('Transfer-Encoding: chunked'), [chunk.length.toString(16), chunk, ''].join(CRLF))
    expect(streamed).toMatch(/^HTTP\/1\.1 413/)
    const auth = { ...JSON_HEADERS, authorization: `Bearer ${TOKEN}` }
    expect((await raw(s.port, { headers: auth, path: '/other', body: INIT })).status).toBe(404)
    // Auth comes first: off /mcp without a token is still 401.
    expect((await raw(s.port, { headers: JSON_HEADERS, path: '/other', body: INIT })).status).toBe(401)
  })

  it('closes the connection after a 401 and a 403, without waiting for the body', async () => {
    const s = await start()
    const noToken = await closedAfter(s.port, ['POST /mcp HTTP/1.1', `Host: 127.0.0.1:${s.port}`, 'Content-Length: 1000000'], '{')
    expect(noToken).toMatch(/^HTTP\/1\.1 401/)
    expect(noToken.toLowerCase()).toContain('connection: close')
    const foreign = await closedAfter(
      s.port,
      ['POST /mcp HTTP/1.1', 'Host: evil.example', `Authorization: Bearer ${TOKEN}`, 'Content-Length: 1000000'],
      '{'
    )
    expect(foreign).toMatch(/^HTTP\/1\.1 403/)
    expect(foreign.toLowerCase()).toContain('connection: close')
  })

  it('answers 401 to GET, DELETE and OPTIONS without a token, and to a POST naming an unknown session', async () => {
    const s = await start()
    for (const method of ['GET', 'DELETE', 'OPTIONS'])
      expect((await raw(s.port, { method, headers: { accept: 'text/event-stream' } })).status).toBe(401)
    const unknown = await raw(s.port, { headers: { ...JSON_HEADERS, 'mcp-session-id': 'no-such-session' }, body: INIT })
    expect(unknown.status).toBe(401)
  })

  it('survives a link whose close throws, from DELETE and from the idle sweep', async () => {
    const s = await start({ idleMs: 50, closeThrows: true })
    const a = await connect(s.url, TOKEN, 'alpha')
    await a.client.callTool({ name: 'list_projects', arguments: {} })
    await expect.poll(() => s.links[0].closed, { timeout: 5000 }).toBe(true)
    const b = await connect(s.url, TOKEN, 'beta')
    await b.transport.terminateSession().catch(() => {})
    expect(s.links[1].closed).toBe(true)
    // Still serving.
    const c = await connect(s.url, TOKEN, 'gamma')
    expect((await c.client.listTools()).tools).toHaveLength(34)
    expect(s.logs.some((l) => l.includes('link close failed'))).toBe(true)
  })

  it('says in its ready line, on one line, the hosts it answers to: only loopback when bound to 127.0.0.1', async () => {
    const s = await start({ hosts: ['box'] })
    const line = JSON.stringify(readyLineOf(served!))
    expect(line).not.toContain(String.fromCharCode(10))
    const ready = JSON.parse(line) as { ready: boolean; port: number; addresses: string[] }
    expect(ready.ready).toBe(true)
    expect(ready.port).toBe(s.port)
    expect(ready.addresses.sort()).toEqual(['127.0.0.1', 'box', 'localhost'])
    expect(reachableUrls(ready.addresses, ready.port, [])).toEqual([])
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

describe('allowedHosts', () => {
  it('adds the port to bare names, keeps a given host:port, brackets IPv6, and adds interfaces only beyond loopback', () => {
    const interfaces = { eth0: [{ address: '192.168.1.5' }, { address: 'fe80::2%eth0' }], lo: [{ address: '::1' }] }
    const lan = allowedHosts(7871, '0.0.0.0', ['Box.Tail.Net', 'box:9000', 'fe80::1', ' '], interfaces)
    expect([...lan].sort()).toEqual(
      ['127.0.0.1:7871', 'localhost:7871', 'box.tail.net:7871', 'box:9000', '[fe80::1]:7871', '192.168.1.5:7871', '[fe80::2]:7871', '[::1]:7871'].sort()
    )
    expect([...allowedHosts(7871, '127.0.0.1', [], interfaces)].sort()).toEqual(['127.0.0.1:7871', 'localhost:7871'])
  })
})

describe('hostsWithoutPort', () => {
  it('gives the allowed hosts of an every-interface bind without this port, a typed port kept and IPv6 unbracketed', () => {
    const interfaces = { eth0: [{ address: '192.168.1.5' }, { address: 'fe80::2%eth0' }], ts: [{ address: '100.90.1.2' }] }
    const allowed = allowedHosts(7871, '0.0.0.0', ['Box.Ts.Net', 'proxy:9000', 'box:7871'], interfaces)
    expect(hostsWithoutPort(allowed, 7871).sort()).toEqual(['100.90.1.2', '127.0.0.1', '192.168.1.5', 'box', 'box.ts.net', 'fe80::2', 'localhost', 'proxy:9000'].sort())
  })
})

describe('offeredHosts', () => {
  // The adapters seen on a Windows machine with Hyper-V and WSL (2026-10-03): only the physical one reaches
  // other devices, and the virtual one listed first became the settings screen's default URL.
  const windows = {
    'vEthernet (Default Switch)': [{ address: '172.20.176.1' }],
    '이더넷 3': [{ address: '192.168.0.235' }],
    'vEthernet (WSL (Hyper-V firewall))': [{ address: '172.30.128.1' }],
    'Loopback Pseudo-Interface 1': [{ address: '::1' }, { address: '127.0.0.1' }]
  }

  it('leaves out the addresses of virtual adapters, so only the physical LAN address becomes a URL', () => {
    const offered = offeredHosts(7871, '0.0.0.0', [], windows)
    expect(offered.sort()).toEqual(['127.0.0.1', '192.168.0.235', 'localhost'])
    expect(reachableUrls(offered, 7871, []).map((u) => u.url)).toEqual(['http://192.168.0.235:7871/mcp'])
  })

  it('keeps the virtual adapters in the Host/Origin allow-list: a VM on this machine may still use them', () => {
    const allowed = allowedHosts(7871, '0.0.0.0', [], windows)
    expect(allowed.has('172.20.176.1:7871')).toBe(true)
    expect(allowed.has('172.30.128.1:7871')).toBe(true)
  })

  it('knows the Linux and macOS names of docker, libvirt, VirtualBox and VMware adapters, in any case', () => {
    const unix = {
      docker0: [{ address: '172.17.0.1' }],
      'br-3f2a9c1d0e7b': [{ address: '172.18.0.1' }],
      veth1a2b3c4: [{ address: '172.17.0.5' }],
      virbr0: [{ address: '192.168.122.1' }],
      vmnet8: [{ address: '192.168.56.1' }],
      vboxnet0: [{ address: '192.168.57.1' }],
      'VirtualBox Host-Only Network': [{ address: '192.168.58.1' }],
      'VMware Network Adapter VMnet1': [{ address: '192.168.59.1' }],
      eth0: [{ address: '10.0.0.7' }],
      en0: [{ address: '192.168.1.20' }]
    }
    expect(offeredHosts(7871, '0.0.0.0', [], unix).sort()).toEqual(['10.0.0.7', '127.0.0.1', '192.168.1.20', 'localhost'])
  })

  it('keeps an address a person typed, and one a physical adapter also has', () => {
    const shared = { 'vEthernet (Default Switch)': [{ address: '172.20.176.1' }], eth0: [{ address: '172.20.176.1' }] }
    expect(offeredHosts(7871, '0.0.0.0', [], shared)).toContain('172.20.176.1')
    expect(offeredHosts(7871, '0.0.0.0', ['172.30.128.1'], windows)).toContain('172.30.128.1')
  })

  it('offers no LAN URL when every adapter is virtual', () => {
    const offered = offeredHosts(7871, '0.0.0.0', [], { 'vEthernet (Default Switch)': [{ address: '172.20.176.1' }] })
    expect(reachableUrls(offered, 7871, [])).toEqual([])
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
