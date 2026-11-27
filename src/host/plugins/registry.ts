// `<profile>/plugins/plugins.json`: the plugins this profile has installed and what the person granted each (plugin
// runtime design P4). The Host is its only writer, so a write is a whole file through a temp file and a rename.
import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { PluginPermission, PluginUiPermission } from '../../core/plugins/manifest'
import { moveRetrying, type Rename } from './moves'

export interface PluginRecord {
  id: string
  /** The version installed, as its package.json said when it was installed. */
  version: string
  /** The folder under `<profile>/plugins/installed` (`pluginFolderName`). */
  folder: string
  enabled: boolean
  /** What the person approved: a subset of what the plugin asks for (spec §11); a Plugin API 2 plugin's UI permissions too. */
  granted: (PluginPermission | PluginUiPermission)[]
  installedAt: number
  /** Minted when the plugin is installed with no record before it and kept by every update, so a plugin removed and
   *  installed again under the same id is told apart from an update (the app wipes its panel storage then; Phase 2 gate
   *  final review I2). A record from an Astera before it has none, and gets one at its next install. */
  installId?: string
  /** Where it was installed from: a folder, an npm package by the spec the person gave and the version it was
   *  (plugins 2e), or a package file (`plugins pack`, Phase 2 step 4a) by its path and the sha256 of the bytes installed. */
  source:
    | { kind: 'folder'; path: string }
    | { kind: 'npm'; spec: string; version: string }
    | { kind: 'file'; path: string; sha256: string }
    /** Phase 4: an exact version from a signed catalog, by the artifact's address and sha256. */
    | { kind: 'catalog'; id: string; version: string; sha256: string; url: string }
}

const FILE = 'plugins.json'
const VERSION = 1

export const pluginsRoot = (profileDir: string): string => path.join(profileDir, 'plugins')

/** A registry that is there and cannot be read. Never read as empty: a write would then drop every other plugin's
 *  record and grant, so every change is refused until a person repairs the file. */
export class RegistryUnreadable extends Error {
  readonly code = 'PLUGIN_REGISTRY_UNREADABLE'
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A folder name that stays one folder under the plugins root. */
const isFolderName = (v: unknown): v is string =>
  typeof v === 'string' && v !== '' && v !== '.' && v !== '..' && !/[\\/]/.test(v)

const isRecord = (v: unknown): v is PluginRecord =>
  isObject(v) &&
  typeof v.id === 'string' &&
  typeof v.version === 'string' &&
  isFolderName(v.folder) &&
  typeof v.enabled === 'boolean' &&
  Array.isArray(v.granted) &&
  v.granted.every((g) => typeof g === 'string') &&
  typeof v.installedAt === 'number' &&
  isObject(v.source) &&
  ((v.source.kind === 'folder' && typeof v.source.path === 'string') ||
    (v.source.kind === 'npm' && typeof v.source.spec === 'string' && typeof v.source.version === 'string') ||
    (v.source.kind === 'file' && typeof v.source.path === 'string' && typeof v.source.sha256 === 'string') ||
    (v.source.kind === 'catalog' &&
      typeof v.source.id === 'string' &&
      typeof v.source.version === 'string' &&
      typeof v.source.sha256 === 'string' &&
      typeof v.source.url === 'string'))

export async function readRegistry(root: string): Promise<PluginRecord[]> {
  const file = path.join(root, FILE)
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  const unreadable = (why: string): RegistryUnreadable =>
    new RegistryUnreadable(`${file} ${why}; fix it or delete it (deleting forgets every installed plugin)`)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw unreadable('is not JSON')
  }
  if (!isObject(parsed) || parsed.version !== VERSION) throw unreadable(`is not a version ${VERSION} plugin registry`)
  if (!Array.isArray(parsed.plugins)) throw unreadable('has no plugins list')
  const bad = parsed.plugins.findIndex((r) => !isRecord(r))
  if (bad >= 0) throw unreadable(`has a record it cannot read (plugins[${bad}])`)
  return parsed.plugins as PluginRecord[]
}

export async function writeRegistry(
  root: string,
  records: readonly PluginRecord[],
  o: { rename?: Rename; waitsMs?: readonly number[] } = {}
): Promise<void> {
  await fs.mkdir(root, { recursive: true })
  const file = path.join(root, FILE)
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify({ version: VERSION, plugins: records }, null, 2)}\n`, 'utf8')
  try {
    await moveRetrying(tmp, file, o)
  } catch (e) {
    await fs.rm(tmp, { force: true })
    throw e
  }
}
