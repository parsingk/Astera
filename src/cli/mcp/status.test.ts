import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { mcpStatus } from './status'
import { TOOLS } from './tools'
import { hostAddress } from '../../host/address'
import { startHostServer, type HostServer } from '../../host/server'
import { ensureHostKey } from '../../core/host/hostKey'
import { HOST_PROTOCOL } from '../../core/host/protocol'
import { errEnvelope, exitCodeFor, type CliError } from '../../core/orchestration/cliOutput'

// Spec §40: `astera mcp status` says whether `mcp serve` would work here, without starting a Host.
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function profile(settings?: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-mcp-status-'))
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }))
  if (settings !== undefined) await fs.writeFile(path.join(dir, 'app-settings.json'), settings)
  return dir
}

/** A real Host server on the profile's address. With `orch` it announces the mcp feature, without it
 *  it does not (server.ts: the MCP gate lives in the command layer). */
async function host(profileDir: string, o: { orch: boolean }): Promise<HostServer> {
  const addr = hostAddress({ profileDir, platform: process.platform, tmpDir: os.tmpdir(), protocol: HOST_PROTOCOL })
  const server = await startHostServer({
    address: addr.address,
    dirToPrepare: addr.dirToPrepare,
    version: '9.9.9',
    idleMs: 60_000,
    onIdle: () => {},
    hostKey: await ensureHostKey(profileDir),
    log: { write: () => {}, close: () => {} },
    ...(o.orch ? { orch: { call: async () => ({ status: 200, body: {} }) } } : {})
  })
  cleanups.push(() => server.close())
  return server
}

const run = (profileDir: string) =>
  mcpStatus({ env: { ASTERA_PROFILE_DIR: profileDir }, platform: process.platform, home: os.tmpdir(), version: '1.4.1' })

const failed = (r: Awaited<ReturnType<typeof mcpStatus>>): CliError => {
  if (r.ok) throw new Error(`succeeded: ${JSON.stringify(r.body)}`)
  expect((JSON.parse(errEnvelope(r.error, 'mcp-status')) as { ok: boolean }).ok).toBe(false)
  return r.error
}

describe('mcpStatus', () => {
  it('a Host that speaks mcp: exit 0 with the CLI, the transport, the Host, the access and the tool count', async () => {
    const dir = await profile(JSON.stringify({ mcpAccess: 'read' }))
    await host(dir, { orch: true })
    const r = await run(dir)
    expect(r).toEqual({
      ok: true,
      body: {
        cliVersion: '1.4.1',
        transport: 'stdio',
        host: { running: true, version: '9.9.9', protocol: HOST_PROTOCOL, mcp: true },
        access: 'read',
        tools: TOOLS.length
      }
    })
    expect(TOOLS.length).toBe(36)
  })

  it('no settings file reads as the default, control', async () => {
    const dir = await profile()
    await host(dir, { orch: true })
    expect(await run(dir)).toMatchObject({ ok: true, body: { access: 'control' } })
  })

  it('no Host: HOST_NOT_RUNNING (3) with the same report in details, and no Host is started', async () => {
    const dir = await profile(JSON.stringify({ mcpAccess: 'off' }))
    const e = failed(await run(dir))
    expect(e.code).toBe('HOST_NOT_RUNNING')
    expect(exitCodeFor(e.code)).toBe(3)
    expect(e.details).toEqual({ cliVersion: '1.4.1', transport: 'stdio', host: { running: false, mcp: false }, access: 'off', tools: TOOLS.length })
    // Still nothing at the address afterwards: status only looks.
    expect(failed(await run(dir)).code).toBe('HOST_NOT_RUNNING')
  })

  it('a Host without the mcp feature: VERSION_MISMATCH (9), saying so', async () => {
    const dir = await profile()
    await host(dir, { orch: false })
    const e = failed(await run(dir))
    expect(e.code).toBe('VERSION_MISMATCH')
    expect(exitCodeFor(e.code)).toBe(9)
    expect(e.message).toContain('MCP')
    expect(e.details).toMatchObject({ host: { running: true, version: '9.9.9', protocol: HOST_PROTOCOL, mcp: false } })
  })

  it('a Host of another protocol on the profile: VERSION_MISMATCH (9), with its protocol and the same report', async () => {
    const dir = await profile()
    const addr = hostAddress({ profileDir: dir, platform: process.platform, tmpDir: os.tmpdir(), protocol: HOST_PROTOCOL + 1 })
    if (addr.dirToPrepare) await fs.mkdir(addr.dirToPrepare, { recursive: true, mode: 0o700 })
    const other = net.createServer((s) => s.end())
    await new Promise<void>((resolve) => other.listen(addr.address, resolve))
    cleanups.push(async () => {
      await new Promise<void>((resolve) => other.close(() => resolve()))
      if (addr.dirToPrepare) await fs.rm(addr.dirToPrepare, { recursive: true, force: true })
    })
    const e = failed(await run(dir))
    expect(e.code).toBe('VERSION_MISMATCH')
    expect(e.details).toEqual({
      hostProtocol: HOST_PROTOCOL + 1,
      hostAddress: addr.address,
      cliProtocol: HOST_PROTOCOL,
      cliVersion: '1.4.1',
      transport: 'stdio',
      host: { running: false, mcp: false },
      access: 'control',
      tools: TOOLS.length
    })
  })

  it('a settings file it cannot read: access null with a warning, and the exit still follows the Host', async () => {
    const dir = await profile('{ not json')
    await host(dir, { orch: true })
    const r = await run(dir)
    expect(r.ok).toBe(true)
    const body = (r as { body: Record<string, unknown> }).body
    expect(body.access).toBeNull()
    expect(String(body.warning)).toContain('app-settings.json')
  })
})
