import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  CODEX_SLASH_COMMANDS,
  frontmatterDescription,
  type SlashCommand
} from '../core/commands/slashCommands'
import { readClaudePlugins } from '../core/extensions/claudePlugins/store'

// What `/` can start, read off disk for one session.
//
// Four places hold them, and all four were confirmed on this machine on 2026-09-11:
//   <configDir>/commands/*.md            a command the person wrote
//   <configDir>/skills/<name>/SKILL.md   a skill the person (or this app) installed
//   <cwd>/.claude/{commands,skills}/…    the same two, belonging to the project
//   an installed plugin's own two        listed by <configDir>/plugins/installed_plugins.json
//   a shared plugin's own two            handed in by the caller; the session loads it with --plugin-dir, which
//                                        replaces the account's own copy of the same name
//
// The CLI's built-ins (/model, /status, /clear …) are NOT here, and deliberately: nothing on disk
// describes them, so the only way to list them would be to hand-keep a copy that goes quietly wrong
// the first time the CLI changes. A name that is not in this menu still runs when it is typed in
// full — the menu narrows what you can see, never what you can send.

/** A file whose name ends in `.disabled` is one the person switched off; the CLI skips it and so does
 *  this. */
const isCommandFile = (name: string): boolean => name.endsWith('.md')

async function readDescription(file: string): Promise<string> {
  try {
    // Only the frontmatter is wanted, and a skill body can run to tens of kilobytes.
    const handle = await fs.open(file, 'r')
    try {
      const buf = Buffer.alloc(2048)
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
      return frontmatterDescription(buf.subarray(0, bytesRead).toString('utf8'))
    } finally {
      await handle.close()
    }
  } catch {
    return ''
  }
}

async function commandsIn(dir: string, source: SlashCommand['source']): Promise<SlashCommand[]> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const out: SlashCommand[] = []
  for (const name of names) {
    if (!isCommandFile(name)) continue
    out.push({
      name: name.slice(0, -'.md'.length),
      description: await readDescription(path.join(dir, name)),
      source
    })
  }
  return out
}

async function skillsIn(dir: string, source: SlashCommand['source']): Promise<SlashCommand[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }
  const out: SlashCommand[] = []
  for (const name of entries) {
    const file = path.join(dir, name, 'SKILL.md')
    try {
      await fs.access(file)
    } catch {
      continue
    }
    out.push({ name, description: await readDescription(file), source })
  }
  return out
}

/** Every installed plugin, from the CLI's own record of what is installed: its name (the part of the key before the `@`)
 *  and its install path. */
async function pluginPaths(configDir: string): Promise<{ name: string; installPath: string }[]> {
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
  const out: { name: string; installPath: string }[] = []
  for (const [key, installs] of Object.entries(plugins as Record<string, unknown>)) {
    if (!Array.isArray(installs)) continue
    const at = key.lastIndexOf('@')
    const name = at > 0 ? key.slice(0, at) : key
    for (const install of installs) {
      if (typeof install !== 'object' || install === null) continue
      const p = (install as { installPath?: unknown }).installPath
      if (typeof p === 'string' && p !== '') out.push({ name, installPath: p })
    }
  }
  return out
}

const isFolder = (p: string): Promise<boolean> => fs.stat(p).then((s) => s.isDirectory(), () => false)

/** The shared Claude plugins a session of this profile loads, as the `/` menu needs them: each enabled store entry, then
 *  its dependencies (the session gives each its own `--plugin-dir`), named by the part of the id before the `@`, each
 *  folder once. An entry with a folder gone, its own or a dependency's, is left out as the spawn leaves it out
 *  (core/extensions/claudePlugins/spawnArgs.ts). A store that cannot be read gives none, and nothing is written. */
export async function sharedPluginsForMenu(profileDir: string): Promise<{ name: string; installPath: string }[]> {
  try {
    const store = await readClaudePlugins(profileDir, { keepDamaged: false })
    const out: { name: string; installPath: string }[] = []
    const seen = new Set<string>()
    for (const plugin of store.plugins) {
      if (!plugin.enabled) continue
      const parts = [
        { name: plugin.name, installPath: plugin.installPath },
        ...plugin.dependencies.map((d) => {
          const at = d.id.lastIndexOf('@')
          return { name: at > 0 ? d.id.slice(0, at) : d.id, installPath: d.installPath }
        })
      ]
      if ((await Promise.all(parts.map((p) => isFolder(p.installPath)))).includes(false)) continue
      for (const p of parts) {
        if (seen.has(p.installPath)) continue
        seen.add(p.installPath)
        out.push(p)
      }
    }
    return out
  } catch {
    return []
  }
}

/** Everything `/` offers for one session, in the order the menu shows it: the project's own first,
 *  then the person's, then what plugins brought. A name that appears twice keeps both rows — they are
 *  different things, and hiding one would make the menu lie about what is installed. */
export async function listSlashCommands(opts: {
  configDir: string
  cwd: string | null
  /** Which agent is asking. codex takes none of what is on disk as a command — it answers
   *  `Unrecognized command` for the skills in its own folder — so it gets its own list instead
   *  (core/commands/slashCommands.ts). Measured, not assumed. */
  kind?: 'claude' | 'codex'
  /** The shared Claude plugins the session is started with. Their commands and skills are listed, and an account plugin
   *  of the same name is dropped: `--plugin-dir` replaces it, so the session no longer has its rows. */
  shared?: { name: string; installPath: string }[]
}): Promise<SlashCommand[]> {
  const { configDir, cwd } = opts
  const shared = opts.shared ?? []
  if (opts.kind === 'codex') return [...CODEX_SLASH_COMMANDS]
  const groups = await Promise.all([
    cwd === null ? [] : commandsIn(path.join(cwd, '.claude', 'commands'), 'project'),
    cwd === null ? [] : skillsIn(path.join(cwd, '.claude', 'skills'), 'project'),
    commandsIn(path.join(configDir, 'commands'), 'user'),
    skillsIn(path.join(configDir, 'skills'), 'user'),
    pluginPaths(configDir).then(async (own) => {
      const taken = new Set(shared.map((s) => s.name))
      const nested = await Promise.all(
        [...own.filter((p) => !taken.has(p.name)), ...shared].flatMap((p) => [
          commandsIn(path.join(p.installPath, 'commands'), 'plugin' as const),
          skillsIn(path.join(p.installPath, 'skills'), 'plugin' as const)
        ])
      )
      return nested.flat()
    })
  ])
  return groups.flat().sort((a, b) => a.name.localeCompare(b.name))
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
  const own = await skillsIn(path.join(configDir, 'skills'), 'user')
  const fromPlugins = await pluginPaths(configDir).then(async (plugins) => {
    const nested = await Promise.all(plugins.map((p) => skillsIn(path.join(p.installPath, 'skills'), 'plugin')))
    return nested.flat()
  })
  const names = [...own, ...fromPlugins].map((c) => c.name)
  return [...new Set(names)].sort((a, b) => a.localeCompare(b))
}
