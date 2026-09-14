// Whether the Host this app is talking to is running an older build than the app is
// (docs/superpowers/specs/2026-09-14-host-replacement-design.md §3).
//
// The Host outlives an update — that is what it is for — and so keeps running the previous version's
// host.js until something ends it. This is the fact that tells the app there is a newer one to run,
// so it can replace the old Host the first moment doing so costs nothing (§4).
import { compareVersions } from '../updatePolicy'

/** True only when the Host's version is readable and strictly older than the app's. A version that
 *  cannot be parsed is **not** outdated: replacing a Host on a guess about what it is would be worse
 *  than leaving it. A Host newer than the app is not outdated either — after a downgrade it is the
 *  app that is behind, and that is not this rule's to fix. */
export function hostIsOutdated(hostVersion: string | null, appVersion: string): boolean {
  if (hostVersion === null) return false
  const cmp = compareVersions(hostVersion, appVersion)
  return cmp !== null && cmp < 0
}
