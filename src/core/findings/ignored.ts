// The findings the person set aside (lifecycle design §6): `<profile>/findings-ignored.json`, written by the Host alone,
// each finding key with when it was ignored and an optional note. An ignore holds until it is brought back: nothing here
// lets one go when its subject changes. The agent profile store's pattern: a file that is there but cannot be read or
// parsed is reported and its bytes kept aside, never taken for "nothing ignored", since the next write would erase it.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { profilePaths } from '../profile/paths'
import { hasKeptCopy, keepDamaged, readStoreFile } from '../storeFile'
import { writeThroughTmp } from '../accounts/fileQueue'
import { RepairNeeded } from '../settings/repairNeeded'

const FILE = 'findings-ignored.json'

export interface IgnoredFile {
  version: 1
  ignored: Record<string, { at: string; note?: string }>
}

/** The damaged text this process last kept aside, by file, and whether the copy is there: the findings are computed at
 *  every request past the cache, and one copy per distinct damage is enough (the agent profile store's rule). Set before
 *  the copy is made, so reads racing this one wait for it rather than copy again; dropped when the copy is not there, so
 *  the next read tries again. */
const keptDamage = new Map<string, { hash: string; kept: Promise<boolean> }>()

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The ignores a parsed file holds, or null when it is not such a file. Built with own properties only, so a key can be
 *  any text a finding key is. */
function ignoredOf(v: unknown): IgnoredFile | null {
  if (!isRecord(v) || v.version !== 1 || !isRecord(v.ignored)) return null
  const entries: Array<[string, { at: string; note?: string }]> = []
  for (const [key, e] of Object.entries(v.ignored)) {
    if (!isRecord(e) || typeof e.at !== 'string' || (e.note !== undefined && typeof e.note !== 'string')) return null
    entries.push([key, { at: e.at, ...(e.note !== undefined ? { note: e.note as string } : {}) }])
  }
  return { version: 1, ignored: Object.fromEntries(entries) }
}

/** The ignores; none when there is no file. Throws RepairNeeded when the file is damaged or unreadable, saying whether
 *  the damaged bytes were kept beside it: only when a copy is there. */
export async function readIgnored(
  profileDir: string,
  o: {
    /** Test injection: how the damaged bytes are kept aside. */
    keep?: (file: string, text: string) => Promise<void>
  } = {}
): Promise<IgnoredFile> {
  const file = profilePaths(profileDir).findingsIgnored
  const read = await readStoreFile(file)
  if (read.kind === 'missing') return { version: 1, ignored: {} }
  if (read.kind === 'unreadable') throw new RepairNeeded(`${FILE} could not be read (${String(read.error)})`, FILE)
  let parsed: unknown
  try {
    parsed = JSON.parse(read.text)
  } catch {
    parsed = null
  }
  const f = ignoredOf(parsed)
  if (f === null) {
    const text = read.text
    const hash = createHash('sha256').update(text).digest('hex')
    let damage = keptDamage.get(file)
    if (damage === undefined || damage.hash !== hash) {
      const keep = o.keep ?? keepDamaged
      damage = { hash, kept: keep(file, text).catch(() => {}).then(() => hasKeptCopy(file, text)) }
      keptDamage.set(file, damage)
    }
    if (!(await damage.kept)) {
      if (keptDamage.get(file) === damage) keptDamage.delete(file)
      throw new RepairNeeded(`${FILE} is damaged, and a copy of it could not be kept`, FILE)
    }
    throw new RepairNeeded(`${FILE} is damaged; a copy was kept beside it`, FILE)
  }
  return f
}

/** Writes the ignores atomically. */
export async function writeIgnored(profileDir: string, f: IgnoredFile): Promise<void> {
  const file = profilePaths(profileDir).findingsIgnored
  await fs.mkdir(path.dirname(file), { recursive: true })
  await writeThroughTmp(file, JSON.stringify(f, null, 2) + '\n')
}
