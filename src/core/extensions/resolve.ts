// The one place a session's shared capabilities are worked out, as it starts (Agent Control Plane release 1 design
// §4.5): the Implicit Agent seam. Every Astera-started Claude or Codex process gets the profile's enabled MCP servers as
// spawn-time flags, never written into the account's own config (D2), and their environment values only in the
// session's environment (D5). An empty registry adds nothing, so a profile that shares nothing starts exactly as it did
// (AC-09.1). A server that cannot be passed is skipped with its reason; nothing here throws into the spawn path.
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { extensionPaths } from '../profile/paths'
import { providerOf } from '../providers/meta'
import { writeThroughTmp } from '../accounts/fileQueue'
import { LAUNCH_FORBIDDEN } from '../sessions/commands'
import { ownMcpNames } from './discover'
import { readExtensionRegistry } from './registry'
import { extensionSecrets } from './secrets'
import type { Account } from '../types'
import type { McpExtension } from './types'

export type PolicyMode = 'compatibility' | 'observe' | 'enforce'

/** Who a session runs as, for the Control Plane: release 1 only knows the implicit form, derived from the account. */
export interface ResolvedAgentContext {
  kind: 'implicit'
  accounts: string[]
  policyMode: PolicyMode
  executionMode: 'managed'
}

export type SkipReason = 'account-own' | 'launch-chars' | 'secret-unavailable' | 'provider'

export interface SessionCapabilities {
  context: ResolvedAgentContext
  /** Arguments to add to the provider's command line. */
  args: string[]
  /** Variables to add to the provider process's environment. */
  env: Record<string, string>
  skipped: { name: string; reason: SkipReason }[]
}

/** TOML literal string: no escapes inside, so a value holding `'` cannot be one. */
const literal = (v: string): string => `'${v}'`
const BARE_KEY = /^[A-Za-z0-9_-]+$/

export async function resolveSessionCapabilities(a: {
  profileDir: string
  homeDir: string
  account: Account
  platform: NodeJS.Platform
  launch: 'terminal' | 'chat'
  policyMode?: PolicyMode
  log?: (line: string) => void
}): Promise<SessionCapabilities> {
  const out: SessionCapabilities = {
    context: { kind: 'implicit', accounts: [a.account.id], policyMode: a.policyMode ?? 'compatibility', executionMode: 'managed' },
    args: [],
    env: {},
    skipped: []
  }
  let servers: McpExtension[]
  try {
    servers = (await readExtensionRegistry(a.profileDir)).entries.filter((e): e is McpExtension => e.kind === 'mcp' && e.enabled)
  } catch (e) {
    a.log?.(`extensions: the registry could not be read, no shared server is passed (${e instanceof Error ? e.message : String(e)})`)
    return out
  }
  if (servers.length === 0) return out
  const provider = providerOf(a.account)
  const own = await ownMcpNames(a.account, a.homeDir).catch(() => new Set<string>())
  const secrets = extensionSecrets(a.profileDir)
  const usable: { server: McpExtension; env: Record<string, string> }[] = []
  for (const server of servers) {
    if (!server.providers.includes(provider)) {
      out.skipped.push({ name: server.name, reason: 'provider' })
      continue
    }
    if (own.has(server.name)) {
      out.skipped.push({ name: server.name, reason: 'account-own' })
      continue
    }
    if (provider === 'codex') {
      const texts = [server.command ?? '', ...(server.args ?? []), server.url ?? '', server.cwd ?? '']
      const blocked = !BARE_KEY.test(server.name) || texts.some((t) => t.includes("'") || (a.platform === 'win32' && LAUNCH_FORBIDDEN.test(t)))
      if (blocked) {
        out.skipped.push({ name: server.name, reason: 'launch-chars' })
        continue
      }
    }
    const env: Record<string, string> = {}
    let unavailable = false
    for (const [name, v] of Object.entries(server.env)) {
      if ('value' in v) env[name] = v.value
      else if ('secret' in v) {
        try {
          const value = await secrets.get(v.secret)
          if (value === null) unavailable = true
          else env[name] = value
        } catch {
          unavailable = true
        }
      }
    }
    if (unavailable) {
      a.log?.(`extensions: the secret of shared server ${server.name} could not be read; it is not passed to this session`)
      out.skipped.push({ name: server.name, reason: 'secret-unavailable' })
      continue
    }
    usable.push({ server, env })
  }
  if (usable.length === 0) return out
  for (const u of usable) Object.assign(out.env, u.env)

  if (provider === 'claude') {
    const mcpServers: Record<string, unknown> = {}
    for (const { server } of usable) {
      const env = Object.fromEntries(Object.keys(server.env).map((n) => [n, `\${${n}}`]))
      mcpServers[server.name] =
        server.transport === 'http'
          ? { type: 'http', url: server.url }
          : { command: server.command, ...(server.args ? { args: server.args } : {}), ...(server.cwd ? { cwd: server.cwd } : {}), env }
    }
    const text = JSON.stringify({ mcpServers }, null, 2) + '\n'
    const dir = extensionPaths(a.profileDir).generatedMcp
    const file = path.join(dir, `claude-${createHash('sha256').update(text).digest('hex').slice(0, 16)}.json`)
    // Named by content and never rewritten: a running session keeps reading the file it was started with
    const exists = await fs.stat(file).then(() => true, () => false)
    if (!exists) {
      await fs.mkdir(dir, { recursive: true })
      await writeThroughTmp(file, text)
    }
    out.args.push('--mcp-config', file)
    return out
  }

  for (const { server } of usable) {
    const key = `mcp_servers.${server.name}`
    if (server.transport === 'http') out.args.push('-c', `${key}.url=${literal(server.url ?? '')}`)
    else {
      out.args.push('-c', `${key}.command=${literal(server.command ?? '')}`)
      if (server.args?.length) out.args.push('-c', `${key}.args=[${server.args.map(literal).join(',')}]`)
      if (server.cwd) out.args.push('-c', `${key}.cwd=${literal(server.cwd)}`)
      const names = Object.keys(server.env)
      if (names.length) out.args.push('-c', `${key}.env_vars=[${names.map(literal).join(',')}]`)
    }
  }
  return out
}
