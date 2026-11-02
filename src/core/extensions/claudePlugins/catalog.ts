// Finding a shared plugin's update without a version number to compare. Claude Code prints no "update available" (M4), so
// Astera fingerprints the plugin's entry in the marketplace clone of its own config folder (the "home") when it installs,
// and again after `claude plugin marketplace update`: a different fingerprint is an update on offer (R3). This only reads
// the home; nothing here runs `claude` or writes a file.
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { hashFile } from '../hash'

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

/** sha256 of a plugin folder: each relative path (with `/`) and the hash of its bytes, in sorted path order. It is the
 *  recipe of `hashTree`, which cannot be told to leave `.git` out: a plugin that is its marketplace's own root has the
 *  clone's `.git` inside it, and every pull changes that without changing what the plugin loads. Throws when the folder is
 *  missing. */
async function folderDigest(dir: string): Promise<string> {
  const h = createHash('sha256')
  for (const rel of (await files(dir)).sort()) h.update(rel).update('\0').update(await hashFile(path.join(dir, rel))).update('\0')
  return h.digest('hex')
}

const insideOf = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child)
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

const versionOf = (v: unknown): string | null => (isObj(v) && typeof v.version === 'string' && v.version !== '' ? v.version : null)

/** What the marketplace of `home` offers for the plugin `name` right now: a fingerprint that changes when the entry's
 *  name, version or source changes and, for a source that is a folder of the marketplace (a relative string), when any file
 *  in that folder does; and the version on offer, which is that folder's own manifest version when it has one, else the
 *  entry's version, else null. Null when the home has no such marketplace, plugin, catalog or folder, or a file cannot be
 *  read: there is then nothing to compare, and the caller leaves what it recorded alone. */
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
  const entry = isObj(catalog) && Array.isArray(catalog.plugins) ? catalog.plugins.find((e) => isObj(e) && e.name === a.name) : undefined
  if (!isObj(entry)) return null

  const hash = createHash('sha256').update(canonical({ name: a.name, version: entry.version ?? null, source: entry.source ?? null }))
  let offeredVersion = versionOf(entry)
  if (typeof entry.source === 'string') {
    const folder = path.resolve(installLocation, entry.source)
    // a catalog is third-party text: a source that climbs out of the clone is not one of its plugins, and must not make
    // Astera hash whatever folder it names
    if (!insideOf(installLocation, folder)) return null
    try {
      hash.update('\0').update(await folderDigest(folder))
    } catch {
      return null
    }
    offeredVersion = versionOf(await readJson(path.join(folder, '.claude-plugin', 'plugin.json'))) ?? offeredVersion
  }
  return { fingerprint: `sha256:${hash.digest('hex')}`, offeredVersion }
}
