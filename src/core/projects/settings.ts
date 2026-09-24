import { promises as fs } from 'node:fs'
import path from 'node:path'
import { foldPathCase, foldsPathCase, legacyFoldedKey } from '../files/paths'

// Case is folded only where the filesystem ignores it (win32, darwin's default APFS) — foldPathCase.
// On linux /home/u/Proj and /home/u/proj are two projects with two settings.
//
// **Older builds lower-cased the key on every platform**, so on linux projects.json can hold
// `/home/u/proj` for the project at `/home/u/Proj`. A load-time migration is not possible: the
// lower-cased key no longer says what the original case was. So get falls back to that key when the
// exact one is absent — but **only to a key an older build wrote.** A lower-case key this build wrote
// is the exact key of a real `/home/u/proj`; falling back to it would hand that folder's setting to
// `/home/u/Proj`, and clearing `/home/u/Proj` would delete it.
//
// Which keys are the older build's is recorded once, beside the file (`<file>.legacy-keys`, linux
// only): the first time this build loads a projects.json with no such record, every all-lower-case key
// in it can only have come from an older build, since this build has not written the file yet. That set
// only ever shrinks — a key leaves it when this build writes or clears that exact key, or clears it as
// the legacy key of a sibling. The record is written before projects.json on every save, so a crash
// between the two can leave a record naming a key the file no longer has (harmless: lookups go through
// the map) but never a file with keys this build wrote and no record, which the next load would read
// as legacy.
//
// Why a sidecar rather than a marker inside projects.json: the file is a flat Record<string, string>
// that older builds validate as such, and a downgrade has to keep reading it.
//
// Nothing changes on win32 or darwin: legacyFoldedKey is null there, and no record is read or written.

function isValidMap(obj: unknown): obj is Record<string, string> {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return false
  for (const v of Object.values(obj)) {
    if (typeof v !== 'string') return false
  }
  return true
}

export class ProjectSettings {
  private map: Record<string, string> = {}
  /** The keys an older build wrote (see above). null where case is folded and there is no such thing. */
  private legacyKeys: Set<string> | null = null

  constructor(
    private filePath: string,
    private platform: string = process.platform
  ) {}

  private get legacyKeysPath(): string {
    return this.filePath + '.legacy-keys'
  }

  private key(projectPath: string): string {
    return foldPathCase(path.resolve(projectPath), this.platform)
  }

  async load(): Promise<{ recovered: boolean }> {
    let recovered = false
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
      if (!isValidMap(parsed)) throw new Error('invalid schema')
      this.map = parsed
    } catch (err) {
      this.map = {}
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Preserve the corrupt copy, then start from an empty map
        await fs.copyFile(this.filePath, this.filePath + '.bak').catch(() => {})
        recovered = true
      }
    }
    this.legacyKeys = foldsPathCase(this.platform) ? null : await this.loadLegacyKeys()
    return { recovered }
  }

  /** The record if there is one, else the first-load derivation. An unreadable record counts as "no
   *  legacy keys": the failure direction that can hide an old setting from a differently cased path,
   *  never the one that hands a folder's setting to its sibling. */
  private async loadLegacyKeys(): Promise<Set<string>> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.legacyKeysPath, 'utf8'))
      if (!Array.isArray(parsed)) return new Set()
      return new Set(parsed.filter((k): k is string => typeof k === 'string' && k in this.map))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return new Set()
      return new Set(Object.keys(this.map).filter((k) => k === k.toLowerCase()))
    }
  }

  /** The legacy key to fall back to for key, or null — only one an older build wrote. */
  private legacyFor(key: string): string | null {
    const legacy = legacyFoldedKey(key, this.platform)
    return legacy !== null && this.legacyKeys?.has(legacy) ? legacy : null
  }

  getDefaultAccount(projectPath: string): string | null {
    const key = this.key(projectPath)
    const legacy = this.legacyFor(key)
    return this.map[key] ?? (legacy === null ? undefined : this.map[legacy]) ?? null
  }

  async setDefaultAccount(projectPath: string, accountId: string | null): Promise<void> {
    const key = this.key(projectPath)
    if (accountId === null) {
      delete this.map[key]
      // Clearing the legacy key too, or its value would come back through the fallback. It is an older
      // build's key, shared by every folder spelled like this one apart from case, as it was then.
      const legacy = this.legacyFor(key)
      if (legacy !== null) {
        delete this.map[legacy]
        this.legacyKeys?.delete(legacy)
      }
    } else this.map[key] = accountId
    // From here on this build owns key, whatever wrote it before.
    this.legacyKeys?.delete(key)
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    if (this.legacyKeys !== null) {
      await fs.writeFile(this.legacyKeysPath, JSON.stringify([...this.legacyKeys].sort()), 'utf8')
    }
    await fs.writeFile(this.filePath, JSON.stringify(this.map, null, 2), 'utf8')
  }
}
