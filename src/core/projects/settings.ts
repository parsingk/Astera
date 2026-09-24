import { promises as fs } from 'node:fs'
import path from 'node:path'
import { foldPathCase } from '../files/paths'

// Case is folded only where the filesystem ignores it (win32, darwin's default APFS) — foldPathCase.
// On linux /home/u/Proj and /home/u/proj are two projects with two settings.

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

  /** Exact key only, on every platform.
   *
   *  **No fallback to the lower-cased key older builds wrote on linux** (they folded case everywhere).
   *  A lower-case key on disk cannot say whether an older build wrote it for `/home/u/Proj` or this
   *  build wrote it for a real `/home/u/proj`, and falling back to it hands one folder's setting to its
   *  sibling — clearing the sibling would then delete it. Telling the two apart took a record kept
   *  beside the file, which a hand-deleted file brings the leak back from.
   *
   *  The cost, accepted: on linux, after upgrading, a project whose path has upper case forgets its
   *  default account once — the account the New Session dialog preselects — until it is picked again.
   *  The old entry stays in the file untouched. Nothing changes on win32 or darwin, where the key is
   *  folded exactly as before. */
  getDefaultAccount(projectPath: string): string | null {
    return this.map[this.key(projectPath)] ?? null
  }

  async setDefaultAccount(projectPath: string, accountId: string | null): Promise<void> {
    const key = this.key(projectPath)
    if (accountId === null) delete this.map[key]
    else this.map[key] = accountId
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, JSON.stringify(this.map, null, 2), 'utf8')
  }
}
