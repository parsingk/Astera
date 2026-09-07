import type { RateLimitUsage } from '../core/types'

// The caching policy shared by both providers' usage fetchers (usage.ts for claude, codexUsage.ts for
// codex). Two accounts of different providers are two rows of the same list refreshed by the same
// tick, so a second copy of these numbers would be a copy that drifts — and the reasons the numbers
// are what they are (below) apply to whichever endpoint is being asked.
//
// Extracted when the codex fetcher arrived. Only the cache shell lives here: reading credentials,
// the URL, the headers and the response mapping stay with each provider, because that is the part
// that genuinely differs.

// The account-usage service ticks at exactly this interval: every tick is then the first ask this
// cache will not serve, so nothing is spent re-fetching what is already held and nothing sits staler
// than the cache would have permitted anyway (design doc §4).
export const TTL_OK_MS = 5 * 60_000 // success cache — fresh enough for one user while staying clear of 429
const TTL_ERR_MS = 60_000 // an ordinary failure is retried after a minute
export const TTL_RATE_LIMITED_MS = 15 * 60_000 // the default backoff for a 429 that carries no Retry-After
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000 // ceiling for a hostile or corrupt Retry-After
// The absolute ceiling on a failure cache. The claude query is also the evidence the limit verdict runs
// on, and with that evidence gone the coordinator falls back to "usage unavailable" and accepts the
// screen phrase as-is — exactly the false-positive behaviour the gate exists to remove. A Retry-After
// naming a whole day cannot be allowed to switch the gate off for a day, so it is cut here. The cost is
// one extra question every 15 minutes to an endpoint that keeps answering 429.
const MAX_ERROR_TTL_MS = 15 * 60_000

interface CacheEntry {
  result: RateLimitUsage
  retryAtMs: number // before this time the cache is returned and no request is made
  storedAt: number // when this value was actually fetched — the basis for the caller's maxAgeMs test
}

/** When the entry was fetched — a missing entry counts as -Infinity so it always reads as stale */
const cachedStoredAt = (e: CacheEntry | undefined): number => (e ? e.storedAt : -Infinity)

/** Retry-After (seconds or an HTTP-date) in ms. Negative or unparseable is null; clamped to the ceiling. */
export function parseRetryAfterMs(raw: string | null, nowMs: number): number | null {
  if (!raw) return null
  const secs = Number(raw)
  if (Number.isFinite(secs)) return secs > 0 ? Math.min(secs * 1000, MAX_RETRY_AFTER_MS) : null
  const dateMs = Date.parse(raw)
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - nowMs
    return delta > 0 ? Math.min(delta, MAX_RETRY_AFTER_MS) : null
  }
  return null
}

export const ERROR_USAGE = (status: RateLimitUsage['status']): RateLimitUsage => ({
  session: null,
  weekly: null,
  maxPercent: null,
  peak: null,
  status
})

/** One attempt's outcome. `retryAfterMs` overrides the TTL the status would have chosen — it is how a
 *  429's Retry-After reaches the cache. */
export interface UsageAttempt {
  result: RateLimitUsage
  retryAfterMs?: number
}

/**
 * Cache, TTL and in-flight coalescing for a usage fetcher, keyed by configDir.
 *
 * The caller supplies the attempt; this decides whether to make one and how long to hold the answer.
 */
export class UsageCache {
  private cache = new Map<string, CacheEntry>() // key = configDir
  private inflight = new Map<string, Promise<RateLimitUsage>>()

  constructor(private now: () => number = () => Date.now()) {}

  /** maxAgeMs: a cache entry older than this is not used. Omitted, only the TTL applies. It exists for
   *  a caller that needs the value *now*, such as the limit verdict — the 5-minute TTL is fine for a
   *  status bar but fatal for a verdict, where a reading taken just below the threshold (96%, say)
   *  would reject a genuine limit 90 seconds later. The failure cache (retryAtMs) is deliberately not
   *  pierced by this argument: that one exists to back off, and piercing it would take a fresh 429 on
   *  every chunk. */
  get(
    configDir: string,
    maxAgeMs: number | undefined,
    attempt: (configDir: string) => Promise<UsageAttempt>
  ): Promise<RateLimitUsage> {
    const cached = this.cache.get(configDir)
    const fresh = maxAgeMs === undefined || this.now() - cachedStoredAt(cached) <= maxAgeMs
    if (cached && this.now() < cached.retryAtMs && (cached.result.status !== 'ok' || fresh))
      return Promise.resolve(cached.result)
    const existing = this.inflight.get(configDir)
    if (existing) return existing // coalesce concurrent calls — no duplicate API hits
    const p = this.fetchAndCache(configDir, attempt).finally(() => this.inflight.delete(configDir))
    this.inflight.set(configDir, p)
    return p
  }

  private async fetchAndCache(
    configDir: string,
    attempt: (configDir: string) => Promise<UsageAttempt>
  ): Promise<RateLimitUsage> {
    const { result, retryAfterMs } = await attempt(configDir)
    const now = this.now()
    const ttl =
      retryAfterMs ??
      (result.status === 'ok'
        ? TTL_OK_MS
        : result.status === 'unavailable'
          ? TTL_OK_MS // missing credentials rarely change — no reason to retry quickly
          : TTL_ERR_MS)
    // The failure cache is cut at MAX_ERROR_TTL_MS — a Retry-After naming a day cannot switch the gate
    // off for a day.
    const capped = result.status === 'ok' ? ttl : Math.min(ttl, MAX_ERROR_TTL_MS)
    this.cache.set(configDir, { result, retryAtMs: now + capped, storedAt: now })
    return result
  }
}
