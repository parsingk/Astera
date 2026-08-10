import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { net } from 'electron'
import type { RateLimitUsage } from '../core/types'
import { mapUsageResponse } from '../core/usage/rateLimit'
import {
  claudeKeychainServicesFor,
  keychainAccount,
  makeSecurityKeychainRead,
  type KeychainRead
} from '../core/accounts/keychain'

// The same endpoint/header contract as Orca's claude-fetcher.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const BETA_HEADER = 'oauth-2025-04-20'
const USER_AGENT = 'claude-code/2.1'
const TIMEOUT_MS = 10_000
const TTL_OK_MS = 5 * 60_000 // success cache — fresh enough for one user while staying clear of 429
const TTL_ERR_MS = 60_000 // an ordinary failure is retried after a minute
const TTL_RATE_LIMITED_MS = 15 * 60_000 // the default backoff for a 429 that carries no Retry-After
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000 // ceiling for a hostile or corrupt Retry-After
// The absolute ceiling on a failure cache. This query is now the evidence the limit verdict runs on, and
// with that evidence gone the coordinator falls back to "usage unavailable" and accepts the screen
// phrase as-is — exactly the false-positive behaviour the gate exists to remove. A Retry-After naming a
// whole day cannot be allowed to switch the gate off for a day, so it is cut here. The cost is one extra
// question every 15 minutes to an endpoint that keeps answering 429.
const MAX_ERROR_TTL_MS = 15 * 60_000

interface CacheEntry {
  result: RateLimitUsage
  retryAtMs: number // before this time the cache is returned and no request is made
  storedAt: number // when this value was actually fetched — the basis for the caller's maxAgeMs test
}

/** When the entry was fetched — a missing entry counts as -Infinity so it always reads as stale */
const cachedStoredAt = (e: CacheEntry | undefined): number => (e ? e.storedAt : -Infinity)

/** Retry-After (seconds or an HTTP-date) in ms. Negative or unparseable is null; clamped to the ceiling. */
function parseRetryAfterMs(raw: string | null, nowMs: number): number | null {
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

const ERROR_USAGE = (status: RateLimitUsage['status']): RateLimitUsage => ({
  session: null,
  weekly: null,
  maxPercent: null,
  status
})

/** Runs `security(1)` and hands back stdout, or null on any failure (missing binary, non-zero exit,
 *  timeout). The counterpart to descriptor.ts's runSecurity, which discards stdout and returns only
 *  the exit code — that one is for existence checks (KeychainHas), this one is for reading the secret
 *  itself (KeychainRead). Kept separate rather than shared because the two have incompatible return
 *  shapes and descriptor.ts is out of scope for this change. */
function runSecurityRead(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 5_000 }, (err, stdout) => {
      resolve(err ? null : stdout)
    })
  })
}

/** Pulls the OAuth accessToken out of a claude credentials payload. The Keychain item and
 *  .credentials.json carry the identical shape (measured on an installed claude 2.1.224 binary via
 *  `security find-generic-password -a "$USER" -s "Claude Code-credentials" -w`), so one parser serves
 *  both sources. */
function accessTokenFrom(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } }
    const token = parsed?.claudeAiOauth?.accessToken
    return typeof token === 'string' && token.trim() !== '' ? token : null
  } catch {
    return null
  }
}

/**
 * Reads the OAuth accessToken for an account's configDir — file first, Keychain second.
 *
 * Order matters, and for the same reason as loginStatus.ts's claudeLoginProbe: (1) environments that
 * still write .credentials.json (older claude versions, or CLAUDE_CODE-related settings) keep working
 * unchanged, and (2) the Keychain service-name convention (keychain.ts) is an observed convention, not
 * a documented contract, so the file path staying alive is what keeps this from failing outright if it
 * drifts. Off darwin the Keychain is never consulted, at all — `security` doesn't exist there anyway,
 * and Windows/Linux users who lack the file are exactly as unavailable as before this change.
 *
 * This is a module-level function rather than a private method on RateLimitFetcher, deliberately —
 * the same shape as statusline.ts's resolveNodePath. RateLimitFetcher.fetch talks to the network
 * (net.fetch), which a unit test has no business exercising; keeping the branching logic here, taking
 * its dependencies as plain arguments, lets a test call it directly with fakes instead of reaching into
 * the class's private surface or standing up a network mock just to reach one `if`.
 */
