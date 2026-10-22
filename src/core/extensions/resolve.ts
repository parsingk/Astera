// The one place a session's shared capabilities are worked out, as it starts (Agent Control Plane release 1 design
// §4.5): the Implicit Agent seam. Every Astera-started Claude or Codex process gets the profile's enabled MCP servers as
// spawn-time flags, never written into the account's own config (D2). A stdio server reaches the session through the
// Host's MCP Gateway (release 2 Gateway design §4.2): the session gets its URL and a reference to its own Gateway token,
// and none of the server's values. A remote server is given directly, as in release 1, so its per-account login keeps
// working (G7). An empty registry adds nothing, so a profile that shares nothing starts exactly as it did (AC-09.1). A
// server that cannot be passed is skipped with its reason; nothing here throws into the spawn path.
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { extensionPaths } from '../profile/paths'
import { providerOf } from '../providers/meta'
import { writeThroughTmp } from '../accounts/fileQueue'
import { LAUNCH_FORBIDDEN } from '../sessions/commands'
import { ownMcpNames } from './discover'
import { readExtensionRegistry } from './registry'
import { findProfile, readAgentProfiles } from '../agentProfiles/store'
import type { ProfilePermission } from '../agentProfiles/types'
import type { Account } from '../types'
import type { McpExtension, SkipReason } from './types'

export type PolicyMode = 'compatibility' | 'observe' | 'enforce'

/** Who a session runs as, for the Control Plane: the implicit form is derived from the account alone; the explicit one
 *  is the agent profile it was started from (Agent Profiles design §5), whose exclusions and permission it keeps. */
export type ResolvedAgentContext =
  | { kind: 'implicit'; accounts: string[]; policyMode: PolicyMode; executionMode: 'managed' }
  | {
      kind: 'explicit'
      id: string
      displayName: string
      accounts: string[]
      mcpExclude: string[]
      permission: ProfilePermission
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
  /** The ids of the stdio servers it gets through the Gateway; `gatewayTokenEnv` makes each spawn's token for them. */
  gatewayGrant: string[]
  skipped: { name: string; reason: SkipReason }[]
}

/** TOML literal string: no escapes inside, so a value holding `'` cannot be one. */
const literal = (v: string): string => `'${v}'`
const BARE_KEY = /^[A-Za-z0-9_-]+$/

/** The names Host and sessions agree on (host/gateway/tokens.ts reads them). */
export const GATEWAY_TOKEN_ENV = 'ASTERA_GATEWAY_TOKEN'
export const GATEWAY_GRANT_ENV = 'ASTERA_GATEWAY_GRANT'

