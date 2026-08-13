import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RunConfig } from '../core/run/config'
import { migrateRunConfigs } from '../core/run/migrate'

/** Per-project user run config store. Key = project root path. Follows the RollConfigStore pattern. */
export class RunConfigStore {
  private map: Record<string, RunConfig[]> = {}

  constructor(private filePath: string) {}

  async load(): Promise<{ recovered: boolean }> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
      // Only a file that isn't even a map counts as a schema violation. A hand-edited item is
      // migrateRunConfigs's problem — it drops just that item, not the whole store.
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('invalid schema')
      }
      const map: Record<string, RunConfig[]> = {}
      for (const [projectPath, list] of Object.entries(parsed)) {
        map[projectPath] = migrateRunConfigs(list)
      }
      this.map = map
      return { recovered: false }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.map = {}
        return { recovered: false }
      }
      await fs.copyFile(this.filePath, this.filePath + '.bak').catch(() => {})
      this.map = {}
      return { recovered: true }
    }
  }

  get(projectPath: string): RunConfig[] {
    return this.map[projectPath] ?? []
  }

  async save(projectPath: string, configs: RunConfig[]): Promise<void> {
    this.map[projectPath] = configs
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${randomUUID()}.tmp`
    await fs.writeFile(tmp, JSON.stringify(this.map, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
  }
}
