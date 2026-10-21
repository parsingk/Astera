// Agent Control Plane release 1 (design §4.5, Review Focus 1-4): a session's shared MCP servers resolved once at spawn.
// Values reach only the session environment; an empty registry adds nothing; a running session's generated file is
// never rewritten; servers that cannot be passed are skipped with a reason, never thrown into the spawn.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../testFixtures'
import { writeExtensionRegistry } from './registry'
import { extensionSecrets } from './secrets'
import { resolveSessionCapabilities } from './resolve'
import type { Account } from '../types'
import type { ExtensionRegistry, McpExtension } from './types'
import * as secretsModule from './secrets'

const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) await removeFixture(d)
})
const temp = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-resolve-'))
  dirs.push(d)
  return d
}
const SECRET = 'lin_api_resolve_value_must_not_leak_000'
const server = (over: Partial<McpExtension> = {}): McpExtension => ({
  id: 'mcp-linear', kind: 'mcp', name: 'linear', transport: 'stdio', command: 'npx', args: ['-y', 'linear-mcp'],
  env: { LINEAR_API_KEY: { secret: 'mcp.mcp-linear.LINEAR_API_KEY' }, LOG_LEVEL: { value: 'info' } },
  providers: ['claude', 'codex'], importedFrom: 'acc_1', enabled: true, ...over
})

async function setup(entries: McpExtension[] = [server()]) {
  const home = await temp()
  const profileDir = await temp()
  const registry: ExtensionRegistry = { version: 1, entries }
  if (entries.length) await writeExtensionRegistry(profileDir, registry)
  await extensionSecrets(profileDir).put('mcp.mcp-linear.LINEAR_API_KEY', SECRET)
  const claude: Account = { id: 'acc_2', label: 'b', configDir: path.join(home, '.claude-accounts', 'b'), color: '#888', createdAt: '2026-10-21T00:00:00.000Z', provider: 'claude' }
  const codex: Account = { ...claude, id: 'acc_3', configDir: path.join(home, '.codex-accounts', 'c'), provider: 'codex' }
  return { home, profileDir, claude, codex }
}
const call = (s: Awaited<ReturnType<typeof setup>>, account: Account, platform: NodeJS.Platform = 'linux') =>
  resolveSessionCapabilities({ profileDir: s.profileDir, homeDir: s.home, account, platform, launch: 'terminal' })

describe('resolveSessionCapabilities', () => {
  it('adds nothing when nothing is shared', async () => {
    const s = await setup([])
    const r = await call(s, s.claude)
    expect(r.args).toEqual([])
    expect(r.env).toEqual({})
    expect(r.context).toEqual({ kind: 'implicit', accounts: ['acc_2'], policyMode: 'compatibility', executionMode: 'managed' })
  })

  it('gives Claude a generated --mcp-config of ${NAME} references and the values in the environment only', async () => {
    const s = await setup()
    const r = await call(s, s.claude)
    expect(r.args[0]).toBe('--mcp-config')
    const text = await fs.readFile(r.args[1], 'utf8')
    expect(text).not.toContain(SECRET)
    expect(JSON.parse(text)).toEqual({
      mcpServers: { linear: { command: 'npx', args: ['-y', 'linear-mcp'], env: { LINEAR_API_KEY: '${LINEAR_API_KEY}', LOG_LEVEL: '${LOG_LEVEL}' } } }
    })
    expect(r.env).toEqual({ LINEAR_API_KEY: SECRET, LOG_LEVEL: 'info' })
    expect(r.args.join(' ')).not.toContain(SECRET)
  })

  it('reuses the same generated file for the same set and writes a new one when the set changes', async () => {
    const s = await setup()
    const a = await call(s, s.claude)
    const before = (await fs.stat(a.args[1])).mtimeMs
    const b = await call(s, s.claude)
    expect(b.args[1]).toBe(a.args[1])
    expect((await fs.stat(a.args[1])).mtimeMs).toBe(before)
    await writeExtensionRegistry(s.profileDir, { version: 1, entries: [server({ args: ['-y', 'linear-mcp@2'] })] })
    const c = await call(s, s.claude)
    expect(c.args[1]).not.toBe(a.args[1])
    expect(await fs.readFile(a.args[1], 'utf8')).toContain('linear-mcp"')
  })

  it('gives Codex -c literals with env_vars and no value on the command line', async () => {
    const s = await setup()
    const r = await call(s, s.codex)
    expect(r.args).toEqual([
      '-c', "mcp_servers.linear.command='npx'",
      '-c', "mcp_servers.linear.args=['-y','linear-mcp']",
      '-c', "mcp_servers.linear.env_vars=['LINEAR_API_KEY','LOG_LEVEL']"
    ])
    expect(r.env).toEqual({ LINEAR_API_KEY: SECRET, LOG_LEVEL: 'info' })
  })

  it('skips a server Windows cannot launch with, and keeps the others', async () => {
    const s = await setup([server(), server({ id: 'mcp-pct', name: 'pct', command: 'C:\\tools\\100%\\mcp.exe', env: {} })])
    const r = await call(s, s.codex, 'win32')
    expect(r.skipped).toEqual([{ name: 'pct', reason: 'launch-chars' }])
    expect(r.args.join(' ')).toContain('mcp_servers.linear.command')
  })

  it('skips a server whose secret cannot be read, without throwing', async () => {
    const s = await setup()
    vi.spyOn(secretsModule, 'extensionSecrets').mockReturnValue({
      put: async () => {}, remove: async () => {}, terms: async () => [], get: async () => { throw new Error('ACL changed') }
    })
    const r = await call(s, s.claude)
    expect(r.skipped).toEqual([{ name: 'linear', reason: 'secret-unavailable' }])
    expect(r.args).toEqual([])
  })

  it('skips a server the account already defines itself, for an isolated and the ambient Claude account', async () => {
    const s = await setup()
    await fs.mkdir(s.claude.configDir, { recursive: true })
    await fs.writeFile(path.join(s.claude.configDir, '.claude.json'), JSON.stringify({ mcpServers: { linear: { command: 'mine' } } }))
    expect((await call(s, s.claude)).skipped).toEqual([{ name: 'linear', reason: 'account-own' }])
    const ambient: Account = { ...s.claude, configDir: path.join(s.home, '.claude') }
    await fs.writeFile(path.join(s.home, '.claude.json'), JSON.stringify({ mcpServers: { linear: { command: 'mine' } } }))
    expect((await call(s, ambient)).skipped).toEqual([{ name: 'linear', reason: 'account-own' }])
  })
})
