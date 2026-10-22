// Agent Control Plane release 2 (Gateway design §4.4, G3, G8): the Gateway runs each shared stdio server once per
// folder, or once per session when switched; gives it its secrets; stops it when idle; restarts it when it dies; and a
// server that cannot start fails with a reason instead of hanging.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../../core/testFixtures'
import { extensionSecrets } from '../../core/extensions/secrets'
import * as secretsModule from '../../core/extensions/secrets'
import { createUpstreamPool, upstreamArgs, type UpstreamPool } from './upstream'
import type { McpExtension } from '../../core/extensions/types'
import { vi } from 'vitest'

const FIXTURE = path.join(__dirname, '__fixtures__', 'echoServer.cjs')
const SECRET = 'fixture-secret-value-000000000001'
const dirs: string[] = []
const pools: UpstreamPool[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const p of pools.splice(0)) await p.close()
  for (const d of dirs.splice(0)) await removeFixture(d)
})

async function rig(over: Partial<Parameters<typeof createUpstreamPool>[0]> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-upstream-'))
  dirs.push(root)
  const profileDir = path.join(root, 'profile')
  const pidFile = path.join(root, 'pids.txt')
  const a = path.join(root, 'repo-a')
  const b = path.join(root, 'repo-b')
  await fs.mkdir(a, { recursive: true })
  await fs.mkdir(b, { recursive: true })
  await extensionSecrets(profileDir).put('mcp.mcp-echo.ECHO_TOKEN', SECRET)
  const logs: string[] = []
  const pool = createUpstreamPool({ profileDir, baseEnv: { ...process.env, ASTERA_SESSION: 'should-not-pass' }, log: (l) => logs.push(l), ...over })
  pools.push(pool)
  const server = (o: Partial<McpExtension> = {}): McpExtension => ({
    id: 'mcp-echo', kind: 'mcp', name: 'echo', transport: 'stdio', command: process.execPath, args: [FIXTURE, pidFile],
    env: { ECHO_TOKEN: { secret: 'mcp.mcp-echo.ECHO_TOKEN' } }, providers: ['claude', 'codex'], importedFrom: 'acc_1', enabled: true, ...o
  })
  const pids = async (): Promise<string[]> => (await fs.readFile(pidFile, 'utf8').catch(() => '')).split('\n').filter(Boolean)
  return { pool, server, pids, a, b, logs, profileDir }
}
const call = (client: Awaited<ReturnType<UpstreamPool['acquire']>>['client'], name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }).then((r) => (r.content as { text: string }[])[0].text)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('upstream pool', () => {
  it('starts one process for two sessions of one folder at once, and both are answered', async () => {
    const h = await rig()
    const [x, y] = await Promise.all([h.pool.acquire(h.server(), h.a, 'tok-1'), h.pool.acquire(h.server(), h.a, 'tok-2')])
    expect(await call(x.client, 'echo', { text: 'hi' })).toBe('echo: hi')
    expect(await call(y.client, 'echo', { text: 'there' })).toBe('echo: there')
    expect(await h.pids()).toHaveLength(1)
    expect(h.pool.states()).toEqual([{ serverId: 'mcp-echo', processes: 1, state: 'running' }])
  })

  it('starts another for another folder, and one per session when the server is switched to it', async () => {
    const h = await rig()
    await h.pool.acquire(h.server(), h.a, 'tok-1')
    await h.pool.acquire(h.server(), h.b, 'tok-1')
    expect(await h.pids()).toHaveLength(2)
    const isolated = h.server({ id: 'mcp-iso', isolation: 'session' })
    await h.pool.acquire(isolated, h.a, 'tok-1')
    await h.pool.acquire(isolated, h.a, 'tok-2')
    expect(await h.pids()).toHaveLength(4)
  })

  it('gives the server its secret and none of Astera’s own variables', async () => {
    const h = await rig()
    const { client } = await h.pool.acquire(h.server(), h.a, 'tok-1')
    expect(await call(client, 'env', { name: 'ECHO_TOKEN' })).toBe('set')
    expect(await call(client, 'env', { name: 'ASTERA_SESSION' })).toBe('unset')
  })

  it('answers the server’s roots request with the folder', async () => {
    const h = await rig()
    const { client } = await h.pool.acquire(h.server(), h.a, 'tok-1')
    const roots = JSON.parse(await call(client, 'roots')) as { uri: string }[]
    expect(roots).toHaveLength(1)
    expect(decodeURIComponent(roots[0].uri).toLowerCase()).toContain('repo-a')
  })

  it('stops the process once the last session lets go, after the idle time', async () => {
    const h = await rig({ idleMs: 200 })
    const x = await h.pool.acquire(h.server(), h.a, 'tok-1')
    x.release()
    await sleep(500)
    expect(h.pool.states()).toEqual([])
  })

  it('restarts a server that died, after the backoff', async () => {
    const h = await rig({ backoffMs: [50] })
    const x = await h.pool.acquire(h.server(), h.a, 'tok-1')
    await call(x.client, 'crash').catch(() => {})
    await sleep(100)
    expect(h.pool.states()[0].state).toBe('restarting')
    await expect(h.pool.acquire(h.server(), h.a, 'tok-1').then(() => 'early')).resolves.toBe('early')
    expect(await h.pids()).toHaveLength(2)
    expect(h.pool.states()[0].state).toBe('running')
  })

  it('fails a server whose secret cannot be read, naming the server and no value', async () => {
    const h = await rig()
    vi.spyOn(secretsModule, 'extensionSecrets').mockReturnValue({ put: async () => {}, remove: async () => {}, terms: async () => [], get: async () => null })
    await expect(h.pool.acquire(h.server(), h.a, 'tok-1')).rejects.toThrow(/echo/)
    expect(h.pool.states()).toEqual([expect.objectContaining({ serverId: 'mcp-echo', state: 'failed', lastError: expect.stringMatching(/secret/) })])
    expect(JSON.stringify(h.pool.states())).not.toContain(SECRET)
  })

  it('fails a server that never answers initialize, after the start timeout', async () => {
    const h = await rig({ startTimeoutMs: 300 })
    const silent = h.server({ args: [FIXTURE, path.join(h.profileDir, 'silent-pids.txt'), 'silent'] })
    await expect(h.pool.acquire(silent, h.a, 'tok-1')).rejects.toThrow(/did not start/)
    expect(h.pool.states()[0].state).toBe('failed')
  })

  it('stops every process of one server and only those', async () => {
    const h = await rig()
    await h.pool.acquire(h.server(), h.a, 'tok-1')
    await h.pool.acquire(h.server(), h.b, 'tok-1')
    await h.pool.acquire(h.server({ id: 'mcp-other' }), h.a, 'tok-1')
    await h.pool.stopServer('mcp-echo')
    expect(h.pool.states()).toEqual([{ serverId: 'mcp-other', processes: 1, state: 'running' }])
  })
})

