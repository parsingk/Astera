// What a default account could share (Agent Control Plane release 1 design §4.4): its user-scope MCP servers, skills,
// and for Claude its slash commands and subagents. Names only: an environment value or a header is never read here
// (spec §11.8, discovery reads names; importing is the explicit step that reads a value). Astera's own skills and its
// `astera` MCP registration are never offered, and what is already shared is left out.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isHomeClaudeDir } from '../accounts/settingsSync'
import { providerOf } from '../providers/meta'
import { readTomlObject } from '../providers/configWrite'
import { looksSecret, type NotShareableReason } from './envRules'
import type { Account, Provider } from '../types'
import type { ExtensionKind, ExtensionRegistry, McpOptions } from './types'

export interface DiscoveredMcp {
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  cwd?: string
  url?: string
  envNames: string[]
  options?: McpOptions
}

interface DiscoveredBase {
  kind: ExtensionKind
  name: string
  provider: Provider
  /** The file or folder it was found in. */
  source: string
  mcp?: DiscoveredMcp
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

/** The MCP server names an account's own configuration defines (for the clash rule, design §4.5). A missing file
 *  defines none; one that is there but cannot be read or parsed (the CLI may be writing it) throws, since passing a
 *  shared server then could put it beside the account's own of the same name (final review M7). */
export async function ownMcpNames(account: Account, homeDir: string): Promise<Set<string>> {
  const claude = providerOf(account) === 'claude'
  const file = claude ? claudeMcpFile(account, homeDir) : path.join(account.configDir, 'config.toml')
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
    throw e
  }
  if (text.trim() === '') return new Set()
  const root: unknown = claude ? JSON.parse(text) : readTomlObject(text)
  const servers = isObj(root) ? (claude ? root.mcpServers : root.mcp_servers) : undefined
  return new Set(isObj(servers) ? Object.keys(servers) : [])
}

/** Browser servers (Gateway design G8): one shared process would let two sessions drive one browser, so they start out
 *  with one process per session. The list starts with the well-known ones. */
export function knownSessionIsolated(def: { command?: string; args?: string[] }): boolean {
  return [def.command ?? '', ...(def.args ?? [])].some((t) => /playwright|puppeteer|chrome-devtools/i.test(t))
}

/** Whether a server's arguments or address carry a credential (final review I3): `--api-key <value>`, `--token=<value>`,
 *  a query parameter such as `access_token`, or a password in the address. Shared, it would sit on every Codex
 *  session's command line, in Claude's generated file and in the registry. */
function credentialInLaunch(args: string[] | undefined, url: string | undefined): boolean {
  const a = args ?? []
  for (let i = 0; i < a.length; i++) {
    const joined = /^--?([\w.-]+)=(.+)$/.exec(a[i])
    if (joined && looksSecret(joined[1])) return true
    const flag = /^--?([\w.-]+)$/.exec(a[i])
    if (flag && looksSecret(flag[1]) && i + 1 < a.length && !a[i + 1].startsWith('-')) return true
  }
  if (url !== undefined) {
    try {
      const u = new URL(url)
      if (u.password !== '') return true
      for (const key of u.searchParams.keys()) if (looksSecret(key)) return true
    } catch {
      /* not an address this can read; nothing to find in it */
    }
  }
  return false
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : undefined)

/** Codex's per-server settings that change how a session uses the server (final review M4). */
function optionsOf(def: Obj): McpOptions | undefined {
  const o: McpOptions = {
    ...(num(def.startup_timeout_sec) !== undefined ? { startupTimeoutSec: num(def.startup_timeout_sec) } : {}),
    ...(num(def.tool_timeout_sec) !== undefined ? { toolTimeoutSec: num(def.tool_timeout_sec) } : {}),
    ...(strings(def.enabled_tools) ? { enabledTools: strings(def.enabled_tools) } : {}),
    ...(strings(def.disabled_tools) ? { disabledTools: strings(def.disabled_tools) } : {})
  }
  return Object.keys(o).length > 0 ? o : undefined
}

function mcpOf(def: Obj): { mcp: DiscoveredMcp; headerSecret: boolean; argSecret: boolean } {
  const url = typeof def.url === 'string' ? def.url : undefined
  const http = url !== undefined || def.type === 'http' || def.type === 'sse'
  const options = optionsOf(def)
  const env = isObj(def.env) ? Object.keys(def.env) : []
  const passed = strings(def.env_vars) ?? []
  const headers = [def.headers, def.http_headers, def.env_http_headers].some((h) => isObj(h) && Object.keys(h).length > 0) || typeof def.bearer_token_env_var === 'string'
  return {
    mcp: {
      transport: def.type === 'sse' ? 'sse' : http ? 'http' : 'stdio',
      ...(typeof def.command === 'string' ? { command: def.command } : {}),
      ...(strings(def.args) ? { args: strings(def.args) } : {}),
      ...(typeof def.cwd === 'string' ? { cwd: def.cwd } : {}),
      ...(url !== undefined ? { url } : {}),
      envNames: [...new Set([...env, ...passed])].sort(),
      ...(options ? { options } : {})
    },
    headerSecret: headers,
    argSecret: credentialInLaunch(strings(def.args), url)
  }
}

export async function discoverIn(a: { account: Account; homeDir: string; registry: ExtensionRegistry }): Promise<Discovered[]> {
  const provider = providerOf(a.account)
  const shared = new Set(a.registry.entries.map((e) => `${e.kind}:${e.name}`))
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
      const { mcp, headerSecret, argSecret } = mcpOf(def)
      const reason: NotShareableReason | null = name === 'astera' ? 'astera-own' : headerSecret ? 'header-secret' : argSecret ? 'arg-secret' : null
      add({ kind: 'mcp', name, provider, source: mcpFile, mcp }, reason)
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
      add({ kind, name, provider, source: path.join(dir, e.name) }, kind === 'skill' && name.startsWith('astera-') ? 'astera-own' : null)
    }
  }
  return out
}
