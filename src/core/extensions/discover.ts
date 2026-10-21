// What a default account could share (Agent Control Plane release 1 design §4.4): its user-scope MCP servers, skills,
// and for Claude its slash commands and subagents. Names only: an environment value or a header is never read here
// (spec §11.8, discovery reads names; importing is the explicit step that reads a value). Astera's own skills and its
// `astera` MCP registration are never offered, and what is already shared is left out.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isHomeClaudeDir } from '../accounts/settingsSync'
import { providerOf } from '../providers/meta'
import { readTomlObject } from '../providers/configWrite'
import { envNameRefusal, envNameWarning, type NotShareableReason, type ShareWarning } from './envRules'
import type { Account, Provider } from '../types'
import type { ExtensionKind, ExtensionRegistry } from './types'

export interface DiscoveredMcp {
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  cwd?: string
  url?: string
  envNames: string[]
}

interface DiscoveredBase {
  kind: ExtensionKind
  name: string
  provider: Provider
  /** The file or folder it was found in. */
  source: string
  mcp?: DiscoveredMcp
  warnings: ShareWarning[]
}

export type Discovered = (DiscoveredBase & { shareable: true }) | (DiscoveredBase & { shareable: false; reason: NotShareableReason })

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)
const strings = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined)

const readJson = async (file: string): Promise<Obj | null> => {
  try {
    const v: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
    return isObj(v) ? v : null
  } catch {
    return null
  }
}
const readToml = async (file: string): Promise<Obj | null> => {
  try {
    return readTomlObject(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}
const entries = async (dir: string): Promise<{ name: string; dir: boolean }[]> => {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).map((d) => ({ name: d.name, dir: d.isDirectory() }))
  } catch {
    return []
  }
}

/** The user-scope MCP servers file of a Claude account: <home>/.claude.json for the ambient account. */
export const claudeMcpFile = (account: Account, homeDir: string): string =>
  isHomeClaudeDir(homeDir, account.configDir) ? path.join(homeDir, '.claude.json') : path.join(account.configDir, '.claude.json')

/** The MCP server names an account's own configuration defines (for the clash rule, design §4.5). */
export async function ownMcpNames(account: Account, homeDir: string): Promise<Set<string>> {
  if (providerOf(account) === 'claude') {
    const servers = (await readJson(claudeMcpFile(account, homeDir)))?.mcpServers
    return new Set(isObj(servers) ? Object.keys(servers) : [])
  }
  const servers = (await readToml(path.join(account.configDir, 'config.toml')))?.mcp_servers
  return new Set(isObj(servers) ? Object.keys(servers) : [])
}

function mcpOf(def: Obj): { mcp: DiscoveredMcp; headerSecret: boolean } {
  const url = typeof def.url === 'string' ? def.url : undefined
  const http = url !== undefined || def.type === 'http' || def.type === 'sse'
  const env = isObj(def.env) ? Object.keys(def.env) : []
  const passed = strings(def.env_vars) ?? []
  const headers = [def.headers, def.http_headers, def.env_http_headers].some((h) => isObj(h) && Object.keys(h).length > 0) || typeof def.bearer_token_env_var === 'string'
  return {
    mcp: {
      transport: http ? 'http' : 'stdio',
      ...(typeof def.command === 'string' ? { command: def.command } : {}),
      ...(strings(def.args) ? { args: strings(def.args) } : {}),
      ...(typeof def.cwd === 'string' ? { cwd: def.cwd } : {}),
      ...(url !== undefined ? { url } : {}),
      envNames: [...new Set([...env, ...passed])].sort()
    },
    headerSecret: headers
  }
}

export async function discoverIn(a: { account: Account; homeDir: string; registry: ExtensionRegistry }): Promise<Discovered[]> {
  const provider = providerOf(a.account)
  const shared = new Set(a.registry.entries.map((e) => `${e.kind}:${e.name}`))
  const sharedEnvNames = new Map<string, string>()
  for (const e of a.registry.entries) if (e.kind === 'mcp') for (const n of Object.keys(e.env)) sharedEnvNames.set(n, '')
  const out: Discovered[] = []
  const add = (d: DiscoveredBase, reason: NotShareableReason | null): void => {
    if (shared.has(`${d.kind}:${d.name}`)) return
    out.push(reason ? { ...d, shareable: false, reason } : { ...d, shareable: true })
  }

  const mcpFile = provider === 'claude' ? claudeMcpFile(a.account, a.homeDir) : path.join(a.account.configDir, 'config.toml')
  const servers = provider === 'claude' ? (await readJson(mcpFile))?.mcpServers : (await readToml(mcpFile))?.mcp_servers
  if (isObj(servers)) {
    for (const [name, def] of Object.entries(servers)) {
      if (!isObj(def)) continue
      const { mcp, headerSecret } = mcpOf(def)
      const warnings: ShareWarning[] = []
      let reason: NotShareableReason | null = name === 'astera' ? 'astera-own' : headerSecret ? 'header-secret' : null
      for (const n of mcp.envNames) {
        // Values are unknown here: only the CLI-name rule can refuse; a name another shared server uses is a warning,
        // and the import, which knows the values, refuses it if they differ (Task 4 ruling)
        if (!reason && envNameRefusal(n, '', new Map()) === 'cli-env-name') reason = 'cli-env-name'
        if (envNameWarning(n) && !warnings.includes('session-tools')) warnings.push('session-tools')
        if (sharedEnvNames.has(n) && !warnings.includes('env-name-shared')) warnings.push('env-name-shared')
      }
      add({ kind: 'mcp', name, provider, source: mcpFile, mcp, warnings }, reason)
    }
  }

  const folders: [ExtensionKind, string, boolean][] = [['skill', 'skills', true]]
  if (provider === 'claude') folders.push(['command', 'commands', false], ['agent', 'agents', false])
  for (const [kind, sub, isDir] of folders) {
    const dir = path.join(a.account.configDir, sub)
    for (const e of await entries(dir)) {
      if (isDir !== e.dir) continue
      if (!isDir && !e.name.endsWith('.md')) continue
      const name = isDir ? e.name : e.name.slice(0, -3)
      if (name.startsWith('.')) continue
      add({ kind, name, provider, source: path.join(dir, e.name), warnings: [] }, kind === 'skill' && name.startsWith('astera-') ? 'astera-own' : null)
    }
  }
  return out
}
