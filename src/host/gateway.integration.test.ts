// Agent Control Plane release 2, end to end on the Host (Gateway design §5): a stdio server imported once with a
// secret reaches the sessions of three accounts through the Host's MCP Gateway. No session holds the value; sessions in
// one folder share one process and another folder gets its own; a session that ended is refused; a profile that shares
// nothing opens no port and adds no flag.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createHostSpawner } from './spawner'
import { createHostExtensions } from './extensions/commands'
import { createGatewayHub, type GatewayHub } from './gateway/hub'
import { PtyRegistry, type RegistryPty } from './registry'
import { ProcRegistry, type RegistryProc } from './procRegistry'
import { readAccountEntries } from '../core/accounts/accountsFile'
import { extensionPaths } from '../core/profile/paths'
import { emptyState } from '../core/orchestration/state'
import type { Account } from '../core/types'
import type { OrchCall } from '../core/host/orchProtocol'
import type { HostMessage } from '../core/host/protocol'

const FIXTURE = path.join(__dirname, 'gateway', '__fixtures__', 'echoServer.cjs')
const NOW = '2026-10-22T00:00:00.000Z'
const SECRET = 'echo_end_to_end_value_must_not_leak_77'

let dir: string
let profile: string
let repo: string
let repo2: string
let home: string
const hubs: GatewayHub[] = []
const clients: Client[] = []
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-gw-e2e-'))
  profile = path.join(dir, 'profile')
  repo = path.join(dir, 'repo')
  repo2 = path.join(dir, 'repo2')
  home = path.join(dir, 'home')
  for (const d of [profile, repo, repo2, home, path.join(dir, 'skills'), path.join(dir, 'cfg1'), path.join(dir, 'cfg2'), path.join(dir, 'cfg3'), path.join(dir, 'cfg4')])
    await fs.mkdir(d, { recursive: true })
  await fs.writeFile(path.join(dir, 'Astera.exe'), '')
  await fs.writeFile(path.join(dir, 'cli.js'), '')
  const acc = (id: string, cfg: string, provider: 'claude' | 'codex') => ({ id, label: id, configDir: path.join(dir, cfg), color: '#888', createdAt: NOW, provider })
  await fs.writeFile(path.join(profile, 'accounts.json'), JSON.stringify({ accounts: [acc('acc1', 'cfg1', 'claude'), acc('acc2', 'cfg2', 'claude'), acc('acc3', 'cfg3', 'codex'), acc('acc4', 'cfg4', 'claude')] }))
  // The default account's own server: a stdio one with a credential
  await fs.writeFile(
    path.join(dir, 'cfg1', '.claude.json'),
    JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [FIXTURE, path.join(dir, 'pids.txt')], env: { ECHO_TOKEN: SECRET } } } })
  )
})
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  for (const h of hubs.splice(0)) await h.close()
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

