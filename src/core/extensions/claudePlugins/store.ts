// Reading and writing the store of shared Claude Code plugins, the way registry.ts does the extension registry: the Host
// writes it, the app and the CLI read it, and a file that is there but cannot be read or parsed is kept aside and
// reported, never taken for "nothing shared": the next write would otherwise erase what the person set up.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { extensionPaths } from '../../profile/paths'
import { keepDamaged, readStoreFile } from '../../storeFile'
import { oneAtATime, writeThroughTmp } from '../../accounts/fileQueue'
import { RepairNeeded } from '../../settings/repairNeeded'
import type { ClaudePluginStore } from './types'

const FILE = path.join('extensions', 'claude-plugins.json')

const empty = (): ClaudePluginStore => ({ version: 1, plugins: [] })

/** The profile's shared plugins; empty when there is no store. Throws RepairNeeded when the file is damaged or unreadable,
 *  keeping a copy of the damage beside it unless `keepDamaged` is false: a reader that only asks a question writes
 *  nothing and leaves the copy to the Host's own reading. */
export async function readClaudePlugins(profileDir: string, o: { keepDamaged?: boolean } = {}): Promise<ClaudePluginStore> {
  const file = extensionPaths(profileDir).claudePlugins
  const read = await readStoreFile(file)
  if (read.kind === 'missing') return empty()
  if (read.kind === 'unreadable') throw new RepairNeeded(`${FILE} could not be read (${String(read.error)})`, FILE)
  let parsed: unknown
  try {
    parsed = JSON.parse(read.text)
  } catch {
    parsed = null
  }
  const s = parsed as ClaudePluginStore | null
  if (!s || s.version !== 1 || !Array.isArray(s.plugins)) {
    if (o.keepDamaged === false) throw new RepairNeeded(`${FILE} is damaged`, FILE)
    await keepDamaged(file, read.text)
    throw new RepairNeeded(`${FILE} is damaged; a copy was kept beside it`, FILE)
  }
  return s
}

/** Reads the store, hands it to `fn`, and writes what `fn` returns atomically. One change at a time per store in this
 *  process, so two updates never read the same store and the later write drops the earlier entry. Nothing is written
 *  when the store cannot be read or `fn` throws. Resolves to the store as written. */
export async function updateClaudePlugins(
  profileDir: string,
  fn: (s: ClaudePluginStore) => ClaudePluginStore | Promise<ClaudePluginStore>
): Promise<ClaudePluginStore> {
  const file = extensionPaths(profileDir).claudePlugins
  let written: ClaudePluginStore | undefined
  await oneAtATime(file, async () => {
    const next = await fn(await readClaudePlugins(profileDir))
    await fs.mkdir(path.dirname(file), { recursive: true })
    await writeThroughTmp(file, JSON.stringify(next, null, 2) + '\n')
    written = next
  })
  return written as ClaudePluginStore
}

/** Whether any plugin is shared, so the profile behaves as it did before plugins could be shared while none is (the
 *  settings import then keeps today's behavior). A store that cannot be read says something was shared. */
export async function claudePluginsShared(profileDir: string): Promise<boolean> {
  return readClaudePlugins(profileDir, { keepDamaged: false }).then(
    (s) => s.plugins.length > 0,
    () => true
  )
}
