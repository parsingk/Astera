// Agent Control Plane release 2 (Gateway design §4.1, §4.4): the Gateway answers only live session tokens on loopback,
// only for the servers a token was given, passes calls to the shared upstream, passes its notifications to every
// session on it, and ends a session's calls when its token goes.
import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { removeFixture } from '../../core/testFixtures'
import { createTokenTable } from './tokens'
import { createUpstreamPool } from './upstream'
import { createGateway, type Gateway } from './server'
import type { ExtensionRegistry, McpExtension } from '../../core/extensions/types'

const FIXTURE = path.join(__dirname, '__fixtures__', 'echoServer.cjs')
const TOKEN = 'T'.repeat(43)
const OTHER = 'O'.repeat(43)
const dirs: string[] = []
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c().catch(() => {})
  for (const d of dirs.splice(0)) await removeFixture(d)
})

async function rig() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-gateway-'))
  dirs.push(root)
  const pidFile = path.join(root, 'pids.txt')
  const folder = path.join(root, 'repo')
  await fs.mkdir(folder)
  const echo: McpExtension = {
    id: 'mcp-echo', kind: 'mcp', name: 'echo', transport: 'stdio', command: process.execPath, args: [FIXTURE, pidFile],
    env: {}, providers: ['claude', 'codex'], importedFrom: 'acc_1', enabled: true
  }
  const other: McpExtension = { ...echo, id: 'mcp-other', name: 'other' }
  const registry: ExtensionRegistry = { version: 1, entries: [echo, other] }
  const tokens = createTokenTable()
  tokens.register(TOKEN, { ownerId: 'p1', folder, grant: new Set(['mcp-echo']) })
  tokens.register(OTHER, { ownerId: 'p2', folder, grant: new Set(['mcp-echo']) })
  const pool = createUpstreamPool({ profileDir: path.join(root, 'profile'), baseEnv: process.env, log: () => {} })
  const gateway: Gateway = createGateway({ tokens, pool, readRegistry: async () => registry, log: () => {} })
  const port = await gateway.listen()
  closers.push(() => pool.close(), () => gateway.close())
  const session = async (token = TOKEN, serverId = 'mcp-echo') => {
    const client = new Client({ name: 'test-session', version: '1' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${serverId}`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })
    )
    closers.push(() => client.close())
    return client
  }
  const raw = (headers: Record<string, string>, p = '/mcp/mcp-echo') =>
    new Promise<number>((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } })
      const req = http.request(
        { host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', host: `127.0.0.1:${port}`, ...headers } },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        }
      )
      req.on('error', reject)
      req.end(body)
    })
  const pids = async () => (await fs.readFile(pidFile, 'utf8').catch(() => '')).split('\n').filter(Boolean)
  return { gateway, port, session, raw, pids, tokens, registry, pidFile }
}
const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0].text)

describe('the MCP Gateway', () => {
  it('serves a granted session the upstream’s tools under the upstream’s name', async () => {
    const h = await rig()
    const c = await h.session()
    expect(c.getServerVersion()?.name).toBe('echo-fixture')
    expect((await c.listTools()).tools.map((t) => t.name)).toContain('echo')
    expect(text(await c.callTool({ name: 'echo', arguments: { text: 'hi' } }))).toBe('echo: hi')
  })

  it('refuses no token, a wrong token, a token only in the query, an Origin, a foreign Host and an ungranted server', async () => {
    const h = await rig()
    const bearer = { authorization: `Bearer ${TOKEN}` }
    expect(await h.raw({})).toBe(401)
    expect(await h.raw({ authorization: `Bearer ${'x'.repeat(43)}` })).toBe(401)
    expect(await h.raw({}, `/mcp/mcp-echo?token=${TOKEN}`)).toBe(401)
    expect(await h.raw({ ...bearer, origin: 'https://example.com' })).toBe(403)
    expect(await h.raw({ ...bearer, host: `[::1]:${h.port}` })).toBe(421)
    expect(await h.raw({ ...bearer, host: `evil:${h.port}` })).toBe(421)
    expect(await h.raw(bearer, '/mcp/mcp-other')).toBe(403)
    expect(await h.raw(bearer, '/mcp/mcp-missing')).toBe(403)
    expect(await h.raw(bearer, '/elsewhere')).toBe(404)
  })

  it('shares one upstream between two sessions of one folder, and passes its notifications to both', async () => {
    const h = await rig()
    const a = await h.session(TOKEN)
    const b = await h.session(OTHER)
    const heard: string[] = []
    a.setNotificationHandler(ToolListChangedNotificationSchema, async () => void heard.push('a'))
    b.setNotificationHandler(ToolListChangedNotificationSchema, async () => void heard.push('b'))
    await a.callTool({ name: 'changed', arguments: {} })
    await new Promise((r) => setTimeout(r, 300))
    expect(await h.pids()).toHaveLength(1)
    expect(heard.sort()).toEqual(['a', 'b'])
  })

  // The session's process is gone by then; what matters is that its call does not stay on the shared upstream
  it('stops answering a session whose token went, and cancels its call in flight on the upstream', async () => {
    const h = await rig()
    const c = await h.session()
    void c.callTool({ name: 'hang', arguments: {} }).catch(() => {})
    await new Promise((r) => setTimeout(r, 300))
    h.gateway.forgetTokens([TOKEN])
    h.tokens.forgetOwner('p1')
    await expect.poll(() => fs.readFile(`${h.pidFile}.events`, 'utf8').catch(() => ''), { timeout: 3000 }).toMatch(/cancelled/)
    expect(await h.raw({ authorization: `Bearer ${TOKEN}` })).toBe(401)
    // The other session on the same upstream keeps working
    const other = await h.session(OTHER)
    expect(text(await other.callTool({ name: 'echo', arguments: { text: 'still' } }))).toBe('echo: still')
  })

  it('answers an upstream that died with an error, and keeps the session’s connection for the next call', async () => {
    const h = await rig()
    const c = await h.session()
    await c.callTool({ name: 'crash', arguments: {} }).catch(() => {})
    const r = await c.callTool({ name: 'echo', arguments: { text: 'x' } }).then(text, (e: Error) => e.message)
    expect(r).toMatch(/restarting|echo: x/)
  })
})
