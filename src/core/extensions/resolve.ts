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
import type { McpExtension, SkipReason } from './types'

export type PolicyMode = 'compatibility' | 'observe' | 'enforce'

/** Who a session runs as, for the Control Plane: release 1 only knows the implicit form, derived from the account. */
export interface ResolvedAgentContext {
  kind: 'implicit'
  accounts: string[]
  policyMode: PolicyMode
  executionMode: 'managed'
}

export type { SkipReason }

export interface SessionCapabilities {
  context: ResolvedAgentContext
  /** Arguments to add to the provider's command line. */
  args: string[]
  /** Variables to add to the provider process's environment. */
  env: Record<string, string>
  /** The servers the session gets. */
  given: string[]
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
  policyMode?: PolicyMode
  /** Works out what a session would get without writing the generated file: for Settings › Extensions' status. */
  dryRun?: boolean
  log?: (line: string) => void
}): Promise<SessionCapabilities> {
  const out: SessionCapabilities = {
    context: { kind: 'implicit', accounts: [a.account.id], policyMode: a.policyMode ?? 'compatibility', executionMode: 'managed' },
    args: [],
    env: {},
    given: [],
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
  let own: Set<string>
  try {
    own = await ownMcpNames(a.account, a.homeDir)
  } catch {
    // Read while the CLI was writing it, most likely: once more, then nothing rather than a clash (final review M7)
    await new Promise((r) => setTimeout(r, 100))
    try {
      own = await ownMcpNames(a.account, a.homeDir)
    } catch (e) {
      a.log?.(`extensions: account ${a.account.id}'s own MCP servers could not be read, so no shared server is passed (${e instanceof Error ? e.message : String(e)})`)
      for (const s of servers) out.skipped.push({ name: s.name, reason: 'account-unreadable' })
      return out
    }
  }
  const secrets = extensionSecrets(a.profileDir)
  const usable: { server: McpExtension; env: Record<string, string> }[] = []
  for (const server of servers) {
    if (!server.providers.includes(provider)) {
      out.skipped.push({ name: server.name, reason: 'provider' })
      continue
    }
    if (provider === 'codex' && server.transport === 'sse') {
      out.skipped.push({ name: server.name, reason: 'transport' })
      continue
    }
    if (own.has(server.name)) {
      out.skipped.push({ name: server.name, reason: 'account-own' })
      continue
    }
    if (provider === 'codex') {
      const texts = [server.command ?? '', ...(server.args ?? []), server.url ?? '', server.cwd ?? '', ...(server.options?.enabledTools ?? []), ...(server.options?.disabledTools ?? [])]
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
  out.given = usable.map((u) => u.server.name)
  if (a.dryRun) return out
  for (const u of usable) Object.assign(out.env, u.env)

  if (provider === 'claude') {
    const mcpServers: Record<string, unknown> = {}
    for (const { server } of usable) {
      const env = Object.fromEntries(Object.keys(server.env).map((n) => [n, `\${${n}}`]))
      mcpServers[server.name] =
        server.transport !== 'stdio'
          ? { type: server.transport, url: server.url }
          : { command: server.command, ...(server.args ? { args: server.args } : {}), ...(server.cwd ? { cwd: server.cwd } : {}), env }
    }
    const text = JSON.stringify({ mcpServers }, null, 2) + '\n'
    const dir = extensionPaths(a.profileDir).generatedMcp
    const file = path.join(dir, `claude-${createHash('sha256').update(text).digest('hex').slice(0, 16)}.json`)
    // Named by content and never rewritten: a running session keeps reading the file it was started with. One in use is
    // touched instead, so the sweep at Host start keeps it (final review M3)
    const now = new Date()
    const exists = await fs.utimes(file, now, now).then(() => true, () => false)
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
    const o = server.options
    if (o?.startupTimeoutSec !== undefined) out.args.push('-c', `${key}.startup_timeout_sec=${o.startupTimeoutSec}`)
    if (o?.toolTimeoutSec !== undefined) out.args.push('-c', `${key}.tool_timeout_sec=${o.toolTimeoutSec}`)
    if (o?.enabledTools) out.args.push('-c', `${key}.enabled_tools=[${o.enabledTools.map(literal).join(',')}]`)
    if (o?.disabledTools) out.args.push('-c', `${key}.disabled_tools=[${o.disabledTools.map(literal).join(',')}]`)
  }
  return out
}

/** Removes the generated Claude MCP files nobody used for `olderThanMs` (final review M3): a new one is written each time
 *  the shared set changes, and a session in use touches its own at every spawn. Never rejects. */
export async function sweepGeneratedMcp(profileDir: string, olderThanMs: number, now: number = Date.now()): Promise<void> {
  const dir = extensionPaths(profileDir).generatedMcp
  const names = await fs.readdir(dir).catch(() => [] as string[])
  for (const n of names) {
    if (!/^claude-[0-9a-f]{16}\.json$/.test(n)) continue
    const file = path.join(dir, n)
    const st = await fs.stat(file).catch(() => null)
    if (st && now - st.mtimeMs > olderThanMs) await fs.rm(file, { force: true }).catch(() => {})
  }
}
