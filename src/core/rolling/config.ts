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

/** Where the Host keeps the roll configs of the chains it owns (S6 R9): one writer per file. */
export function hostRollConfigPath(profileDir: string): string {
  return path.join(profileDir, 'host', 'rolling.json')
}

/** One key out of a roll config file, read fresh; null when the file or the key is missing or damaged. */
export async function readRollConfigKey(filePath: string, key: string): Promise<RollConfig | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'))
    if (!isValidMap(parsed)) return null
    return parsed[key] ?? null
  } catch {
    return null
  }
}

/** The one write in flight per file, across every store on it (chat takeover e2e E1). */
const writesInFlight = new Map<string, Promise<void>>()

/** The errors a Windows rename gives while another handle still has the target open (a virus scanner,
 *  an indexer, a reader mid read): worth another try in a moment. */
const RETRY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_TRIES = 5

export interface RollConfigStoreOptions {
  /** Test seam; default fs.rename. */
  rename?(from: string, to: string): Promise<void>
  /** The wait before the next try is this times the tries so far. Default 25 ms. */
  retryDelayMs?: number
}

/**
 * Store for the rolling config. Key = claude session id, value = RollConfig.
 * Corruption recovery follows the ProjectSettings pattern; atomic writes (tmp+rename) follow the
 * AccountRegistry.save pattern.
 *
 * **One write at a time per file** (chat takeover e2e E1): the Host's claude and codex chains restored
 * in one takeover pass both wrote `rolling.json`, and on Windows the second tmp-to-file rename failed
 * with EPERM while the first was still landing. A set made while a write waits for its turn rides along
 * with that write (it serialises the whole map when it starts), so a burst costs two writes, not one per
 * set. A rename refused with a lock error is tried again a few times before the set rejects.
 */
export class RollConfigStore {
  private map: Record<string, RollConfig> = {}
  /** The write that has not started yet, which a new set rides along with. */
  private queued: Promise<void> | null = null
  private readonly rename: (from: string, to: string) => Promise<void>
  private readonly retryDelayMs: number

  constructor(
    private filePath: string,
    opts: RollConfigStoreOptions = {}
  ) {
    this.rename = opts.rename ?? ((from, to) => fs.rename(from, to))
    this.retryDelayMs = opts.retryDelayMs ?? 25
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
      await fs.copyFile(this.filePath, this.filePath + '.bak').catch(() => {})
      this.map = {}
      return { recovered: true }
    }
  }

  get(claudeSessionId: string): RollConfig | null {
    return this.map[claudeSessionId] ?? null
  }

  set(claudeSessionId: string, config: RollConfig): Promise<void> {
    this.map[claudeSessionId] = config
    if (this.queued) return this.queued
    const key = path.resolve(this.filePath)
    const before = writesInFlight.get(key) ?? Promise.resolve()
    const mine = before
      .catch(() => {})
      .then(() => {
        // From here a new set queues the next write: this one may already have serialised the map.
        this.queued = null
        return this.writeNow()
      })
    this.queued = mine
    const settled = mine.catch(() => {})
    writesInFlight.set(key, settled)
    void settled.then(() => {
      if (writesInFlight.get(key) === settled) writesInFlight.delete(key)
    })
    return mine
  }

  private async writeNow(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${randomUUID()}.tmp` // avoids temp-file contention on concurrent writes
    await fs.writeFile(tmp, JSON.stringify(this.map, null, 2), 'utf8')
    for (let attempt = 1; ; attempt++) {
      try {
        await this.rename(tmp, this.filePath)
        return
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (attempt >= RENAME_TRIES || code === undefined || !RETRY_CODES.has(code)) {
          await fs.rm(tmp, { force: true }).catch(() => {})
          throw err
        }
        await new Promise((r) => setTimeout(r, this.retryDelayMs * attempt))
      }
    }
  }
}
