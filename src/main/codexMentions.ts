import { promises as fs } from 'node:fs'
import path from 'node:path'

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

/** Every installed plugin's install path, from the CLI's own record of what is installed. */
async function pluginPaths(configDir: string): Promise<string[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(
      await fs.readFile(path.join(configDir, 'plugins', 'installed_plugins.json'), 'utf8')
    )
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const plugins = (parsed as { plugins?: unknown }).plugins
  if (typeof plugins !== 'object' || plugins === null) return []
  const out: string[] = []
  for (const installs of Object.values(plugins as Record<string, unknown>)) {
    if (!Array.isArray(installs)) continue
    for (const install of installs) {
      if (typeof install !== 'object' || install === null) continue
      const p = (install as { installPath?: unknown }).installPath
      if (typeof p === 'string' && p !== '') out.push(p)
    }
  }
  return out
}

/**
 * What codex offers after an `@`, besides files: the skills it can be asked for by name.
 *
 * codex takes none of these as a `/` command — it answers `Unrecognized command` — but it does take
 * them as mentions. Measured in this machine's own rollouts, where a past session carries the message
 * `@astera-task`, alongside file mentions written the same way (`@novels/…/episode_2.corr`). So one
 * list serves both: whatever is chosen goes on the line after an `@`.
 *
 * Both places skills live are walked: the person's own folder, and the ones a plugin brought.
 */
export async function listCodexMentions(configDir: string): Promise<string[]> {
  const own = await skillsIn(path.join(configDir, 'skills'))
  const fromPlugins = await pluginPaths(configDir).then(async (plugins) => {
    const nested = await Promise.all(plugins.map((p) => skillsIn(path.join(p, 'skills'))))
    return nested.flat()
  })
  return [...new Set([...own, ...fromPlugins])].sort((a, b) => a.localeCompare(b))
}
