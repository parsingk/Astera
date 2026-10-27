// Agent Control Plane (release 1 design §4.5, release 2 Gateway design §4.2): a session's shared MCP servers resolved
// once at spawn. Stdio servers reach the session as Gateway URLs and a token reference, never their values; remote
// servers stay direct; an empty registry adds nothing; a running session's generated file is never rewritten; a server
// that cannot be passed is skipped with a reason, never thrown into the spawn.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../testFixtures'
import { extensionPaths, profilePaths } from '../profile/paths'
import { writeAgentProfiles } from '../agentProfiles/store'
import type { AgentProfile } from '../agentProfiles/types'
import { writeExtensionRegistry } from './registry'
import { extensionSecrets } from './secrets'
import { gatewayTokenEnv, resolveSessionCapabilities, sweepGeneratedMcp } from './resolve'
import type { Account } from '../types'
import type { ExtensionRegistry, McpExtension } from './types'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})
const temp = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-resolve-'))
  dirs.push(d)
  return d
}
const SECRET = 'lin_api_resolve_value_must_not_leak_000'
const PORT = 47123
const server = (over: Partial<McpExtension> = {}): McpExtension => ({
  id: 'mcp-linear', kind: 'mcp', name: 'linear', transport: 'stdio', command: 'npx', args: ['-y', 'linear-mcp'],
  env: { LINEAR_API_KEY: { secret: 'mcp.mcp-linear.LINEAR_API_KEY' }, LOG_LEVEL: { value: 'info' } },
  providers: ['claude', 'codex'], importedFrom: 'acc_1', enabled: true, ...over
})
const remote = (over: Partial<McpExtension> = {}): McpExtension =>
  server({ id: 'mcp-docs', name: 'docs', transport: 'http', command: undefined, args: undefined, url: 'https://mcp.example.com/mcp', env: {}, ...over })

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
type S = Awaited<ReturnType<typeof setup>>
const call = (
  s: S,
  account: Account,
  o: { platform?: NodeJS.Platform; gatewayPort?: number | null; dryRun?: boolean; agentProfileId?: string; log?: (line: string) => void } = {}
) =>
  resolveSessionCapabilities({
    profileDir: s.profileDir, homeDir: s.home, account, platform: o.platform ?? 'linux', gatewayPort: o.gatewayPort === undefined ? PORT : o.gatewayPort,
    ...(o.dryRun ? { dryRun: true } : {}),
    ...(o.agentProfileId !== undefined ? { agentProfileId: o.agentProfileId } : {}),
    ...(o.log ? { log: o.log } : {})
  })
const URL_OF = `http://127.0.0.1:${PORT}/mcp/mcp-linear`

