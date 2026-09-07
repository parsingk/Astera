import { promises as fs } from 'node:fs'
import path from 'node:path'
import { net } from 'electron'
import type { RateLimitUsage } from '../core/types'
import { mapCodexUsageResponse } from '../core/usage/codexAccount'
import {
  ERROR_USAGE,
  parseRetryAfterMs,
  TTL_RATE_LIMITED_MS,
  UsageCache,
  type UsageAttempt
} from './usageCache'

/** The codex account-usage endpoint. `wham` is codex's own internal name for its backend and is the
 *  path the CLI actually calls — the newer alias it also carries, `/backend-api/api/codex/usage`,
 *  answers 403 from outside the CLI, so it is not a fallback worth trying. Both were read out of the
 *  installed `codex.exe` (0.151.0) together with the base URL codex's own `chatgpt_base_url` default
 *  supplies, and this one was measured answering 200 on 2026-09-04.
 *
 *  **Undocumented, like the Anthropic one above it.** If it moves, codex rows lose their meter and
 *  nothing else changes — the row already draws nothing for an account it has no reading for, and the
 *  codex limit verdict does not run on this (it reads the rollout). */
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const TIMEOUT_MS = 10_000

/** Pulls the OAuth accessToken out of a codex auth.json.
 *
 *  `auth_mode` is not consulted: an API-key login leaves `tokens` absent altogether, so it falls out
 *  here as "no token" — which is the right answer either way, because the windows this endpoint reports
 *  are a ChatGPT plan's and an API-key account has none. */
function accessTokenFrom(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { tokens?: { access_token?: unknown } }
    const token = parsed?.tokens?.access_token
    return typeof token === 'string' && token.trim() !== '' ? token : null
  } catch {
    return null
  }
}

/** Reads the accessToken for a codex configDir (CODEX_HOME), or null when there is none.
 *
 *  One file and no Keychain branch, unlike readAccessToken in usage.ts: codex writes auth.json on every
 *  platform, which is already what loginStatus.ts's codex probe keys off. A module-level function for
 *  the same reason that one is — a test can call it with a real temp file and never touch the network.
 */
export async function readCodexAccessToken(configDir: string): Promise<string | null> {
  try {
    return accessTokenFrom(await fs.readFile(path.join(configDir, 'auth.json'), 'utf8'))
  } catch {
    return null // no auth.json — not logged in on that account
  }
}

/**
 * Fetches a codex account's usage figures (5-hour and weekly) with the OAuth accessToken held in its
 * configDir. The codex counterpart of RateLimitFetcher, sharing its cache and back-off policy
 * (UsageCache) so two rows of the same list cannot be refreshed on two different schedules.
 *
 * Security guardrails — the same set RateLimitFetcher states, and for the same reasons:
 *  - the accessToken exists only inside this module (main) — what leaves is the percentage result
 *  - never logged (errors carry the status only) and never written to disk (the cache holds results only)
 *  - TLS verification stays on (net.fetch default, no bypass) with a 10-second timeout
 *  - auth.json is read-only — no refresh, no write (codex refreshes the token it is using itself), so an
 *    account left idle long enough answers 401 and the row falls back to its remembered reading
 *  - the token travels only as the Authorization header of that endpoint. Nothing else is sent: the
 *    endpoint was measured answering on the header alone, so the `chatgpt-account-id` and `originator`
 *    headers the CLI adds are left off rather than carried along untested.
 */
export class CodexUsageFetcher {
  private cache: UsageCache

  constructor(private now: () => number = () => Date.now()) {
    this.cache = new UsageCache(now)
  }

  /** Structurally identical to RateLimitFetcher.get, which is what lets the account-usage service take
   *  either one. `maxAgeMs` is honoured by the shared cache; no codex caller passes it today. */
  get(configDir: string, maxAgeMs?: number): Promise<RateLimitUsage> {
    return this.cache.get(configDir, maxAgeMs, (dir) => this.fetch(dir))
  }

  private async fetch(configDir: string): Promise<UsageAttempt> {
    const token = await readCodexAccessToken(configDir)
    if (!token) return { result: ERROR_USAGE('unavailable') }
    try {
      const res = await net.fetch(USAGE_URL, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      if (res.status === 429) {
        const ra = parseRetryAfterMs(res.headers.get('retry-after'), this.now())
        return { result: ERROR_USAGE('error'), retryAfterMs: ra ?? TTL_RATE_LIMITED_MS }
      }
      // 401 lands here: an expired token is an ordinary failure, retried on the error TTL, because
      // codex refreshes it the moment a session runs on that account.
      if (!res.ok) return { result: ERROR_USAGE('error') }
      const data = (await res.json()) as unknown
      return { result: mapCodexUsageResponse(data) }
    } catch {
      // timeout, network or parse failure — the token is never logged (the status alone is)
      return { result: ERROR_USAGE('error') }
    }
  }
}
