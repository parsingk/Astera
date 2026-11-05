// Finding a shared plugin's update without a version number to compare. Claude Code prints no "update available" (M4), so
// Astera fingerprints the plugin's entry in the marketplace clone of its own config folder (the "home") when it installs,
// and again after `claude plugin marketplace update`: a different fingerprint is an update on offer (R3). This only reads
// the home; nothing here runs `claude` or writes a file.
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { normalized } from '../compareHash'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

/** The parsed JSON of a file, or null when it is missing, cannot be read or is not JSON (it may be mid-write). */
async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/** JSON with the keys of every object in sorted order, so the same entry written in another key order is the same text. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}

async function files(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = []
  for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name === '.git') continue
    const r = rel === '' ? e.name : `${rel}/${e.name}`
    if (e.isDirectory()) out.push(...(await files(dir, r)))
    else if (e.isFile()) out.push(r)
  }
  return out
}

/** sha256 of a plugin folder: each relative path (with `/`) and its bytes with CRLF made LF in a text file (`normalized`,
 *  the rule of the Runtime comparison hash), in sorted path order. It is the recipe of `hashTree`, which can be told neither
 *  to leave `.git` out nor to fold line endings. A plugin that is its marketplace's own root has the clone's `.git` inside it, and every pull
 *  changes that without changing what the plugin loads. `claude plugin marketplace add` clones with git, which on Windows
 *  writes text files with CRLF, and the first `marketplace update` replaces the clone with a download of the same commit,
 *  with LF: the same plugin must not look changed for that. Throws when the folder is missing. */
async function folderDigest(dir: string): Promise<string> {
  const h = createHash('sha256')
  for (const rel of (await files(dir)).sort()) h.update(rel).update('\0').update(normalized(await fs.readFile(path.join(dir, rel)))).update('\0')
  return h.digest('hex')
}

const insideOf = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child)
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

/** A source that is a path from the marketplace folder (`./x`, `../x`, `.`), as opposed to a bare name. */
const startsHere = (source: string): boolean => /^\.{1,2}([\\/]|$)/.test(source)

/** The folder a string source names, or null when it names none Astera may read. Claude Code resolves a bare name
 *  (`formatter`) under the catalog's `metadata.pluginRoot` and refuses it when the catalog sets none or sets one outside
 *  the marketplace; a path (`./plugins/formatter`) starts at the marketplace folder, pluginRoot or not. A catalog is
 *  third-party text, so neither the root nor the folder may climb out of the clone: Astera must not hash whatever folder
 *  it names. */
function sourceFolder(installLocation: string, catalog: Obj, source: string): string | null {
  let base = installLocation
  if (!startsHere(source)) {
    const root = isObj(catalog.metadata) && typeof catalog.metadata.pluginRoot === 'string' ? catalog.metadata.pluginRoot : ''
    if (root === '') return null
    base = path.resolve(installLocation, root)
    if (!insideOf(installLocation, base)) return null
  }
  const folder = path.resolve(base, source)
  return insideOf(installLocation, folder) ? folder : null
}

const versionOf = (v: unknown): string | null => (isObj(v) && typeof v.version === 'string' && v.version !== '' ? v.version : null)

/** What the marketplace of `home` offers for the plugin `name` right now: a fingerprint that changes when anything in the
 *  entry but its description changes (canonical JSON, so key order does not matter) and, for a source that is a folder of
 *  the marketplace (a string), when any file in that folder does; and the version on offer, which is that folder's own
 *  manifest version when it has one, else the entry's version, else null. Null when the home has no such marketplace,
 *  plugin, catalog or folder, when a string source cannot be resolved (`sourceFolder`), or when a file cannot be read:
 *  there is then nothing to compare, and the caller leaves what it recorded alone. */
export async function catalogFingerprint(a: {
  home: string
  marketplace: string
  name: string
}): Promise<{ fingerprint: string; offeredVersion: string | null } | null> {
  const known = await readJson(path.join(a.home, 'plugins', 'known_marketplaces.json'))
  const record = isObj(known) ? known[a.marketplace] : undefined
  const installLocation = isObj(record) && typeof record.installLocation === 'string' && record.installLocation !== '' ? record.installLocation : null
  if (installLocation === null) return null

  const catalog = await readJson(path.join(installLocation, '.claude-plugin', 'marketplace.json'))
  if (!isObj(catalog)) return null
  const entry = Array.isArray(catalog.plugins) ? catalog.plugins.find((e) => isObj(e) && e.name === a.name) : undefined
  if (!isObj(entry)) return null

  // The whole entry but its description: a `strict: false` entry declares hooks, MCP servers and commands in the catalog,
  // and an update missed is worse than one that turns out to change nothing
  const { description: _description, ...loadable } = entry
  const hash = createHash('sha256').update(canonical(loadable))
  let offeredVersion = versionOf(entry)
  if (typeof entry.source === 'string') {
    const folder = sourceFolder(installLocation, catalog, entry.source)
    if (folder === null) return null
    try {
      hash.update('\0').update(await folderDigest(folder))
    } catch {
      return null
    }
    offeredVersion = versionOf(await readJson(path.join(folder, '.claude-plugin', 'plugin.json'))) ?? offeredVersion
  }
  return { fingerprint: `sha256:${hash.digest('hex')}`, offeredVersion }
}
