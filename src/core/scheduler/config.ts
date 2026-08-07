import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isValidScheduleConfig, type ScheduleConfig } from './rule'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** A persisted entry — updatedAt lives only here, where persistence is the concern. ScheduleConfig itself
 *  is also part of the IPC contract (SessionInfo.schedule, sessions.spawn opts), so it is not polluted */
interface StoredEntry {
  config: ScheduleConfig
  updatedAt: number
}

function isStoredEntry(v: unknown): v is StoredEntry {
  return (
    isPlainObject(v) &&
    isValidScheduleConfig(v.config) &&
    typeof v.updatedAt === 'number' &&
    Number.isFinite(v.updatedAt)
  )
}

// Expiry TTL — a generous upper bound on how long resuming that session stays realistically plausible
const ENTRY_TTL_MS = 30 * 24 * 60 * 60_000 // 30 days

/**
 * The schedule config store. Key = claude session id, value = { config, updatedAt }.
 * The atomic write (tmp+rename) is the same as RollConfigStore (rolling/config.ts), but the response to
 * corruption is split per entry — RollConfigStore treats the whole map as one schema and recovers it
 * wholesale (.bak) when a single entry is broken, whereas here wiping out the schedules of other healthy
 * sessions because one session's schedule broke would do real damage, so only the invalid entries are
 * dropped and the rest survive.
 * Because a schedule can be turned off, it also has delete.
 * handleExit does not clear persistence (deliberately, so a resume can restore it), which makes
 * scheduler.json grow monotonically with the number of sessions; that is prevented by pruning entries whose
 * updatedAt has passed the TTL (ENTRY_TTL_MS) at load() time.
 */
export class SchedulerConfigStore {
  private map: Record<string, StoredEntry> = {}
  private readonly now: () => number

  constructor(
    private filePath: string,
    now?: () => number
  ) {
    this.now = now ?? Date.now
  }

  /** recovered: the file itself could not be read or parsed (or its top level is not a plain object) →
   *  whether it was backed up to .bak in full and started from an empty map. dropped: the number that parsed
   *  but were discarded because an individual entry violated the schema — the remaining valid entries
   *  survive (told apart by recovered=false). pruned: the number whose schema is valid but whose updatedAt
   *  passed the TTL and was expired away. A legacy (unwrapped) shape is only wrapped and promoted with the
   *  current time (migrated) and is not treated as expired on the spot — migrated is not a sign of trouble,
   *  so it is not returned and is used only to decide whether to rewrite. */
  async load(): Promise<{ recovered: boolean; dropped: number; pruned: number }> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.map = {}
        return { recovered: false, dropped: 0, pruned: 0 }
      }
      // A read failure (permissions and so on) or a JSON parse failure — the file itself cannot be trusted
      await fs.copyFile(this.filePath, this.filePath + '.bak').catch(() => {})
      this.map = {}
      return { recovered: true, dropped: 0, pruned: 0 }
    }
    if (!isPlainObject(parsed)) {
      await fs.copyFile(this.filePath, this.filePath + '.bak').catch(() => {})
      this.map = {}
      return { recovered: true, dropped: 0, pruned: 0 }
    }
    const valid: Record<string, StoredEntry> = {}
    let dropped = 0
    let pruned = 0
    let migrated = 0
    const now = this.now()
    for (const [key, value] of Object.entries(parsed)) {
      let entry: StoredEntry
      if (isStoredEntry(value)) {
        entry = value
      } else if (isValidScheduleConfig(value)) {
        // The legacy shape (a bare ScheduleConfig with no wrapper, from before the wrapper existed) — it has
        // no updatedAt, so it is wrapped and promoted with the current time. Treating it as 0 and deleting it
        // right away would hand the user a loss they did not expect
        entry = { config: value, updatedAt: now }
        migrated++
      } else {
        dropped++
        continue
      }
      if (entry.updatedAt < now - ENTRY_TTL_MS) {
        pruned++
        continue
      }
      valid[key] = entry
    }
    this.map = valid
    if (dropped > 0 || pruned > 0) {
      // Discarding is destructive too, so the original is preserved before the cleanup
      await fs.copyFile(this.filePath, this.filePath + '.bak').catch(() => {})
    }
    if (dropped > 0 || pruned > 0 || migrated > 0) {
      // The cleaned map (plus any legacy promotions) is written back immediately — otherwise every run would
      // discard the same invalid entries again or migrate the legacy shape again, and would overwrite .bak
      // each time, making the log noisy.
      // Failure is swallowed — load() in every other store is read-only and never throws, and this save() was
      // the one unprotected write inside a load(). On Windows a rename that fails with EPERM/EACCES (a lock,
      // a read-only file, a full disk) makes load() reject → createCore rejects → and since
      // app.whenReady().then(...) in index.ts has no .catch, that becomes a silent startup failure where the
      // window never appears at all. If it fails, the cleanup and the .bak simply repeat on the next run, and
      // that is an acceptable degradation.
      await this.save().catch(() => {})
    }
    return { recovered: false, dropped, pruned }
  }

  get(sessionKey: string): ScheduleConfig | null {
    return this.map[sessionKey]?.config ?? null
  }

  async set(sessionKey: string, config: ScheduleConfig): Promise<void> {
    this.map[sessionKey] = { config, updatedAt: this.now() }
    await this.save()
  }

  /** Turns a schedule off — a key that is not there is a no-op */
  async delete(sessionKey: string): Promise<void> {
    if (!(sessionKey in this.map)) return
    delete this.map[sessionKey]
    await this.save()
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${randomUUID()}.tmp` // keeps concurrent writes from racing over the temp file
    await fs.writeFile(tmp, JSON.stringify(this.map, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
  }
}
