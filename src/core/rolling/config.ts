import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RollConfig } from './types'
export type { RollConfig } from './types'

function isValidConfig(v: unknown): v is RollConfig {
  if (v === null || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (!Array.isArray(o.accountIds) || !o.accountIds.every((x) => typeof x === 'string')) return false
  if (o.prompt !== undefined && typeof o.prompt !== 'string') return false
  return true
}

function isValidMap(obj: unknown): obj is Record<string, RollConfig> {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return false
  return Object.values(obj).every(isValidConfig)
}

/**
 * Store for the rolling config. Key = claude session id, value = RollConfig.
 * Corruption recovery follows the ProjectSettings pattern; atomic writes (tmp+rename) follow the
 * AccountRegistry.save pattern.
 */
export class RollConfigStore {
  private map: Record<string, RollConfig> = {}

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
      await fs.copyFile(this.filePath, this.filePath + '.bak').catch(() => {})
      this.map = {}
      return { recovered: true }
    }
  }

  get(claudeSessionId: string): RollConfig | null {
    return this.map[claudeSessionId] ?? null
  }

  async set(claudeSessionId: string, config: RollConfig): Promise<void> {
    this.map[claudeSessionId] = config
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${randomUUID()}.tmp` // avoids temp-file contention on concurrent writes
    await fs.writeFile(tmp, JSON.stringify(this.map, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
  }
}
