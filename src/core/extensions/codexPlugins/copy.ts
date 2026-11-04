// The Codex copy of each shared plugin and the one marketplace file that lists them (Codex plugin sharing design §5.1,
// §5.2). Codex installs a plugin from a marketplace folder, not from the Claude copy where Astera keeps it, so Astera
// keeps a converted copy of each plugin under `extensions/codex-plugins` and every Codex account adds that one folder as
// a local marketplace. The conversion is only what Codex needs and measured to lack: the shared version in the manifest
// Codex reads (C22), `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` filled in where Codex does not expand them
// (C17), and hooks wrapped the way Codex loads them (C25). The Claude copy is only read.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { writeThroughTmp } from '../../accounts/fileQueue'
import { extensionPaths } from '../../profile/paths'
import { renameRetrying } from '../../renameRetry'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

/** The marketplace of a profile: its folder's base name as a slug, then `-shared`, so a dev profile's marketplace is
 *  never the installed profile's (`astera` gives `astera-shared`, `astera-dev` gives `astera-dev-shared`). A base name
 *  with no letter or digit in it gives `astera-shared`. Split on both separators, so a Windows path is read the same on
 *  every platform. */
export function codexMarketplaceName(profileDir: string): string {
  const base = profileDir.split(/[\\/]/).filter((s) => s !== '').pop() ?? ''
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `${slug === '' ? 'astera' : slug}-shared`
}

/** Text as one folder name (plan ruling P5): every character outside `[A-Za-z0-9._-]` becomes `_`, and a result that is
 *  empty or only dots becomes `_` as many times as it was long, at least once: `.` and `..` would name the folder a copy
 *  sits in or its parent, and a copy is removed whole before it is replaced. */
function folderSegment(text: string): string {
  const segment = text.replace(/[^A-Za-z0-9._-]/gu, '_')
  return /^\.*$/.test(segment) ? '_'.repeat(Math.max(segment.length, 1)) : segment
}

/** A version as a folder name (P5). */
export function versionSegment(version: string): string {
  return folderSegment(version)
}

/** Where the Codex copy of `name` at `version` lives, always two folders below `<codexPluginHome>/plugins` whatever the
 *  name and the version hold. The marketplace file names the same place, relative to its folder. */
export function codexCopyFolder(profileDir: string, name: string, version: string): string {
  return path.join(extensionPaths(profileDir).codexPluginHome, 'plugins', folderSegment(name), versionSegment(version))
}

/** Whether a marketplace source is an Astera one, of this profile or another: a folder ending in
 *  `extensions/codex-plugins`, with either separator, a trailing one, or the `\\?\` prefix Codex records on Windows. */
export function isAsteraCodexMarketplace(source: string): boolean {
  const parts = source.split(/[\\/]+/).filter((s) => s !== '')
  return parts.length >= 2 && parts[parts.length - 2] === 'extensions' && parts[parts.length - 1] === 'codex-plugins'
}

/** One pass over the text, with a function as the replacement, so a folder name that holds `$&` is written as it is. */
const fill = (text: string, root: string, data: string): string =>
  text.replace(/\$\{CLAUDE_PLUGIN_(ROOT|DATA)\}/g, (_match, which: string) => (which === 'ROOT' ? root : data))

const fillIf = (v: unknown, root: string, data: string): unknown => (typeof v === 'string' ? fill(v, root, data) : v)

/** A server with the variables filled in its `command`, each of its `args`, each `env` value and its `cwd`. Anything
 *  else about it, and a server with no variable or only a `url`, comes back as it was. */
function codexServer(server: unknown, root: string, data: string): unknown {
  if (!isObj(server)) return server
  const out: Obj = { ...server }
  if (typeof out.command === 'string') out.command = fill(out.command, root, data)
  if (Array.isArray(out.args)) out.args = out.args.map((a) => fillIf(a, root, data))
  if (isObj(out.env)) out.env = Object.fromEntries(Object.entries(out.env).map(([k, v]) => [k, fillIf(v, root, data)]))
  if (typeof out.cwd === 'string') out.cwd = fill(out.cwd, root, data)
  return out
}

const codexServers = (servers: Obj, root: string, data: string): Obj =>
  Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, codexServer(server, root, data)]))

/** The MCP servers of a plugin for Codex, which expands neither variable and starts a server in the session's folder
 *  (C17): `${CLAUDE_PLUGIN_ROOT}` becomes `root`, the Codex copy's own folder, and `${CLAUDE_PLUGIN_DATA}` becomes
 *  `data`. `.mcp.json` holds `{ mcpServers: {...} }` or is the servers map itself, and Codex reads both (C23), so each
 *  keeps its form. Pure: what it was given is not changed. */
export function codexMcpConfig(config: unknown, root: string, data: string): unknown {
  if (!isObj(config)) return config
  if (isObj(config.mcpServers)) return { ...config, mcpServers: codexServers(config.mcpServers, root, data) }
  return codexServers(config, root, data)
}

