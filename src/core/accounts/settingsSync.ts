import { promises as fs } from 'node:fs'
import path from 'node:path'

type JsonObject = Record<string, unknown>

export interface SyncResult {
  settingsApplied: boolean // whether the default account's settings.json was merged and written
  mcpApplied: boolean // whether the default account's mcpServers was merged and written
  contentApplied: string[] // the names of the personal content directories whose files were copied (skills/commands/agents)
}

// win32 first: ignores differences in path case and separator (the same rule as normalizePath in sessions/manager.ts)
const normalizePath = (p: string): string => path.resolve(p).toLowerCase()

/** Whether configDir is the home (ambient, <home>/.claude) directory — the same rule as isAmbientDir in
 *  providers/descriptor.ts. It is not imported from there because that module imports this one.
 *
 *  This used to decide which account was "the default". It no longer does — the default account is now
 *  derived from registration order (accounts/defaultAccount.ts) and the home dir gets no special status.
 *  The one thing still riding on it is where claude keeps user-scope MCP, which genuinely differs. */
export function isHomeClaudeDir(homeDir: string, configDir: string): boolean {
  return normalizePath(configDir) === normalizePath(path.join(homeDir, '.claude'))
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
  homeDir: string
): Promise<SyncResult> {
  const result: SyncResult = { settingsApplied: false, mcpApplied: false, contentApplied: [] }

  const srcSettings = await readObjectOrNull(path.join(srcConfigDir, 'settings.json'))
  if (srcSettings) {
    const targetFile = path.join(targetConfigDir, 'settings.json')
    const target = (await readObjectOrNull(targetFile)) ?? {}
    await writeJsonBackedUp(targetFile, { ...target, ...srcSettings })
    result.settingsApplied = true
  }

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
 * Unlike claude this **replaces** config.toml rather than merging it. Codex keeps settings and MCP servers
 * together in one TOML file and this project has no TOML parser — adding a dependency to enable key-level
 * merging was not worth it for one button. The existing file is backed up to .bak first, the same as the
 * JSON path, and the write is tmp+rename so a failure cannot leave a half-written config.
 *
 * auth.json (credentials) and sessions/ (history) are never touched.
 */
export async function syncCodexSettings(
  srcConfigDir: string,
  targetConfigDir: string
): Promise<SyncResult> {
  const result: SyncResult = { settingsApplied: false, mcpApplied: false, contentApplied: [] }

  let raw: string
  try {
    raw = await fs.readFile(path.join(srcConfigDir, 'config.toml'), 'utf8')
  } catch {
    return result // the source has no config.toml — nothing to copy, same as an absent settings.json
  }

  const targetFile = path.join(targetConfigDir, 'config.toml')
  await fs.mkdir(targetConfigDir, { recursive: true })
  await fs.copyFile(targetFile, targetFile + '.bak').catch(() => {}) // ignored when the target is absent
  const tmp = targetFile + '.tmp'
  await fs.writeFile(tmp, raw, 'utf8')
  await fs.rename(tmp, targetFile)
  result.settingsApplied = true

  return result
}