type Spawned = { id: string; args: string[] | string; env: Record<string, string | undefined>; exit: () => void }
function rig(o: { call?: OrchCall['call']; broadcast?: (m: HostMessage) => void } = {}) {
  const spawned: Spawned[] = []
  const registry = new PtyRegistry({
    spawn: (_file, args, opts) => {
      let onExit: (e: { exitCode: number }) => void = () => {}
      const pty = { pid: 1000 + spawned.length, onData: () => {}, onExit: (cb: typeof onExit) => (onExit = cb), write() {}, resize() {}, kill() {}, pause() {}, resume() {} }
      spawned.push({ id: '', args, env: opts.env, exit: () => onExit({ exitCode: 0 }) })
      return pty as unknown as RegistryPty
    },
    log: () => {}
  })
  const procs = new ProcRegistry({ spawn: () => ({ pid: 1, onData: () => {}, onExit: () => {}, write() {}, kill() {} }) as unknown as RegistryProc, log: () => {} })
  // A pty's session is named after it, so a test can tell the session a token stands for
  const hub = createGatewayHub({
    profileDir: profile, ptys: registry, procs, sessionOfOwner: (id) => `session-of-${id}`, log: () => {},
    ...(o.call ? { call: o.call } : {}), ...(o.broadcast ? { broadcast: o.broadcast } : {})
  })
  hubs.push(hub)
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, ASTERA_HOST_PROFILE_DIR: profile, ASTERA_HOST_CLI_EXEC: path.join(dir, 'Astera.exe'),
    ASTERA_HOST_CLI_ENTRY: path.join(dir, 'cli.js'), ASTERA_HOST_SKILLS: path.join(dir, 'skills')
  }
  const spawner = createHostSpawner({
    gatewayPort: () => hub.sync(),
    profileDir: profile, env, platform: process.platform, homeDir: home, registry, broadcast: () => {}, getState: () => emptyState(), log: () => {},
    appKeepsWorktrees: () => false,
    worktrees: { fork: () => Promise.reject(new Error('not in this test')), makeRunWorktree: async () => { throw new Error('no') }, mergeWorktrees: async () => { throw new Error('no') }, removeWorktrees: async () => { throw new Error('no') } }
  })!
  const readAccounts = (): Promise<Account[]> => readAccountEntries(path.join(profile, 'accounts.json'))
  const ext = createHostExtensions({ profileDir: profile, homeDir: home, readAccounts, log: () => {}, gateway: hub })
  const call = (cmd: string, args: Record<string, unknown> = {}) => ext.command({ cmd, args, role: 'app', marks: { effects: 0 } })
  const start = async (accountId: string, cwd = repo): Promise<Spawned> => {
    await spawner.createSession({ accountId, cwd, rollAccountIds: [] })
    return spawned[spawned.length - 1]
  }
  /** The session's side: the SDK client the CLI would be, with the token from the spawned environment. */
  const connect = async (s: Spawned): Promise<Client> => {
    const client = new Client({ name: 'session', version: '1' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${hub.port()}/mcp/mcp-echo`), { requestInit: { headers: { Authorization: `Bearer ${s.env.ASTERA_GATEWAY_TOKEN}` } } })
    )
    clients.push(client)
    return client
  }
  return { hub, spawned, call, start, connect }
}
/** A raw POST, so a test controls every header (fetch would fill Host and Origin in its own way). */
function post(port: number, p: string, headers: Record<string, string>, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text
const line = (s: Spawned) => (Array.isArray(s.args) ? s.args.join(' ') : s.args)
async function filesUnder(root: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(root, e.name)
    if (e.isDirectory()) out.push(...(await filesUnder(p)))
    else out.push(p)
  }
  return out
}

describe('the MCP Gateway on the Host, end to end', () => {
  it('opens no port and adds no MCP configuration while nothing is shared (G-06)', async () => {
    const h = rig()
    const s = await h.start('acc2')
    expect(line(s)).not.toContain('--mcp-config')
    // The token is the session's workload token now; with nothing shared its grant reaches no server.
    expect(s.env.ASTERA_GATEWAY_GRANT).toBe('')
  })

  it('the Gateway listens with no shared server', async () => {
    const h = rig()
    const s = await h.start('acc2')
    const port = h.hub.port()
    expect(port).toBeGreaterThan(0)
    // The session is told where, beside its token
    expect(s.env.ASTERA_LOOPBACK).toBe(`http://127.0.0.1:${port}`)
    // and no shared server is reachable through it
    const gone = await post(port!, '/mcp/mcp-echo', { authorization: `Bearer ${s.env.ASTERA_GATEWAY_TOKEN}` }, '{}')
    expect(gone.status).toBe(403)
  })

  it('the command route runs a command as the token’s session', async () => {
    const calls: Parameters<OrchCall['call']>[0][] = []
    const h = rig({ call: async (a) => (calls.push(a), { status: 200, body: { ran: a.cmd }, replayed: true }) })
    const s = await h.start('acc2')
    const r = await post(h.hub.port()!, '/astera/call', { authorization: `Bearer ${s.env.ASTERA_GATEWAY_TOKEN}` }, JSON.stringify({ cmd: 'status', args: { a: 1 }, request: 'r1', session: 'someone-else' }))
    expect(r.status).toBe(200)
    expect(JSON.parse(r.text)).toEqual({ status: 200, body: { ran: 'status' }, replayed: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ cmd: 'status', args: { a: 1 }, request: 'r1', from: { role: 'cli' } })
    expect(calls[0].sessionId).toMatch(/^session-of-/)
    expect(calls[0].sessionId).not.toBe('someone-else')
  })

  it('the command route refuses an Origin, a wrong Host and no token', async () => {
    const calls: unknown[] = []
    const h = rig({ call: async (a) => (calls.push(a), { status: 200, body: {} }) })
    const s = await h.start('acc2')
    const port = h.hub.port()!
    const auth = { authorization: `Bearer ${s.env.ASTERA_GATEWAY_TOKEN}` }
    const body = JSON.stringify({ cmd: 'status', args: {} })
    expect((await post(port, '/astera/call', { ...auth, origin: 'http://evil.example' }, body)).status).toBe(403)
    expect((await post(port, '/astera/call', { ...auth, host: 'evil.example' }, body)).status).toBe(421)
    const none = await post(port, '/astera/call', {}, body)
    expect(none.status).toBe(401)
    expect(JSON.parse(none.text)).toEqual({ error: 'workload token not recognised' })
    expect((await post(port, '/astera/call', { authorization: `Bearer ${'x'.repeat(300)}` }, body)).status).toBe(401)
    expect((await post(port, '/astera/call', { authorization: `Bearer ${'Z'.repeat(43)}` }, body)).status).toBe(401)
    expect(calls).toEqual([])
    // Only once it is the session’s own: a body that is no command is 400
    expect((await post(port, '/astera/call', auth, 'not json')).status).toBe(400)
    expect((await post(port, '/astera/call', auth, JSON.stringify({ args: {} }))).status).toBe(400)
    expect(calls).toEqual([])
  })

  it('a body over 4 MB is refused', async () => {
    const calls: unknown[] = []
    const h = rig({ call: async (a) => (calls.push(a), { status: 200, body: {} }) })
    const s = await h.start('acc2')
    const big = JSON.stringify({ cmd: 'status', args: { pad: 'x'.repeat(4 * 1024 * 1024 + 10) } })
    const r = await post(h.hub.port()!, '/astera/call', { authorization: `Bearer ${s.env.ASTERA_GATEWAY_TOKEN}` }, big)
    expect(r.status).toBe(413)
    expect(calls).toEqual([])
  })

  it('a command that takes a while still answers, and a command’s state change reaches the Host’s sockets', async () => {
    const sent: HostMessage[] = []
    const h = rig({
      call: async (a) => {
        await new Promise((r) => setTimeout(r, 1500))
        a.from?.toOthers({ t: 'orch-state', state: emptyState(), version: 1 } as HostMessage)
        return { status: 200, body: { waited: true } }
      },
      broadcast: (m) => sent.push(m)
    })
    const s = await h.start('acc2')
    const r = await post(h.hub.port()!, '/astera/call', { authorization: `Bearer ${s.env.ASTERA_GATEWAY_TOKEN}` }, JSON.stringify({ cmd: 'ask', args: {} }))
    expect(JSON.parse(r.text)).toEqual({ status: 200, body: { waited: true } })
    expect(sent.map((m) => m.t)).toEqual(['orch-state'])
  })

  it('gives three accounts’ sessions the shared server with no value in hand, shares one process per folder, and refuses an ended session', async () => {
    const h = rig()
    const imported = await h.call('extensions-import', { accountId: 'acc1', picks: [{ kind: 'mcp', name: 'echo' }] })
    expect(imported.body).toMatchObject({ imported: ['echo'], refused: [] })

    const a = await h.start('acc2', repo)
    const b = await h.start('acc4', repo)
    const c = await h.start('acc3', repo2)
    for (const s of [a, b, c]) {
      expect(s.env.ASTERA_GATEWAY_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(JSON.stringify([line(s), s.env])).not.toContain(SECRET)
    }
    expect(line(c)).toContain("bearer_token_env_var='ASTERA_GATEWAY_TOKEN'")

    // G-01, G-02: the server has its secret; one process for repo, a second for repo2
    const ca = await h.connect(a)
    const cb = await h.connect(b)
    const cc = await h.connect(c)
    expect(text(await ca.callTool({ name: 'env', arguments: { name: 'ECHO_TOKEN' } }))).toBe('set')
    expect(text(await cb.callTool({ name: 'echo', arguments: { text: 'b' } }))).toBe('echo: b')
    expect(text(await cc.callTool({ name: 'echo', arguments: { text: 'c' } }))).toBe('echo: c')
    expect((await fs.readFile(path.join(dir, 'pids.txt'), 'utf8')).split('\n').filter(Boolean)).toHaveLength(2)
    expect(h.hub.states()).toEqual([{ serverId: 'mcp-echo', processes: 2, state: 'running' }])

    // No file Astera wrote holds the value: the profile outside the secret store, and the accounts it was given to
    const secrets = extensionPaths(profile).secrets
    const leaking: string[] = []
    for (const f of [...(await filesUnder(profile)), ...(await filesUnder(path.join(dir, 'cfg2'))), ...(await filesUnder(path.join(dir, 'cfg3'))), ...(await filesUnder(path.join(dir, 'cfg4')))]) {
      if (f.startsWith(secrets + path.sep)) continue
      if ((await fs.readFile(f)).includes(SECRET)) leaking.push(path.relative(dir, f))
    }
    expect(leaking).toEqual([])

    // G-04: once a session's pty exits, its token opens nothing; the others keep working
    a.exit()
    const refused = await fetch(`http://127.0.0.1:${h.hub.port()}/mcp/mcp-echo`, {
      method: 'POST',
      headers: { authorization: `Bearer ${a.env.ASTERA_GATEWAY_TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } })
    })
    expect(refused.status).toBe(401)
    expect(text(await cb.callTool({ name: 'echo', arguments: { text: 'still' } }))).toBe('echo: still')
  })
})
