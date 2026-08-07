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

/** Whether configDir is the default (ambient, <home>/.claude) account — the same rule as isAmbientDir in providers/descriptor.ts */
export function isDefaultConfigDir(homeDir: string, configDir: string): boolean {
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
 * Imports the default (home) account's settings into an isolated account.
 * settings.json merges by top-level key and mcpServers merges by server name — in both the default account
 * wins, and entries only the target has are kept.
 * .credentials.json is never touched.
 */
export async function syncSettingsFromDefault(
  homeDir: string,
  targetConfigDir: string
): Promise<SyncResult> {
  const result: SyncResult = { settingsApplied: false, mcpApplied: false, contentApplied: [] }

  const srcSettings = await readObjectOrNull(path.join(homeDir, '.claude', 'settings.json'))
  if (srcSettings) {
    const targetFile = path.join(targetConfigDir, 'settings.json')
    const target = (await readObjectOrNull(targetFile)) ?? {}
    await writeJsonBackedUp(targetFile, { ...target, ...srcSettings })
    result.settingsApplied = true
  }

  // The default account's user-scope MCP lives in the home-root sidecar ~/.claude.json — an asymmetry in how
  // claude stores it. In the target .claude.json only the mcpServers key is updated — the rest, oauthAccount
  // and so on, is untouchable.
  const srcRoot = await readObjectOrNull(path.join(homeDir, '.claude.json'))
  const srcMcp = srcRoot && isPlainObject(srcRoot.mcpServers) ? srcRoot.mcpServers : null
  if (srcMcp) {
    const targetFile = path.join(targetConfigDir, '.claude.json')
    const target = (await readObjectOrNull(targetFile)) ?? {}
    const targetMcp = isPlainObject(target.mcpServers) ? target.mcpServers : {}
    await writeJsonBackedUp(targetFile, { ...target, mcpServers: { ...targetMcp, ...srcMcp } })
    result.mcpApplied = true
  }

  // Recursive file-by-file merge of the personal content directories (skills/commands/agents).
  for (const dir of CONTENT_DIRS) {
    const copied = await mergeDirTree(
      path.join(homeDir, '.claude', dir),
      path.join(targetConfigDir, dir)
    )
    if (copied) result.contentApplied.push(dir)
  }

  return result
}
