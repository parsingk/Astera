/**
 * Update campaigns.
 *
 * A `policy.json` published alongside a release names a **target version range**, and apps whose
 * version falls inside it get notified. `minVersion` is the floor of the target range, not a
 * blocking floor — bounds are inclusive, and the usual deployment sets `min == max` to single out
 * one defective build.
 *
 * There are two modes: `notify` (default, a dismissible notice) and `block` (the app refuses to
 * run). `block` exists for the case where a release must not stay in circulation.
 *
 * **Every failure path here falls back to "no campaign".** Blocking or nagging a user because of a
 * malformed policy file or a network hiccup is worse than letting them stay on an older build.
 *
 * No dependencies are used: neither `semver` nor `js-yaml` is in our dependencies, and reaching for
 * a transitive one gets it dropped at packaging time, which kills the app on launch.
 */

export type UpdateCampaignMode = 'notify' | 'block'

export type UpdateCampaign = {
  id: string
  minVersion?: string
  maxVersion?: string
  mode: UpdateCampaignMode
}

/** How often the app checks for updates on its own. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
/** Delay before the first retry after a failed check. */
export const RETRY_BASE_MS = 60 * 60 * 1000
/** Backoff ceiling — keeps a permanently broken feed from being hit every hour forever. */
export const RETRY_MAX_MS = 6 * 60 * 60 * 1000

/** Three-part semver only; our releases do not use pre-release identifiers. */
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/

/**
 * Builds the policy URL from the packaged `app-update.yml`. electron-builder generates that file
 * from `electron-builder.yml`, which makes it the single source of truth for where releases live —
 * the owner and repo are never duplicated in code.
 *
 * `releases/latest/download/<asset>` always resolves to the newest release, so the app reads the
 * current policy without knowing any version. Returns null in dev, or whenever the file does not
 * describe a GitHub repo, and the caller then skips the policy lookup entirely.
 */
export function parsePolicyUrl(appUpdateYml: string): string | null {
  const owner = /^owner:\s*(\S+)\s*$/m.exec(appUpdateYml)?.[1]
  const repo = /^repo:\s*(\S+)\s*$/m.exec(appUpdateYml)?.[1]
  if (!owner || !repo) return null
  return `https://github.com/${owner}/${repo}/releases/latest/download/policy.json`
}

/** Negative if a<b, 0 if equal, positive if a>b. null when either side is malformed (undecidable). */
export function compareVersions(a: string, b: string): number | null {
  const left = VERSION_RE.exec(a)
  const right = VERSION_RE.exec(b)
  if (!left || !right) return null
  for (let i = 1; i <= 3; i++) {
    const diff = Number(left[i]) - Number(right[i])
    if (diff !== 0) return diff
  }
  return 0
}

/** Whether the app version falls inside the target range (inclusive). Malformed means "not targeted". */
export function versionMatchesRange(
  appVersion: string,
  range: { minVersion?: string; maxVersion?: string }
): boolean {
  if (range.minVersion !== undefined) {
    const cmp = compareVersions(appVersion, range.minVersion)
    if (cmp === null || cmp < 0) return false
  }
  if (range.maxVersion !== undefined) {
    const cmp = compareVersions(appVersion, range.maxVersion)
    if (cmp === null || cmp > 0) return false
  }
  return true
}

function parseMode(value: unknown): UpdateCampaignMode {
  // Falls back to notify so a typo (BLOCK, kill, ...) can never lock a user out.
  return value === 'block' ? 'block' : 'notify'
}

function optionalVersion(value: unknown): { ok: true; value?: string } | { ok: false } {
  if (value === undefined) return { ok: true }
  if (typeof value !== 'string' || !VERSION_RE.test(value)) return { ok: false }
  return { ok: true, value }
}

/** Policy JSON to campaign. null when the schema, range, or version format is off. */
export function parsePolicy(raw: string): UpdateCampaign | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null

  const { id, minVersion, maxVersion, mode } = parsed as Record<string, unknown>
  if (typeof id !== 'string' || !id.trim()) return null

  const min = optionalVersion(minVersion)
  const max = optionalVersion(maxVersion)
  if (!min.ok || !max.ok) return null
  // With no range at all every version is targeted, which is always a mistake rather than an
  // intent — so it is not accepted as a campaign.
  if (min.value === undefined && max.value === undefined) return null
  if (min.value !== undefined && max.value !== undefined) {
    const cmp = compareVersions(min.value, max.value)
    if (cmp === null || cmp > 0) return null
  }

  return {
    id: id.trim(),
    ...(min.value !== undefined ? { minVersion: min.value } : {}),
    ...(max.value !== undefined ? { maxVersion: max.value } : {}),
    mode: parseMode(mode)
  }
}

/** Whether to apply this campaign to this app. A campaign the user dismissed never comes back. */
export function shouldApplyCampaign(args: {
  campaign: UpdateCampaign | null
  appVersion: string
  dismissedId: string | null
}): boolean {
  const { campaign, appVersion, dismissedId } = args
  if (!campaign) return false
  if (campaign.id === dismissedId) return false
  return versionMatchesRange(appVersion, campaign)
}

/**
 * Delay until the next automatic check. A completed check resets the failure count, returning to the
 * 24-hour cadence; accumulated failures double from 1h and stop at 6h.
 */
export function nextCheckDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return CHECK_INTERVAL_MS
  return Math.min(RETRY_BASE_MS * 2 ** (consecutiveFailures - 1), RETRY_MAX_MS)
}

/**
 * Fetches the policy. Releases are public, so no credentials are involved. `fetchFn` is a parameter
 * for the same reason `WebhookTransport` takes one — tests swap in a stub.
 */
export async function loadPolicy(
  policyUrl: string,
  fetchFn: typeof fetch
): Promise<UpdateCampaign | null> {
  try {
    const res = await fetchFn(policyUrl)
    if (!res.ok) return null
    return parsePolicy(await res.text())
  } catch {
    return null
  }
}