/** A JSON file of the copy that holds an object; undefined when it is not there. A file that is damaged is an error that
 *  names it, since Codex would not read it either. */
async function readJsonObject(dir: string, rel: string): Promise<Obj | undefined> {
  let text: string
  try {
    text = await fs.readFile(path.join(dir, rel), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`${rel} is not valid JSON: ${(err as Error).message}`)
  }
  if (!isObj(parsed)) throw new Error(`${rel} does not hold a JSON object`)
  return parsed
}

const writeJson = (dir: string, rel: string, value: unknown): Promise<void> =>
  fs.writeFile(path.join(dir, rel), JSON.stringify(value, null, 2) + '\n', 'utf8')

const namesData = (config: unknown): boolean => JSON.stringify(config).includes('${CLAUDE_PLUGIN_DATA}')

/** Makes the folder `dir`, a plain copy of a Claude copy, the Codex copy that will live at `root`. Answers whether an MCP
 *  config of the plugin names `${CLAUDE_PLUGIN_DATA}`, read before it was filled in: only then does the plugin need its
 *  data folder. */
async function convert(dir: string, root: string, a: { name: string; version: string; dataDir: string }): Promise<boolean> {
  const mcp = await readJsonObject(dir, '.mcp.json')
  let usesData = mcp !== undefined && namesData(mcp)
  if (mcp !== undefined) await writeJson(dir, '.mcp.json', codexMcpConfig(mcp, root, a.dataDir))

  // Codex reads `.codex-plugin/plugin.json` when the plugin has one, and then never the Claude manifest (C22). A Codex
  // manifest is the author's own, so nothing but its version changes (P2).
  const codexManifest = '.codex-plugin/plugin.json'
  const own = await readJsonObject(dir, codexManifest)
  if (own !== undefined) {
    await writeJson(dir, codexManifest, { ...own, version: a.version })
    return usesData
  }

  const claudeManifest = '.claude-plugin/plugin.json'
  const manifest: Obj = (await readJsonObject(dir, claudeManifest)) ?? { name: a.name }
  const next: Obj = { ...manifest, version: a.version }
  // Servers declared in the manifest itself are read by Codex and start the same way (C23)
  if (isObj(manifest.mcpServers)) {
    usesData ||= namesData(manifest.mcpServers)
    next.mcpServers = codexMcpConfig(manifest.mcpServers, root, a.dataDir)
  }
  // Codex loads manifest hooks only as `{ hooks: {...} }`; an unwrapped object loads nothing (C25). A path is left alone.
  if (isObj(manifest.hooks) && !isObj(manifest.hooks.hooks)) next.hooks = { hooks: manifest.hooks }
  await fs.mkdir(path.join(dir, '.claude-plugin'), { recursive: true })
  await writeJson(dir, claudeManifest, next)
  return usesData
}

/** Makes the Codex copy of the plugin at `from` (its Claude copy) at `to`, replacing any copy there whole. It is built
 *  beside `to` and swapped in, so a plugin that cannot be converted leaves the old copy as it was. `dataDir` is the
 *  plugin's data folder, made when an MCP config of the plugin names it (Codex does not make it) and never cleared: it
 *  outlives every version. */
export async function writeCodexCopy(a: { from: string; to: string; name: string; version: string; dataDir: string }): Promise<void> {
  const tmp = `${a.to}.${process.pid}.tmp`
  // A leftover of an earlier run that had this process id would be merged into the new copy
  await fs.rm(tmp, { recursive: true, force: true })
  await fs.mkdir(path.dirname(a.to), { recursive: true })
  try {
    await fs.cp(a.from, tmp, { recursive: true, verbatimSymlinks: true })
    if (await convert(tmp, a.to, a)) await fs.mkdir(a.dataDir, { recursive: true })
    await fs.rm(a.to, { recursive: true, force: true })
    await renameRetrying(tmp, a.to)
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

/** Writes the marketplace file that lists every Codex copy, each at the folder `codexCopyFolder` names, as a path
 *  relative to the marketplace folder. Always a slash, since Codex reads it on every platform. */
export async function writeCodexMarketplace(profileDir: string, plugins: { name: string; version: string }[]): Promise<void> {
  const file = path.join(extensionPaths(profileDir).codexPluginHome, '.agents', 'plugins', 'marketplace.json')
  await fs.mkdir(path.dirname(file), { recursive: true })
  const marketplace = {
    name: codexMarketplaceName(profileDir),
    interface: { displayName: 'Astera shared' },
    plugins: plugins.map((p) => ({
      name: p.name,
      source: { source: 'local', path: `./plugins/${folderSegment(p.name)}/${versionSegment(p.version)}` },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Productivity'
    }))
  }
  await writeThroughTmp(file, JSON.stringify(marketplace, null, 2) + '\n')
}
