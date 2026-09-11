import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  CODEX_SLASH_COMMANDS,
  frontmatterDescription,
  type SlashCommand
} from '../core/commands/slashCommands'

// What `/` can start, read off disk for one session.
//
// Four places hold them, and all four were confirmed on this machine on 2026-09-11:
//   <configDir>/commands/*.md            a command the person wrote
//   <configDir>/skills/<name>/SKILL.md   a skill the person (or this app) installed
//   <cwd>/.claude/{commands,skills}/…    the same two, belonging to the project
//   an installed plugin's own two        listed by <configDir>/plugins/installed_plugins.json
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
}): Promise<SlashCommand[]> {
  const { configDir, cwd } = opts
  if (opts.kind === 'codex') return [...CODEX_SLASH_COMMANDS]
  const groups = await Promise.all([
    cwd === null ? [] : commandsIn(path.join(cwd, '.claude', 'commands'), 'project'),
    cwd === null ? [] : skillsIn(path.join(cwd, '.claude', 'skills'), 'project'),
    commandsIn(path.join(configDir, 'commands'), 'user'),
    skillsIn(path.join(configDir, 'skills'), 'user'),
    pluginPaths(configDir).then(async (paths) => {
      const nested = await Promise.all(
        paths.flatMap((p) => [
          commandsIn(path.join(p, 'commands'), 'plugin' as const),
          skillsIn(path.join(p, 'skills'), 'plugin' as const)
        ])
      )
      return nested.flat()
    })
  ])
  return groups.flat().sort((a, b) => a.name.localeCompare(b.name))
}
