import { promises as fs } from 'node:fs'
import path from 'node:path'

// win32 first: ignores path case (to be branched when macOS is supported)
const normalize = (p: string): string => path.resolve(p).toLowerCase()

function isValidMap(obj: unknown): obj is Record<string, string> {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return false
  for (const v of Object.values(obj)) {
    if (typeof v !== 'string') return false
  }
  return true
}

export class ProjectSettings {
  private map: Record<string, string> = {}

  constructor(private filePath: string) {}

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
    return this.map[normalize(projectPath)] ?? null
  }

  async setDefaultAccount(projectPath: string, accountId: string | null): Promise<void> {
    const key = normalize(projectPath)
    if (accountId === null) delete this.map[key]
    else this.map[key] = accountId
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, JSON.stringify(this.map, null, 2), 'utf8')
  }
}