// Final review of release 2
describe('upstream pool, after the final review', () => {
  it('does not hand out or keep a server stopped while it was starting (I2)', async () => {
    const h = await rig()
    const slow = h.server({ args: [FIXTURE, path.join(h.profileDir, 'slow-pids.txt'), 'slow'] })
    const starting = h.pool.acquire(slow, h.a, 'tok-1').then(() => 'handed out', (e: Error) => e.message)
    await sleep(200)
    await h.pool.stopServer('mcp-echo')
    expect(await starting).toMatch(/stopped/)
    expect(h.pool.states()).toEqual([])
  })

  it('forgets a failed server nobody uses after the idle time (M3)', async () => {
    const h = await rig({ idleMs: 200, startTimeoutMs: 150 })
    const silent = h.server({ args: [FIXTURE, path.join(h.profileDir, 'silent-pids.txt'), 'silent'] })
    await h.pool.acquire(silent, h.a, 'tok-1').catch(() => {})
    expect(h.pool.states()[0].state).toBe('failed')
    await sleep(500)
    expect(h.pool.states()).toEqual([])
  })

  it('keeps a key’s notification listeners when its process is started again (M6)', async () => {
    const h = await rig()
    const x = await h.pool.acquire(h.server(), h.a, 'tok-1')
    const heard: string[] = []
    h.pool.onNotification(x.key, (n) => void heard.push(n.method))
    await h.pool.stopServer('mcp-echo')
    const y = await h.pool.acquire(h.server(), h.a, 'tok-1')
    await call(y.client, 'changed')
    await expect.poll(() => heard).toContain('notifications/tools/list_changed')
  })

  it('logs a stderr line written in two pieces as one line (M2)', async () => {
    const h = await rig()
    const x = await h.pool.acquire(h.server(), h.a, 'tok-1')
    await call(x.client, 'split')
    await expect.poll(() => h.logs.join('\n')).toContain('gateway: echo: abcdef')
  })

  it.runIf(process.platform === 'win32')('ends a server started through a .cmd shim, child included, when it is stopped (M8)', async () => {
    const h = await rig()
    const pidFile = path.join(h.profileDir, 'stubborn-pids.txt')
    const shim = path.join(h.profileDir, 'stubborn.cmd')
    await fs.mkdir(h.profileDir, { recursive: true })
    await fs.writeFile(shim, `@"${process.execPath}" "${FIXTURE}" "${pidFile}" stubborn\r\n`)
    await h.pool.acquire(h.server({ command: shim, args: [] }), h.a, 'tok-1')
    const pid = Number((await fs.readFile(pidFile, 'utf8')).trim())
    await h.pool.stopServer('mcp-echo')
    const alive = (): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    await expect.poll(alive, { timeout: 8000 }).toBe(false)
  })
})

// Real-session check 2026-10-22: two per-session Playwright processes fought over Playwright's one default browser
// profile ("Browser is already in use … use --isolated"); one process per session needs one profile per process
describe('upstreamArgs', () => {
  it('adds --isolated to a per-session browser server that does not have it, and leaves the rest alone', () => {
    const base = { id: 'mcp-pw', kind: 'mcp' as const, name: 'playwright', transport: 'stdio' as const, command: 'npx', env: {}, providers: ['claude' as const], importedFrom: 'a', enabled: true }
    expect(upstreamArgs({ ...base, args: ['@playwright/mcp@latest', '--headless'], isolation: 'session' })).toEqual(['@playwright/mcp@latest', '--headless', '--isolated'])
    expect(upstreamArgs({ ...base, args: ['chrome-devtools-mcp@latest'], isolation: 'session' })).toEqual(['chrome-devtools-mcp@latest', '--isolated'])
    expect(upstreamArgs({ ...base, args: ['@playwright/mcp', '--isolated'], isolation: 'session' })).toEqual(['@playwright/mcp', '--isolated'])
    expect(upstreamArgs({ ...base, args: ['@playwright/mcp'] })).toEqual(['@playwright/mcp'])
    expect(upstreamArgs({ ...base, args: ['-y', 'linear-mcp'], isolation: 'session' })).toEqual(['-y', 'linear-mcp'])
  })
})
