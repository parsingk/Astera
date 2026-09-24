import { promises as fs } from 'node:fs'
import path from 'node:path'
import { foldPathCase, legacyFoldedKey } from '../files/paths'

// Case is folded only where the filesystem ignores it (win32, darwin's default APFS) — foldPathCase.
// On linux /home/u/Proj and /home/u/proj are two projects with two settings.
//
// **Older builds lower-cased the key on every platform**, so on linux projects.json can hold
// `/home/u/proj` for the project at `/home/u/Proj`. get falls back to that key when the exact one is
// absent; a load-time migration is not possible, because the lower-cased key no longer says what the
// original case was. set writes the exact key and leaves the old one where it is — on linux that key
// may by now be the exact key of a real `/home/u/proj`, and deleting it would drop that project's
// setting. Clearing removes both, or the old value would come back through the fallback; the price is
// that clearing `/home/u/Proj` also clears a `/home/u/proj` that shares the old key, which is the
// sharing older builds already did. Nothing changes on win32 or darwin: legacyFoldedKey is null there.

function isValidMap(obj: unknown): obj is Record<string, string> {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return false
  for (const v of Object.values(obj)) {
    if (typeof v !== 'string') return false
  }
  return true
}

export class ProjectSettings {
  private map: Record<string, string> = {}

  constructor(
    private filePath: string,
    private platform: string = process.platform
  ) {}

  private key(projectPath: string): string {
    return foldPathCase(path.resolve(projectPath), this.platform)
  }

  async load(): Promise<{ recovered: boolean }> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
      if (!isValidMap(parsed)) throw new Error('invalid schema')
      this.map = parsed
      return { recovered: false }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.map = {}
        return { recovered: false }
      }
      // Preserve the corrupt copy, then start from an empty map
      await fs.copyFile(this.filePath, this.filePath + '.bak').catch(() => {})
      this.map = {}
      return { recovered: true }
    }
  }

  getDefaultAccount(projectPath: string): string | null {
    const key = this.key(projectPath)
    const legacy = legacyFoldedKey(key, this.platform)
    return this.map[key] ?? (legacy === null ? undefined : this.map[legacy]) ?? null
  }

  async setDefaultAccount(projectPath: string, accountId: string | null): Promise<void> {
    const key = this.key(projectPath)
    if (accountId === null) {
      delete this.map[key]
      const legacy = legacyFoldedKey(key, this.platform)
      if (legacy !== null) delete this.map[legacy]
    } else this.map[key] = accountId
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, JSON.stringify(this.map, null, 2), 'utf8')
  }
}
