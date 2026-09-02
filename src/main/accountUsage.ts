import type { Account, AccountUsage, RateLimitUsage } from '../core/types'
import { providerOf } from '../core/providers/meta'
import { TTL_OK_MS } from './usage'
import type { AccountUsageStore } from './accountUsageStore'

/** The tick is exactly the fetcher's own success TTL, so every tick is the first ask its cache will
 *  not serve — nothing is spent re-fetching what is already held, and nothing sits staler than the
 *  cache would have permitted anyway (design doc §4). No paced coordinator is needed: the badges
 *  slice earned one because PR checks move by the second, and this figure does not. */
const TICK_MS = TTL_OK_MS

export interface AccountUsageDeps {
  accounts: { list(): Account[] }
  /** RateLimitFetcher, reused unchanged. It already carries the 5-minute success cache, the capped
   *  15-minute 429 back-off, and in-flight coalescing per configDir. */
  fetcher: { get(configDir: string, maxAgeMs?: number): Promise<RateLimitUsage> }
  store: AccountUsageStore
  send: (channel: 'usage:accounts-updated', payload: Record<string, AccountUsage>) => void
}

export interface AccountUsageService {
  usage(): Record<string, AccountUsage>
  subscribe(): void
  unsubscribe(): void
  stop(): void
  tick(): Promise<void>
}

/**
 * Per-account usage for the account rows (design doc §4). Owns nothing about display — it fetches,
 * remembers what succeeded, and pushes the map; the rows draw it.
 *
 * An idle account fails its request every time (§3), which looks like waste and is actually the
 * recovery path: the moment a session starts on that account, `claude` refreshes its token and the
 * next tick picks up a live figure. Without the repeat, an account would stay on its remembered
 * reading until the panel was remounted.
 */
export function createAccountUsage(deps: AccountUsageDeps): AccountUsageService {
  // The configDirs whose most recent attempt actually reached the API and produced a reading the
  // store kept. Everything else the store answers for is a remembered reading, and the row dims it.
  // "The last try failed" is the exact fact; comparing readAt against a clock would only be a guess
  // at it, and would make a row flicker as a reading crossed the boundary.
  let live = new Set<string>()
  let subscribers = 0
  let timer: NodeJS.Timeout | null = null
  let inFlight = false

  /** Codex accounts are skipped outright: this endpoint is Anthropic's, codex usage is out of scope
   *  (§1), and a codex configDir must not be sent to it at all. Deduplicated because two registered
   *  accounts can share a configDir and one directory has one usage figure. */
  const claudeDirs = (): string[] => [
    ...new Set(
      deps.accounts
        .list()
        .filter((a) => providerOf(a) === 'claude')
        .map((a) => a.configDir)
    )
  ]

  const usage = (): Record<string, AccountUsage> => {
    const out: Record<string, AccountUsage> = {}
    for (const configDir of claudeDirs()) {
      // The store is the memory — a live reading was written to it on the tick that fetched it, so
      // there is no second in-memory map to keep in step with it. An account with nothing to show is
      // simply absent, which is what the row reads as "draw nothing" (§5).
      const entry = deps.store.get(configDir)
      if (!entry) continue
      out[configDir] = {
        session: entry.session,
        weekly: entry.weekly,
        readAt: entry.readAt,
        remembered: !live.has(configDir)
      }
    }
    return out
  }

  async function tick(): Promise<void> {
    if (inFlight) return
    inFlight = true
    try {
      const dirs = claudeDirs()
      // Concurrent, one request per directory. Four accounts is at most four requests per five
      // minutes, only while a panel is on screen, and the limit is counted per account token — so
      // from any one account's side the load is identical to the existing one-per-five-minutes.
      const results = await Promise.all(
        dirs.map(
          async (configDir) =>
            [configDir, await deps.fetcher.get(configDir).catch(() => null)] as const
        )
      )
      const nextLive = new Set<string>()
      for (const [configDir, result] of results) {
        if (!result || result.status !== 'ok') continue
        await deps.store.remember(configDir, result)
        // 'ok' does not mean stored: remember() refuses a reading it cannot date (§3.2). Only an
        // entry the store actually kept counts as live, or the row would draw an undimmed figure
        // with nothing behind it.
        if (deps.store.get(configDir)) nextLive.add(configDir)
      }
      live = nextLive
      deps.send('usage:accounts-updated', usage())
    } finally {
      inFlight = false
    }
  }

  const ensureTimer = (): void => {
    if (subscribers > 0 && timer === null) timer = setInterval(() => void tick(), TICK_MS)
  }
  const dropTimer = (): void => {
    if (subscribers === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  return {
    usage,
    subscribe(): void {
      subscribers += 1
      ensureTimer()
      // The mount fetch (§4). Fired here rather than left to the first interval, which is five
      // minutes away — a panel that has just opened must not sit on a stale figure that long. The
      // fetcher's cache absorbs the cost when a second panel mounts moments later.
      void tick()
    },
    unsubscribe(): void {
      subscribers = Math.max(0, subscribers - 1)
      dropTimer()
    },
    stop(): void {
      subscribers = 0
      dropTimer()
    },
    tick
  }
}
