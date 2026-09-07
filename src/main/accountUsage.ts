import type { Account, AccountUsage, RateLimitUsage } from '../core/types'
import { providerOf } from '../core/providers/meta'
import { TTL_OK_MS } from './usageCache'
import type { AccountUsageStore } from './accountUsageStore'

/** The tick is exactly the fetcher's own success TTL, so every tick is the first ask its cache will
 *  not serve — nothing is spent re-fetching what is already held, and nothing sits staler than the
 *  cache would have permitted anyway (design doc §4). No paced coordinator is needed: the badges
 *  slice earned one because PR checks move by the second, and this figure does not. */
const TICK_MS = TTL_OK_MS

/** What both providers' fetchers look like from here. The two differ in where the token comes from and
 *  which endpoint is asked, and in nothing this module can see. */
export interface UsageFetcher {
  get(configDir: string, maxAgeMs?: number): Promise<RateLimitUsage>
}

export interface AccountUsageDeps {
  accounts: { list(): Account[] }
  /** RateLimitFetcher, reused unchanged. It already carries the 5-minute success cache, the capped
   *  15-minute 429 back-off, and in-flight coalescing per configDir. */
  fetcher: UsageFetcher
  /** CodexUsageFetcher — the same policy against codex's own endpoint (main/codexUsage.ts). Separate
   *  rather than one fetcher that branches, because the branch is about credentials and endpoints and
   *  belongs on the provider's side of the line, not here. */
  codexFetcher: UsageFetcher
  /** Structural, not the concrete class: the service only ever calls `get` and `remember` (below).
   *  Kept narrow for the same reason readAccessToken in usage.ts is a plain function rather than a
   *  private class method — a test can hand in an in-memory double instead of a real file, because
   *  the real store's `persist()` write cannot settle inside vi.advanceTimersByTimeAsync's bounded
   *  event-loop yields. */
  store: Pick<AccountUsageStore, 'get' | 'remember'>
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
 * recovery path: the moment a session starts on that account, the CLI refreshes its token and the
 * next tick picks up a live figure. Without the repeat, an account would stay on its remembered
 * reading until the panel was remounted. That holds for both providers — `claude` and `codex` each
 * refresh the token of the account they are running on, and neither fetcher writes one.
 *
 * Both providers are asked. Codex was out of scope when this was written (§1) because the only
 * endpoint on hand was Anthropic's; codex has one of its own, answering the same two windows
 * (main/codexUsage.ts), so a codex row now draws the same meter as a claude row.
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

  /** Every registered account's configDir with the fetcher that can answer for it. The pairing is the
   *  point: the two endpoints take different credentials from different files, so a codex configDir
   *  must never reach the Anthropic fetcher or the other way round.
   *
   *  Deduplicated by configDir, because two registered accounts can share one and a directory has one
   *  usage figure. A directory shared across providers cannot happen — the two CLIs keep their own
   *  homes — so the first account's fetcher wins and there is nothing to reconcile. */
  const targets = (): Map<string, UsageFetcher> => {
    const out = new Map<string, UsageFetcher>()
    for (const a of deps.accounts.list()) {
      if (out.has(a.configDir)) continue
      out.set(a.configDir, providerOf(a) === 'codex' ? deps.codexFetcher : deps.fetcher)
    }
    return out
  }

  const usage = (): Record<string, AccountUsage> => {
    const out: Record<string, AccountUsage> = {}
    for (const configDir of targets().keys()) {
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
      // Concurrent, one request per directory. Four accounts is at most four requests per five
      // minutes, only while a panel is on screen, and the limit is counted per account token — so
      // from any one account's side the load is identical to the existing one-per-five-minutes.
      const results = await Promise.all(
        [...targets()].map(
          async ([configDir, fetcher]) =>
            [configDir, await fetcher.get(configDir).catch(() => null)] as const
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
    // tick's own failures are already handled inside it (each fetch is caught per directory) — the
    // only thing that can still escape is deps.send throwing. .catch is the last backstop so that
    // cannot become an unhandled rejection, which can terminate the process.
    if (subscribers > 0 && timer === null) timer = setInterval(() => void tick().catch(() => {}), TICK_MS)
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
      // Same backstop as the interval's tick above (see ensureTimer) — a send failure here must not
      // become an unhandled rejection either.
      void tick().catch(() => {})
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
