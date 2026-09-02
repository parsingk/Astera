import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { RateLimitPeak, RateLimitUsage, RateLimitWindow } from '../core/types'

/** A peak that carries its reset time. RateLimitPeak's nullable `resetsAt` is refused on the way in:
 *  §3.2 discards a reading past that instant, and with no instant there is no arithmetic to run —
 *  keeping such an entry forever would be the unbounded staleness the discard exists to prevent. */
export type DatedPeak = RateLimitPeak & { resetsAt: string }

/** One stored reading — the on-disk shape. It is AccountUsage minus `remembered` (that flag is about
 *  how the figure was obtained, which is the service's knowledge, not the file's) plus the peak,
 *  which never leaves this module and exists only so `get` can decide the window has rolled. */
export interface RememberedUsage {
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
  peak: DatedPeak
  readAt: string // ISO 8601
}

/** The file is user-editable and these values become CSS widths, so every field is narrowed on read —
 *  the same rule appSettingsStore applies to terminalFont. */
function readWindow(v: unknown): RateLimitWindow | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as { usedPercent?: unknown; resetsAt?: unknown }
  if (typeof o.usedPercent !== 'number' || !Number.isFinite(o.usedPercent)) return null
  return { usedPercent: o.usedPercent, resetsAt: typeof o.resetsAt === 'string' ? o.resetsAt : null }
}

function readPeak(v: unknown): DatedPeak | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as { percent?: unknown; resetsAt?: unknown; weekly?: unknown }
  if (typeof o.percent !== 'number' || !Number.isFinite(o.percent)) return null
  if (typeof o.resetsAt !== 'string' || !Number.isFinite(Date.parse(o.resetsAt))) return null
  return { percent: o.percent, resetsAt: o.resetsAt, weekly: o.weekly === true }
}

function readEntry(v: unknown): RememberedUsage | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as { session?: unknown; weekly?: unknown; peak?: unknown; readAt?: unknown }
  const peak = readPeak(o.peak)
  if (!peak) return null
  if (typeof o.readAt !== 'string' || !Number.isFinite(Date.parse(o.readAt))) return null
  const session = readWindow(o.session)
  const weekly = readWindow(o.weekly)
  if (!session && !weekly) return null // nothing to draw, so nothing worth remembering
  return { session, weekly, peak, readAt: o.readAt }
}

/**
 * The last successful usage reading per account (design doc §3).
 *
 * Why this exists: RateLimitFetcher reads an account's OAuth accessToken read-only and never refreshes
 * it, so only the account with a running session can be queried at all. Without a remembered reading
 * the panel would show a figure for the one account you are already using and blanks for the others —
 * the exact inverse of the point. An idle account's usage does not rise, so a stored percentage is
 * either still correct or it overstates usage because the window has partly rolled; it errs toward
 * less headroom than you have, never toward more.
 *
 * The percentages are not secrets, but the token that produced them is — and it never enters this
 * store. Only the mapped result does, exactly as the guardrail comment on RateLimitFetcher.fetch
 * requires.
 *
 * Keyed by configDir, matching RateLimitFetcher's own cache key so the two never disagree about what
 * an account is.
 *
 * Unlike AppSettingsStore there is no `.bak` copy and no `recovered` flag on a corrupt file: this is a
 * cache of figures the API will hand back again, so nothing a user typed is at stake and there is
 * nothing for a recovery notice to tell them.
 */
export class AccountUsageStore {
  private entries = new Map<string, RememberedUsage>()

  constructor(
    private filePath: string,
    private now: () => number = () => Date.now()
  ) {}

  async load(): Promise<void> {
    this.entries = new Map()
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
      // Same guard as the sibling stores — typeof [] === 'object', so an array would otherwise pass
      // straight through
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('invalid schema')
      for (const [configDir, raw] of Object.entries(parsed as Record<string, unknown>)) {
        // One malformed entry must not cost the others — an account whose figure is unreadable is
        // exactly as blank as an account that was never read, and the rest keep their meters.
        const entry = readEntry(raw)
        if (entry) this.entries.set(configDir, entry)
      }
    } catch {
      /* missing, unparseable or wrong-shaped file — an empty cache, which is the pre-first-fetch state */
    }
  }

  /** The stored reading, or null when there is none or the window it was taken in has since rolled
   *  (§3.2 — past that instant the percentage is not even a floor). */
  get(configDir: string): RememberedUsage | null {
    const entry = this.entries.get(configDir)
    if (!entry) return null
    if (Date.parse(entry.peak.resetsAt) <= this.now()) return null
    return entry
  }

  /** Only a status:'ok' result with a dated peak and at least one window is kept. An error or
   *  unavailable result leaves the previous entry standing, which is the whole point of this store. */
  async remember(configDir: string, usage: RateLimitUsage): Promise<void> {
    if (usage.status !== 'ok') return
    const peak = readPeak(usage.peak)
    if (!peak) return
    if (!usage.session && !usage.weekly) return
    this.entries.set(configDir, {
      session: usage.session,
      weekly: usage.weekly,
      peak,
      readAt: new Date(this.now()).toISOString()
    })
    await this.persist()
  }

  /** Entries `get` would already refuse are not written back — a rolled window has no reader left,
   *  and leaving it in the file would only make the next load read and drop it again. */
  private async persist(): Promise<void> {
    const data: Record<string, RememberedUsage> = {}
    for (const [configDir, entry] of this.entries) {
      if (Date.parse(entry.peak.resetsAt) <= this.now()) continue
      data[configDir] = entry
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf8')
  }
}
