import { promises as fs } from 'node:fs'
import path from 'node:path'
import { comparablePath } from '../files/tree'
import { patchTomlFile, readTomlObject } from '../providers/configWrite'

type JsonObject = Record<string, unknown>

export interface SyncResult {
  settingsApplied: boolean // whether the default account's settings.json was merged and written
  mcpApplied: boolean // whether the default account's mcpServers was merged and written
  contentApplied: string[] // the names of the personal content directories whose files were copied (skills/commands/agents)
}

/** `capabilities`: whether MCP servers, skills, commands and agents are copied too. Off once anything is shared in
 *  Settings › Extensions, which then gives them to every account itself (Agent Control Plane release 1 design §4.7, D9). */
export interface SyncOptions {
  capabilities: boolean
}

// Paths compare through comparablePath (core/files/tree.ts): case folded on win32 and darwin, exact on linux.

/** Whether configDir is the home (ambient, <home>/.claude) directory — the same rule as isAmbientDir in
 *  providers/descriptor.ts. It is not imported from there because that module imports this one.
 *
 *  This used to decide which account was "the default". It no longer does — the default account is now
 *  derived from registration order (accounts/defaultAccount.ts) and the home dir gets no special status.
 *  The one thing still riding on it is where claude keeps user-scope MCP, which genuinely differs. */
export function isHomeClaudeDir(homeDir: string, configDir: string): boolean {
  return comparablePath(configDir) === comparablePath(path.join(homeDir, '.claude'))
}

function isPlainObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Reads a JSON object file — absent, corrupt or not an object gives null (skip that part when it is the source, treat it as {} when it is the target) */
async function readObjectOrNull(file: string): Promise<JsonObject | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Backs the existing file up to .bak (best-effort, the corrupt-copy preservation pattern from registry.ts), then writes atomically with tmp+rename */
async function writeJsonBackedUp(file: string, data: JsonObject): Promise<void> {
  await fs.copyFile(file, file + '.bak').catch(() => {}) // ignored when the target is absent
  const tmp = file + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

/** The default account's personal content directories — directly below <configDir> under the same names, symmetric with an isolated account */
const CONTENT_DIRS = ['skills', 'commands', 'agents'] as const

/**
 * Recursively merges the source directory tree into the target, file by file.
 * A source file overwrites the same path in the target, and files only the target has are preserved (fs.cp
 * force+recursive).
 * If the source is missing or is not a directory, it does nothing and returns false. true when it copied.
 */
async function mergeDirTree(srcDir: string, destDir: string): Promise<boolean> {
  let stat
  try {
    stat = await fs.stat(srcDir)
  } catch {
    return false // source absent → skip
  }
  if (!stat.isDirectory()) return false
  await fs.cp(srcDir, destDir, { recursive: true, force: true })
  return true
}

/**
 * Copies one claude account's settings into another.
 * settings.json merges by top-level key and mcpServers merges by server name — in both the source wins,
 * and entries only the target has are kept.
 * .credentials.json is never touched.
 *
 * The source used to be hardcoded to the home directory. It is now whichever account is that provider's
 * default (accounts/defaultAccount.ts), so the source can be an isolated account too.
 */
export async function syncClaudeSettings(
  srcConfigDir: string,
  targetConfigDir: string,
  homeDir: string,
  opts: SyncOptions
): Promise<SyncResult> {
  const result: SyncResult = { settingsApplied: false, mcpApplied: false, contentApplied: [] }

  const srcSettings = await readObjectOrNull(path.join(srcConfigDir, 'settings.json'))
  if (srcSettings) {
    const targetFile = path.join(targetConfigDir, 'settings.json')
    const target = (await readObjectOrNull(targetFile)) ?? {}
    await writeJsonBackedUp(targetFile, { ...target, ...srcSettings })
    result.settingsApplied = true
  }
  if (!opts.capabilities) return result

  // User-scope MCP sits in a different file depending on which kind of account holds it: the home account
  // keeps it in the home-root sidecar ~/.claude.json, an isolated account inside its own configDir. That
  // asymmetry is claude's, not ours. Reading the wrong one silently imports no MCP at all, so the source
  // kind has to be checked — the old code could skip this because the source was always the home account.
  const srcMcpFile = isHomeClaudeDir(homeDir, srcConfigDir)
    ? path.join(homeDir, '.claude.json')
    : path.join(srcConfigDir, '.claude.json')
  const srcRoot = await readObjectOrNull(srcMcpFile)
  const srcMcp = srcRoot && isPlainObject(srcRoot.mcpServers) ? srcRoot.mcpServers : null
  if (srcMcp) {
    // In the target .claude.json only the mcpServers key is updated — the rest, oauthAccount and so on,
    // is untouchable. The target is always an isolated account, so no sidecar branch is needed here.
    const targetFile = path.join(targetConfigDir, '.claude.json')
    const target = (await readObjectOrNull(targetFile)) ?? {}
    const targetMcp = isPlainObject(target.mcpServers) ? target.mcpServers : {}
    await writeJsonBackedUp(targetFile, { ...target, mcpServers: { ...targetMcp, ...srcMcp } })
    result.mcpApplied = true
  }

  // Recursive file-by-file merge of the personal content directories (skills/commands/agents).
  for (const dir of CONTENT_DIRS) {
    const copied = await mergeDirTree(
      path.join(srcConfigDir, dir),
      path.join(targetConfigDir, dir)
    )
    if (copied) result.contentApplied.push(dir)
  }

  return result
}

/**
 * Copies one codex account's config into another.
 *
 * config.toml is **merged** key by key, in place, so the target keeps its comments and the order of its tables
 * (configWrite.ts). The source's keys win, except two that belong to the target account alone: `projects`, the
 * folders it trusts, and `hooks.state`, the hooks it approved. With `capabilities` off the target's `mcp_servers` is
 * kept too; with it on the servers merge by name, as Claude's do. The existing file is backed up to .bak first, and a
 * file that does not parse is refused, never overwritten. This used to replace the whole file, because there was no
 * TOML parser here.
 *
 * auth.json (credentials) and sessions/ (history) are never touched.
 */
export async function syncCodexSettings(srcConfigDir: string, targetConfigDir: string, opts: SyncOptions): Promise<SyncResult> {
  const result: SyncResult = { settingsApplied: false, mcpApplied: false, contentApplied: [] }

  let raw: string
  try {
    raw = await fs.readFile(path.join(srcConfigDir, 'config.toml'), 'utf8')
  } catch {
    return result // the source has no config.toml — nothing to copy, same as an absent settings.json
  }
  const source = readTomlObject(raw)

  await fs.mkdir(targetConfigDir, { recursive: true })
  await patchTomlFile(path.join(targetConfigDir, 'config.toml'), (current) => {
    const next: JsonObject = { ...current, ...source }
    const keep = (key: string): void => {
      if (key in current) next[key] = current[key]
      else delete next[key]
    }
    keep('projects')
    const targetHooks = isPlainObject(current.hooks) ? current.hooks : null
    if (isPlainObject(next.hooks)) {
      const hooks: JsonObject = { ...next.hooks }
      if (targetHooks && 'state' in targetHooks) hooks.state = targetHooks.state
      else delete hooks.state
      next.hooks = hooks
    }
    if (!opts.capabilities) keep('mcp_servers')
    else if (isPlainObject(current.mcp_servers) && isPlainObject(source.mcp_servers))
      next.mcp_servers = { ...current.mcp_servers, ...source.mcp_servers }
    return next
  })
  result.settingsApplied = true

  return result
}
