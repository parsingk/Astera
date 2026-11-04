import { promises as fs } from 'node:fs'
import path from 'node:path'
import { readTomlObject } from '../core/providers/configWrite'

/** The skills in `dir`: each folder that holds a SKILL.md, by its folder name. */
async function skillsIn(dir: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of entries) {
    try {
      await fs.access(path.join(dir, name, 'SKILL.md'))
    } catch {
      continue
    }
    out.push(name)
  }
  return out
}

/** The plugins `config.toml` has turned on, as `[name, marketplace]`: codex keys each as `<name>@<marketplace>`. */
async function enabledPlugins(configDir: string): Promise<Array<[string, string]>> {
  let plugins: unknown
  try {
    plugins = readTomlObject(await fs.readFile(path.join(configDir, 'config.toml'), 'utf8')).plugins
  } catch {
    return []
  }
  if (typeof plugins !== 'object' || plugins === null) return []
  const out: Array<[string, string]> = []
  for (const [key, entry] of Object.entries(plugins)) {
    if ((entry as { enabled?: unknown } | null)?.enabled !== true) continue
    const at = key.lastIndexOf('@')
    if (at > 0 && at < key.length - 1) out.push([key.slice(0, at), key.slice(at + 1)])
  }
  return out
}

/** The folder codex installed a plugin into. It keeps one version there, so the newest by mtime is the one it uses. */
async function installedFolder(configDir: string, name: string, marketplace: string): Promise<string | null> {
  const base = path.join(configDir, 'plugins', 'cache', marketplace, name)
  let versions: string[]
  try {
    versions = (await fs.readdir(base, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return null
  }
  let newest: { dir: string; mtimeMs: number } | null = null
  for (const version of versions) {
    const dir = path.join(base, version)
    let mtimeMs: number
    try {
      mtimeMs = (await fs.stat(dir)).mtimeMs
    } catch {
      continue // Gone since the listing: codex is replacing the version this very moment.
    }
    if (newest === null || mtimeMs > newest.mtimeMs) newest = { dir, mtimeMs }
  }
  return newest?.dir ?? null
}

/**
 * The skills of one enabled plugin, named as codex names them: `<plugin>:<skill folder>`. The folder codex reads for
 * them is `skills`, unless the plugin's own manifest names another, and then only that one. The commands it converted
 * into skills sit in a folder of their own.
 */
async function pluginSkills(configDir: string, name: string, marketplace: string): Promise<string[]> {
  const dir = await installedFolder(configDir, name, marketplace)
  if (dir === null) return []
  let skillsFolder = 'skills'
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(dir, '.codex-plugin', 'plugin.json'), 'utf8')) as {
      skills?: unknown
    }
    if (typeof manifest.skills === 'string' && manifest.skills !== '') skillsFolder = manifest.skills
  } catch {
    // No manifest, or one that is not JSON: codex falls back to the default folder.
  }
  const folders = [path.join(dir, skillsFolder), path.join(dir, '.codex-plugin', 'migrated-command-skills')]
  const nested = await Promise.all(folders.map((folder) => skillsIn(folder)))
  return nested.flat().map((skill) => `${name}:${skill}`)
}

/**
 * What codex offers after an `@`, besides files: the skills it can be asked for by name.
 *
 * codex takes none of these as a `/` command — it answers `Unrecognized command` — but it does take
 * them as mentions. Measured in this machine's own rollouts, where a past session carries the message
 * `@astera-task`, alongside file mentions written the same way (`@novels/…/episode_2.corr`). So one
 * list serves both: whatever is chosen goes on the line after an `@`.
 *
 * Both places skills live are walked: the person's own folder, and the ones the plugins codex has enabled brought.
 * This runs on every keystroke after an `@`, so it reads one `config.toml` and the folders of the enabled plugins,
 * and nothing else.
 */
export async function listCodexMentions(configDir: string): Promise<string[]> {
  const own = await skillsIn(path.join(configDir, 'skills'))
  const plugins = await enabledPlugins(configDir)
  const nested = await Promise.all(plugins.map(([name, marketplace]) => pluginSkills(configDir, name, marketplace)))
  const fromPlugins = nested.flat()
  return [...new Set([...own, ...fromPlugins])].sort((a, b) => a.localeCompare(b))
}