export async function resolveSessionCapabilities(a: {
  profileDir: string
  homeDir: string
  account: Account
  platform: NodeJS.Platform
  policyMode?: PolicyMode
  /** The Host's Gateway port, or null when there is none (no Host, an older one, nothing shared over stdio). */
  gatewayPort: number | null
  /** Works out what a session would get without writing the generated file: for Settings › Extensions' status. */
  dryRun?: boolean
  /** The agent profile the session is started from. One that no longer resolves (deleted, store damaged) is logged and
   *  the session starts as it would without one (Agent Profiles design §5). */
  agentProfileId?: string
  log?: (line: string) => void
}): Promise<SessionCapabilities> {
  const out: SessionCapabilities = {
    context: await resolveAgentContext(a),
    args: [],
    env: {},
    given: [],
    gatewayGrant: [],
    skipped: []
  }
  let servers: McpExtension[]
  try {
    servers = (await readExtensionRegistry(a.profileDir)).entries.filter((e): e is McpExtension => e.kind === 'mcp' && e.enabled)
  } catch (e) {
    a.log?.(`extensions: the registry could not be read, no shared server is passed (${e instanceof Error ? e.message : String(e)})`)
    return out
  }
  // A profile's exclusions go first, before any other filter, so an excluded server is in neither the arguments nor
  // the Gateway grant: the Gateway refuses it for this session's token too
  if (out.context.kind === 'explicit') {
    const excluded = new Set(out.context.mcpExclude)
    servers = servers.filter((s) => !excluded.has(s.id))
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
  const usable: McpExtension[] = []
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
    if (server.transport === 'stdio' && a.gatewayPort === null) {
      out.skipped.push({ name: server.name, reason: 'gateway-unavailable' })
      continue
    }
    // Codex reads the server's name as a TOML key and a remote address as a literal, on Windows through cmd.exe
    if (provider === 'codex') {
      const url = server.transport === 'stdio' ? '' : (server.url ?? '')
      const texts = [url, ...(server.options?.enabledTools ?? []), ...(server.options?.disabledTools ?? [])]
      if (!BARE_KEY.test(server.name) || texts.some((t) => t.includes("'") || (a.platform === 'win32' && LAUNCH_FORBIDDEN.test(t)))) {
        out.skipped.push({ name: server.name, reason: 'launch-chars' })
        continue
      }
    }
    usable.push(server)
  }
  if (usable.length === 0) return out
  out.given = usable.map((u) => u.name)
  out.gatewayGrant = usable.filter((u) => u.transport === 'stdio').map((u) => u.id)
  if (a.dryRun) return out
  const gatewayUrl = (u: McpExtension): string => `http://127.0.0.1:${a.gatewayPort}/mcp/${encodeURIComponent(u.id)}`

  if (provider === 'claude') {
    const mcpServers: Record<string, unknown> = {}
    for (const server of usable) {
      mcpServers[server.name] =
        server.transport !== 'stdio'
          ? { type: server.transport, url: server.url }
          : { type: 'http', url: gatewayUrl(server), headers: { Authorization: `Bearer \${${GATEWAY_TOKEN_ENV}}` } }
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

  for (const server of usable) {
    const key = `mcp_servers.${server.name}`
    if (server.transport !== 'stdio') out.args.push('-c', `${key}.url=${literal(server.url ?? '')}`)
    else {
      out.args.push('-c', `${key}.url=${literal(gatewayUrl(server))}`)
      out.args.push('-c', `${key}.bearer_token_env_var=${literal(GATEWAY_TOKEN_ENV)}`)
    }
    const o = server.options
    if (o?.startupTimeoutSec !== undefined) out.args.push('-c', `${key}.startup_timeout_sec=${o.startupTimeoutSec}`)
    if (o?.toolTimeoutSec !== undefined) out.args.push('-c', `${key}.tool_timeout_sec=${o.toolTimeoutSec}`)
    if (o?.enabledTools) out.args.push('-c', `${key}.enabled_tools=[${o.enabledTools.map(literal).join(',')}]`)
    if (o?.disabledTools) out.args.push('-c', `${key}.disabled_tools=[${o.disabledTools.map(literal).join(',')}]`)
  }
  return out
}

/** The session's context: explicit when its profile id resolves (an archived profile still does, for work already
 *  holding it), else implicit with one log line, as the session ran before profiles. Never rejects. */
async function resolveAgentContext(a: {
  profileDir: string
  account: Account
  policyMode?: PolicyMode
  agentProfileId?: string
  log?: (line: string) => void
}): Promise<ResolvedAgentContext> {
  const policyMode = a.policyMode ?? 'compatibility'
  const implicit: ResolvedAgentContext = { kind: 'implicit', accounts: [a.account.id], policyMode, executionMode: 'managed' }
  if (a.agentProfileId === undefined) return implicit
  // Built inside the try too: a hand-edited entry with no exclusion list falls back as a damaged store does, rather
  // than rejecting the whole resolution and leaving the session no shared server
  try {
    const profile = findProfile(await readAgentProfiles(a.profileDir), a.agentProfileId)
    if (profile)
      return {
        kind: 'explicit',
        id: profile.id,
        displayName: profile.name,
        accounts: [a.account.id],
        mcpExclude: [...profile.mcpExclude],
        permission: profile.permission,
        policyMode,
        executionMode: 'managed'
      }
  } catch (e) {
    a.log?.(`extensions: the agent profiles could not be read, so profile ${a.agentProfileId} is not applied (${e instanceof Error ? e.message : String(e)})`)
    return implicit
  }
  a.log?.(`extensions: agent profile ${a.agentProfileId} was not found, so the session starts without one`)
  return implicit
}

/** The variables one spawn adds for the Gateway (design §4.2): a token made for this spawn alone, and the servers it was
 *  given. The Host registers them when it opens the session (host/gateway/tokens.ts). Nothing when no server goes
 *  through the Gateway. */
export function gatewayTokenEnv(caps: Pick<SessionCapabilities, 'gatewayGrant'>): Record<string, string> {
  if (caps.gatewayGrant.length === 0) return {}
  return { [GATEWAY_TOKEN_ENV]: randomBytes(32).toString('base64url'), [GATEWAY_GRANT_ENV]: caps.gatewayGrant.join(',') }
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
