// Reading and writing the shared extension registry (Agent Control Plane release 1 design §4.3). The Host writes it;
// the app and the CLI read it. A file that is there but cannot be read or parsed is kept aside and reported, never
// taken for "no extensions": the next write would otherwise erase what the person set up.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { extensionPaths } from '../profile/paths'
import { keepDamaged, readStoreFile } from '../storeFile'
import { writeThroughTmp } from '../accounts/fileQueue'
import { RepairNeeded } from '../settings/repairNeeded'
import type { ExtensionEntry, ExtensionRegistry } from './types'

const FILE = path.join('extensions', 'registry.json')

const empty = (): ExtensionRegistry => ({ version: 1, entries: [] })

/** The profile's registry; empty when there is none. Throws RepairNeeded when the file is damaged or unreadable. */
export async function readExtensionRegistry(profileDir: string): Promise<ExtensionRegistry> {
  const file = extensionPaths(profileDir).registry
  const read = await readStoreFile(file)
  if (read.kind === 'missing') return empty()
  if (read.kind === 'unreadable') throw new RepairNeeded(`${FILE} could not be read (${String(read.error)})`, FILE)
  let parsed: unknown
  try {
    parsed = JSON.parse(read.text)
  } catch {
    parsed = null
  }
  const r = parsed as ExtensionRegistry | null
  if (!r || r.version !== 1 || !Array.isArray(r.entries)) {
    await keepDamaged(file, read.text)
    throw new RepairNeeded(`${FILE} is damaged; a copy was kept beside it`, FILE)
  }
  return r
}

/** Writes the registry atomically. */
export async function writeExtensionRegistry(profileDir: string, r: ExtensionRegistry): Promise<void> {
  const file = extensionPaths(profileDir).registry
  await fs.mkdir(path.dirname(file), { recursive: true })
  await writeThroughTmp(file, JSON.stringify(r, null, 2) + '\n')
}

/** Nothing shared yet: the profile behaves as it did before shared extensions existed (design D9, AC-09.1). */
export function registryIsEmpty(r: ExtensionRegistry): boolean {
  return r.entries.length === 0
}

/** Whether the settings import button copies MCP servers, skills, commands and agents too (design §4.7, D9): only
 *  while nothing is shared, so a profile that never uses Extensions keeps today's button. A registry that cannot be
 *  read says something was shared, so the button leaves them alone. */
export async function settingsImportCopiesCapabilities(profileDir: string): Promise<boolean> {
  return readExtensionRegistry(profileDir).then(registryIsEmpty, () => false)
}

/** An entry as the app and the CLI see it: an MCP server's environment names say where each value comes from, and no
 *  value is in it (D5). */
export function publicEntry(e: ExtensionEntry): unknown {
  if (e.kind !== 'mcp') return e
  const env = Object.fromEntries(Object.entries(e.env).map(([n, v]) => [n, 'secret' in v ? 'secret' : 'value' in v ? 'value' : 'inherit']))
  return { ...e, env }
}