describe('resolveSessionCapabilities', () => {
  it('adds nothing when nothing is shared', async () => {
    const s = await setup([])
    const r = await call(s, s.claude)
    expect(r).toMatchObject({ args: [], env: {}, gatewayGrant: [] })
    expect(r.context).toEqual({ kind: 'implicit', accounts: ['acc_2'], policyMode: 'compatibility', executionMode: 'managed' })
  })

  it('tells a session where the Host listens, shared server or not, and nothing when there is no Host', async () => {
    const none = await setup([])
    expect((await call(none, none.claude)).env).toEqual({ ASTERA_LOOPBACK: `http://127.0.0.1:${PORT}` })
    expect((await call(none, none.claude, { gatewayPort: null })).env).toEqual({})
    const s = await setup()
    expect((await call(s, s.codex)).env).toMatchObject({ ASTERA_LOOPBACK: `http://127.0.0.1:${PORT}` })
  })

  it('gives Claude a stdio server as the Gateway’s URL with a token reference, and no value anywhere', async () => {
    const s = await setup()
    const r = await call(s, s.claude)
    expect(r.args[0]).toBe('--mcp-config')
    const text = await fs.readFile(r.args[1], 'utf8')
    expect(JSON.parse(text)).toEqual({
      mcpServers: { linear: { type: 'http', url: URL_OF, headers: { Authorization: 'Bearer ${ASTERA_GATEWAY_TOKEN}' } } }
    })
    expect(r.env).toEqual({ ASTERA_LOOPBACK: `http://127.0.0.1:${PORT}` })
    expect(r.gatewayGrant).toEqual(['mcp-linear'])
    expect(JSON.stringify([r.args, r.env, text])).not.toContain(SECRET)
    expect(JSON.stringify([r.args, r.env, text])).not.toContain('info')
  })

  it('reuses the generated file for the same set, and writes another when the port changes', async () => {
    const s = await setup()
    const a = await call(s, s.claude)
    const b = await call(s, s.claude)
    expect(b.args[1]).toBe(a.args[1])
    const c = await call(s, s.claude, { gatewayPort: PORT + 1 })
    expect(c.args[1]).not.toBe(a.args[1])
    expect(await fs.readFile(a.args[1], 'utf8')).toContain(String(PORT))
  })

  it('gives Codex the Gateway’s URL with a bearer variable, and the server’s client-side options', async () => {
    const s = await setup([server({ options: { toolTimeoutSec: 120, enabledTools: ['a'] } })])
    const r = await call(s, s.codex)
    expect(r.args).toEqual([
      '-c', `mcp_servers.linear.url='${URL_OF}'`,
      '-c', "mcp_servers.linear.bearer_token_env_var='ASTERA_GATEWAY_TOKEN'",
      '-c', 'mcp_servers.linear.tool_timeout_sec=120',
      '-c', "mcp_servers.linear.enabled_tools=['a']"
    ])
    expect(r.env).toEqual({ ASTERA_LOOPBACK: `http://127.0.0.1:${PORT}` })
  })

  it('gives Codex on Windows a stdio server whose command holds cmd.exe characters, as a URL (G-05)', async () => {
    const s = await setup([server({ command: 'C:\\tools\\100%\\mcp^.exe' })])
    const r = await call(s, s.codex, { platform: 'win32' })
    expect(r.skipped).toEqual([])
    expect(r.args.join(' ')).toContain(URL_OF)
  })

  it('skips stdio servers when there is no Gateway, and never falls back to their values', async () => {
    const s = await setup([server(), remote()])
    const r = await call(s, s.claude, { gatewayPort: null })
    expect(r.skipped).toEqual([{ name: 'linear', reason: 'gateway-unavailable' }])
    expect(r.given).toEqual(['docs'])
    expect(r.env).toEqual({})
  })

  it('gives remote servers directly, as release 1 did, and leaves an SSE server out of Codex', async () => {
    const s = await setup([remote(), remote({ id: 'mcp-events', name: 'events', transport: 'sse', url: 'https://mcp.example.com/sse' })])
    const claude = await call(s, s.claude)
    expect(JSON.parse(await fs.readFile(claude.args[1], 'utf8')).mcpServers).toEqual({
      docs: { type: 'http', url: 'https://mcp.example.com/mcp' },
      events: { type: 'sse', url: 'https://mcp.example.com/sse' }
    })
    expect(claude.gatewayGrant).toEqual([])
    const codex = await call(s, s.codex)
    expect(codex.args).toEqual(['-c', "mcp_servers.docs.url='https://mcp.example.com/mcp'"])
    expect(codex.skipped).toEqual([{ name: 'events', reason: 'transport' }])
  })

  it('skips for Codex a remote address it cannot quote', async () => {
    const s = await setup([remote({ url: "https://mcp.example.com/it's" })])
    expect((await call(s, s.codex)).skipped).toEqual([{ name: 'docs', reason: 'launch-chars' }])
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

  it('passes nothing when the account’s own file cannot be read, rather than risking a clash', async () => {
    const s = await setup()
    await fs.mkdir(s.claude.configDir, { recursive: true })
    await fs.writeFile(path.join(s.claude.configDir, '.claude.json'), '{ half written')
    const r = await call(s, s.claude)
    expect(r.args).toEqual([])
    expect(r.skipped).toEqual([{ name: 'linear', reason: 'account-unreadable' }])
  })

  it('writes no file in a dry run, and says which servers a session would get', async () => {
    const s = await setup()
    const r = await call(s, s.claude, { dryRun: true })
    expect(r.given).toEqual(['linear'])
    expect(r.args).toEqual([])
    expect(await fs.stat(extensionPaths(s.profileDir).generatedMcp).then(() => true, () => false)).toBe(false)
  })

  it('sweeps generated files nobody has used for a long time, and keeps one a session just used', async () => {
    const s = await setup()
    const used = (await call(s, s.claude)).args[1]
    const dir = extensionPaths(s.profileDir).generatedMcp
    const old = path.join(dir, 'claude-0000000000000000.json')
    await fs.writeFile(old, '{}')
    const longAgo = new Date(Date.now() - 40 * 24 * 3600 * 1000)
    await fs.utimes(old, longAgo, longAgo)
    await fs.utimes(used, longAgo, longAgo)
    await call(s, s.claude)
    await sweepGeneratedMcp(s.profileDir, 30 * 24 * 3600 * 1000)
    expect(await fs.stat(old).then(() => true, () => false)).toBe(false)
    expect(await fs.stat(used).then(() => true, () => false)).toBe(true)
  })
})

// Agent Profiles (design §5): a session started from a profile gets the shared servers minus the profile's exclusions,
// and the Gateway grant is built from what is left; without a profile nothing changes (AC-09.4)
describe('resolveSessionCapabilities with an agent profile', () => {
  const profile = (over: Partial<AgentProfile> = {}): AgentProfile => ({
    id: 'ap_000000000001', name: 'Reviewer', status: 'active', accountIds: ['acc_2', 'acc_3'], mcpExclude: ['mcp-linear'],
    permission: 'bypass', createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z', ...over
  })
  const withProfiles = async (profiles: AgentProfile[]) => {
    const s = await setup([server(), remote()])
    await writeAgentProfiles(s.profileDir, { version: 1, profiles })
    return s
  }

  it('drops the excluded server from what a Claude session is given, its Gateway grant and its generated file', async () => {
    const s = await withProfiles([profile()])
    const r = await call(s, s.claude, { agentProfileId: 'ap_000000000001' })
    expect(r.given).toEqual(['docs'])
    expect(r.gatewayGrant).toEqual([])
    expect(r.skipped).toEqual([])
    const text = await fs.readFile(r.args[1], 'utf8')
    expect(JSON.parse(text).mcpServers).toEqual({ docs: { type: 'http', url: 'https://mcp.example.com/mcp' } })
    expect(text).not.toContain(URL_OF)
    expect(r.context).toEqual({
      kind: 'explicit', id: 'ap_000000000001', displayName: 'Reviewer', accounts: ['acc_2'], mcpExclude: ['mcp-linear'],
      permission: 'bypass', policyMode: 'compatibility', executionMode: 'managed'
    })
  })

  it('drops the excluded server from a Codex session’s arguments', async () => {
    const s = await withProfiles([profile()])
    const r = await call(s, s.codex, { agentProfileId: 'ap_000000000001' })
    expect(r.args).toEqual(['-c', "mcp_servers.docs.url='https://mcp.example.com/mcp'"])
    expect(r.args.join(' ')).not.toContain(URL_OF)
    expect(r.gatewayGrant).toEqual([])
    expect(r.given).toEqual(['docs'])
  })

  it('keeps resolving an archived profile, which work already holding it still runs as', async () => {
    const s = await withProfiles([profile({ status: 'archived' })])
    const r = await call(s, s.codex, { agentProfileId: 'ap_000000000001' })
    expect(r.context.kind).toBe('explicit')
    expect(r.given).toEqual(['docs'])
  })

  it('gives a session without a profile exactly what it got before profiles, even with a profile store beside it', async () => {
    const s = await withProfiles([profile({ mcpExclude: ['mcp-linear', 'mcp-docs'] })])
    expect(await call(s, s.codex)).toEqual({
      context: { kind: 'implicit', accounts: ['acc_3'], policyMode: 'compatibility', executionMode: 'managed' },
      args: [
        '-c', `mcp_servers.linear.url='${URL_OF}'`,
        '-c', "mcp_servers.linear.bearer_token_env_var='ASTERA_GATEWAY_TOKEN'",
        '-c', "mcp_servers.docs.url='https://mcp.example.com/mcp'"
      ],
      env: { ASTERA_LOOPBACK: `http://127.0.0.1:${PORT}` },
      given: ['linear', 'docs'],
      gatewayGrant: ['mcp-linear'],
      skipped: []
    })
    expect(await call(s, s.claude)).toEqual({
      context: { kind: 'implicit', accounts: ['acc_2'], policyMode: 'compatibility', executionMode: 'managed' },
      args: ['--mcp-config', expect.stringMatching(/claude-[0-9a-f]{16}\.json$/)],
      env: { ASTERA_LOOPBACK: `http://127.0.0.1:${PORT}` },
      given: ['linear', 'docs'],
      gatewayGrant: ['mcp-linear'],
      skipped: []
    })
  })

  it('falls back to no profile, with one log line, for an id that does not resolve', async () => {
    const s = await withProfiles([profile()])
    const lines: string[] = []
    const r = await call(s, s.codex, { agentProfileId: 'ap_gone', log: (l) => lines.push(l) })
    expect(r.context).toEqual({ kind: 'implicit', accounts: ['acc_3'], policyMode: 'compatibility', executionMode: 'managed' })
    expect(r.given).toEqual(['linear', 'docs'])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('ap_gone')
  })

  it('falls back to no profile, with one log line, when the profile store is damaged', async () => {
    const s = await setup([server(), remote()])
    await fs.writeFile(profilePaths(s.profileDir).agentProfiles, '{ half written')
    const lines: string[] = []
    const r = await call(s, s.codex, { agentProfileId: 'ap_000000000001', log: (l) => lines.push(l) })
    expect(r.context.kind).toBe('implicit')
    expect(r.given).toEqual(['linear', 'docs'])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('ap_000000000001')
  })

  // A hand-edited entry with no exclusion list: the session still gets the shared servers, as for a profile that
  // does not resolve, rather than the whole resolution rejecting and the session getting none
  it('falls back to no profile, with one log line, for a malformed profile entry', async () => {
    const s = await setup([server(), remote()])
    const { mcpExclude: _, ...malformed } = profile()
    await fs.writeFile(profilePaths(s.profileDir).agentProfiles, JSON.stringify({ version: 1, profiles: [malformed] }))
    const lines: string[] = []
    const r = await call(s, s.codex, { agentProfileId: 'ap_000000000001', log: (l) => lines.push(l) })
    expect(r.context.kind).toBe('implicit')
    expect(r.given).toEqual(['linear', 'docs'])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('ap_000000000001')
  })
})

describe('gatewayTokenEnv', () => {
  it('makes a fresh token for every spawn with the same grant, and one with an empty grant when no server goes through the Gateway', async () => {
    const s = await setup()
    const caps = await call(s, s.claude)
    const a = gatewayTokenEnv(caps)
    const b = gatewayTokenEnv(caps)
    expect(a.ASTERA_GATEWAY_GRANT).toBe('mcp-linear')
    expect(b.ASTERA_GATEWAY_GRANT).toBe('mcp-linear')
    expect(a.ASTERA_GATEWAY_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a.ASTERA_GATEWAY_TOKEN).not.toBe(b.ASTERA_GATEWAY_TOKEN)
    // A session with no shared server still gets a token, with an empty grant (sandbox design §7)
    const none = gatewayTokenEnv({ ...caps, gatewayGrant: [] })
    expect(none.ASTERA_GATEWAY_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(none.ASTERA_GATEWAY_GRANT).toBe('')
  })
})
