// Agent Control Plane release 2 (Gateway design §4.1, anti-goal 1): the Host listens only while a stdio server is
// shared, and a session the Host opens with a token reaches it.
import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../../core/testFixtures'
import { writeExtensionRegistry } from '../../core/extensions/registry'
import { PtyRegistry, type RegistryPty } from '../registry'
import { ProcRegistry, type RegistryProc } from '../procRegistry'
import { createGatewayHub, type GatewayHub } from './hub'
import type { McpExtension } from '../../core/extensions/types'

const FIXTURE = path.join(__dirname, '__fixtures__', 'echoServer.cjs')
const TOKEN = 'H'.repeat(43)
const dirs: string[] = []
const hubs: GatewayHub[] = []
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close()
  for (const d of dirs.splice(0)) await removeFixture(d)
})

async function rig() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-hub-'))
  dirs.push(root)
  const profileDir = path.join(root, 'profile')
  const ptyExit: ((e: { exitCode: number }) => void)[] = []
  const ptys = new PtyRegistry({
    spawn: () => ({ pid: 1, onData: () => {}, onExit: (cb: (e: { exitCode: number }) => void) => ptyExit.push(cb), write() {}, resize() {}, kill() {}, pause() {}, resume() {} }) as unknown as RegistryPty,
    log: () => {}
  })
  const procs = new ProcRegistry({ spawn: () => ({ pid: 2, onData: () => {}, onExit: () => {}, write() {}, kill() {} }) as unknown as RegistryProc, log: () => {} })
  const hub = createGatewayHub({ profileDir, ptys, procs, log: () => {} })
  hubs.push(hub)
  const echo: McpExtension = {
    id: 'mcp-echo', kind: 'mcp', name: 'echo', transport: 'stdio', command: process.execPath, args: [FIXTURE, path.join(root, 'pids.txt')],
    env: {}, providers: ['claude', 'codex'], importedFrom: 'acc_1', enabled: true
  }
  const share = (entries: McpExtension[]) => writeExtensionRegistry(profileDir, { version: 1, entries })
  const status = (port: number, token: string) =>
    new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/mcp/mcp-echo', method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` } },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        }
      )
      req.on('error', reject)
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }))
    })
  return { hub, ptys, ptyExit, echo, share, status, root }
}

describe('gateway hub', () => {
  it('opens no port while no stdio server is shared', async () => {
    const h = await rig()
    expect(await h.hub.sync()).toBeNull()
    await h.share([{ ...h.echo, transport: 'http', command: undefined, args: undefined, url: 'https://mcp.example.com' }])
    expect(await h.hub.sync()).toBeNull()
    expect(h.hub.port()).toBeNull()
  })

  it('listens once a stdio server is shared, lets in a session the Host opened with its token, and closes when none is', async () => {
    const h = await rig()
    await h.share([h.echo])
    const port = await h.hub.sync()
    expect(port).toBeGreaterThan(0)
    expect(await h.status(port!, TOKEN)).toBe(401)
    h.ptys.open({ id: 'p1', file: 'claude', args: [], opts: { cwd: h.root, cols: 80, rows: 24, env: { ASTERA_GATEWAY_TOKEN: TOKEN, ASTERA_GATEWAY_GRANT: 'mcp-echo' } } })
    expect(await h.status(port!, TOKEN)).toBe(200)
    h.ptyExit[0]({ exitCode: 0 })
    expect(await h.status(port!, TOKEN)).toBe(401)
    await h.share([])
    expect(await h.hub.sync()).toBeNull()
    await expect(h.status(port!, TOKEN)).rejects.toThrow()
  })

  it('stops a server’s processes and shows its state', async () => {
    const h = await rig()
    await h.share([h.echo])
    const port = (await h.hub.sync())!
    h.ptys.open({ id: 'p1', file: 'claude', args: [], opts: { cwd: h.root, cols: 80, rows: 24, env: { ASTERA_GATEWAY_TOKEN: TOKEN, ASTERA_GATEWAY_GRANT: 'mcp-echo' } } })
    await h.status(port, TOKEN)
    expect(h.hub.states()).toEqual([{ serverId: 'mcp-echo', processes: 1, state: 'running' }])
    await h.hub.stopServer('mcp-echo')
    expect(h.hub.states()).toEqual([])
  })
})