export async function readAccessToken(
  configDir: string,
  platform: NodeJS.Platform,
  homeDir: string,
  account: string,
  keychainRead: KeychainRead
): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(configDir, '.credentials.json'), 'utf8')
    const token = accessTokenFrom(raw)
    if (token) return token
  } catch {
    /* missing file — on darwin that is the normal case, fall through to the keychain */
  }
  if (platform !== 'darwin') return null
  for (const service of claudeKeychainServicesFor(configDir, homeDir)) {
    const raw = await keychainRead(service, account)
    if (raw) {
      const token = accessTokenFrom(raw)
      if (token) return token
    }
  }
  return null
}

/**
 * Fetches the Anthropic usage figures (5-hour and weekly) with the OAuth accessToken held in an
 * account's configDir.
 *
 * Security guardrails:
 *  - the accessToken exists only inside this class (main) — what leaves is the percentage result
 *  - never logged (errors carry the status only) and never written to disk (the cache holds results only)
 *  - TLS verification stays on (net.fetch default, no bypass) with a 10-second timeout
 *  - .credentials.json is read-only — no refresh, no write (claude refreshes the active account's token)
 *  - on darwin, the macOS Keychain fallback (readAccessToken below) is read-only too — `security` is
 *    never invoked with anything that writes or deletes an item — and that token likewise never leaves
 *    this class; it is folded into the same Authorization header as the file-sourced one
 *  - the token travels only as the Authorization header of the OAuth endpoint
 */
export class RateLimitFetcher {
  private cache = new Map<string, CacheEntry>() // key = configDir
  private inflight = new Map<string, Promise<RateLimitUsage>>()

  constructor(
    private now: () => number = () => Date.now(),
    private platform: NodeJS.Platform = process.platform,
    private homeDir: string = os.homedir(),
    private account: string = keychainAccount({ USER: process.env.USER }, os.userInfo().username),
    private keychainRead: KeychainRead = makeSecurityKeychainRead(runSecurityRead)
  ) {}

  /** maxAgeMs: a cache entry older than this is not used. Omitted, only the TTL applies, as before.
   *  It exists for a caller that needs the value *now*, such as the limit verdict — the 5-minute TTL is
   *  fine for a status bar but fatal for a verdict, where a reading taken just below the threshold
   *  (96%, say) would reject a genuine limit 90 seconds later. The failure cache (retryAtMs) is
   *  deliberately not pierced by this argument: that one exists to back off, and piercing it would take
   *  a fresh 429 on every chunk. */
  async get(configDir: string, maxAgeMs?: number): Promise<RateLimitUsage> {
    const cached = this.cache.get(configDir)
    const fresh = maxAgeMs === undefined || this.now() - cachedStoredAt(cached) <= maxAgeMs
    if (cached && this.now() < cached.retryAtMs && (cached.result.status !== 'ok' || fresh))
      return cached.result
    const existing = this.inflight.get(configDir)
    if (existing) return existing // coalesce concurrent calls — no duplicate API hits
    const p = this.fetchAndCache(configDir).finally(() => this.inflight.delete(configDir))
    this.inflight.set(configDir, p)
    return p
  }

  private async fetchAndCache(configDir: string): Promise<RateLimitUsage> {
    const { result, retryAfterMs } = await this.fetch(configDir)
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

  private async fetch(
    configDir: string
  ): Promise<{ result: RateLimitUsage; retryAfterMs?: number }> {
    const token = await readAccessToken(
      configDir,
      this.platform,
      this.homeDir,
      this.account,
      this.keychainRead
    )
    if (!token) return { result: ERROR_USAGE('unavailable') }
    try {
      const res = await net.fetch(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': BETA_HEADER,
          'User-Agent': USER_AGENT
        },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      if (res.status === 429) {
        const ra = parseRetryAfterMs(res.headers.get('retry-after'), this.now())
        return { result: ERROR_USAGE('error'), retryAfterMs: ra ?? TTL_RATE_LIMITED_MS }
      }
      if (!res.ok) return { result: ERROR_USAGE('error') }
      const data = (await res.json()) as unknown
      return { result: mapUsageResponse(data) }
    } catch {
      // timeout, network or parse failure — the token is never logged (the status alone is)
      return { result: ERROR_USAGE('error') }
    }
  }
}
