// The shared Claude Code plugins a Claude session starts with (design §5.5): one `--plugin-dir` for each enabled entry's
// versioned folder, followed by one for each of its dependencies, since an owner whose dependency has no flag of its own
// does not load at all (M9). Worked out at every spawn by resolveSessionCapabilities; it only reads the store and stats
// folders, writes nothing, and never throws into the spawn path.
import { promises as fs } from 'node:fs'
import { readClaudePlugins } from './store'

/** Why a shared plugin is not given to a session: its folder (or a dependency's) is gone, or the store cannot be read. */
export type ClaudePluginSkip = 'plugin-missing' | 'plugin-store-unreadable'

const isFolder = (p: string): Promise<boolean> => fs.stat(p).then((s) => s.isDirectory(), () => false)

/** The arguments, in store order and each folder once; `given` names the plugins passed, dependencies aside (they show
 *  under the plugin that brought them). A store that cannot be read, or holds an entry of another shape, gives nothing
 *  and one skip named `*`, with a log line. */
export async function claudePluginArgs(a: {
  profileDir: string
  /** Test seam; defaults to "is a folder". */
  exists?: (p: string) => Promise<boolean>
  log?: (l: string) => void
}): Promise<{ args: string[]; given: string[]; skipped: { name: string; reason: ClaudePluginSkip }[] }> {
  const exists = a.exists ?? isFolder
  // Built inside the try too: a hand-edited entry falls back as a damaged store does, rather than throwing into a spawn
  try {
    // Read only: a damaged store's copy is kept by the Host's own reading, never by a spawn
    const store = await readClaudePlugins(a.profileDir, { keepDamaged: false })
    const passed = new Set<string>()
    const args: string[] = []
    const given: string[] = []
    const skipped: { name: string; reason: ClaudePluginSkip }[] = []
    for (const plugin of store.plugins) {
      if (!plugin.enabled) continue
      const folders = [plugin.installPath, ...plugin.dependencies.map((d) => d.installPath)]
      if ((await Promise.all(folders.map(exists))).includes(false)) {
        skipped.push({ name: plugin.name, reason: 'plugin-missing' })
        continue
      }
      for (const f of folders) {
        if (passed.has(f)) continue
        passed.add(f)
        args.push('--plugin-dir', f)
      }
      given.push(plugin.name)
    }
    return { args, given, skipped }
  } catch (e) {
    a.log?.(`extensions: the shared Claude plugins could not be read, so none is passed (${e instanceof Error ? e.message : String(e)})`)
    return { args: [], given: [], skipped: [{ name: '*', reason: 'plugin-store-unreadable' }] }
  }
}
