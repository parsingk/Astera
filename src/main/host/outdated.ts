// Whether the Host this app is talking to is running an older build than the app is
// (docs/superpowers/specs/2026-09-14-host-replacement-design.md §3).
//
// The Host outlives an update — that is what it is for — and so keeps running the previous version's
// host.js until something ends it. This is the fact that tells the app there is a newer one to run,
// so it can replace the old Host the first moment doing so costs nothing (§4).
import { compareVersions } from '../updatePolicy'
import {
  HOST_FEATURE_PROC,
  HOST_FEATURE_PING,
  HOST_FEATURE_SPAWN,
  HOST_FEATURE_WORKTREES,
  HOST_FEATURE_DISPATCH
} from '../../core/host/protocol'

/** True only when the Host's version is readable and strictly older than the app's. A version that
 *  cannot be parsed is **not** outdated: replacing a Host on a guess about what it is would be worse
 *  than leaving it. A Host newer than the app is not outdated either — after a downgrade it is the
 *  app that is behind, and that is not this rule's to fix. */
export function hostIsOutdated(hostVersion: string | null, appVersion: string): boolean {
  if (hostVersion === null) return false
  const cmp = compareVersions(hostVersion, appVersion)
  return cmp !== null && cmp < 0
}

/** Whether the connected Host can be asked about line processes — it said so in its hello. A Host that
 *  predates the feature holds none and would only run the proc-list timer out, and an outdated Host is
 *  exactly the one the automatic replacement must still be able to replace, so this is a capability
 *  check, not an age check (chat-sessions design §6.5). */
export function hostSpeaksProcs(status: { connected: boolean; features: readonly string[] }): boolean {
  return status.connected && status.features.includes(HOST_FEATURE_PROC)
}

/** Whether the connected Host answers pings. The heartbeat in `client.ts` runs only against one that
 *  said so, which is the same capability check `hostSpeaksProcs` is and not an age check: an older
 *  Host never answers a ping, and treating that silence as a fault would call a Host that is holding
 *  a person's sessions perfectly well "unresponsive" and offer to end it
 *  (docs/2026-09-22-host-unresponsive-recovery-design.md F2). Such a Host is judged by the deadline on
 *  a request that does have an answer instead. */
export function hostSpeaksPing(status: { connected: boolean; features: readonly string[] }): boolean {
  return status.connected && status.features.includes(HOST_FEATURE_PING)
}

/** Whether the connected Host spawns orchestration sessions itself and sweeps the spec files on its
 *  own load. The same capability check as the two above: a Host that did not announce it (an older
 *  one, or one started without the CLI paths) spawns nothing, so the app keeps doing both. */
export function hostSpeaksSpawn(status: { connected: boolean; features: readonly string[] }): boolean {
  return status.connected && status.features.includes(HOST_FEATURE_SPAWN)
}

/** Whether the connected Host owns worktrees.json and runs the worktree git (host S3 ruling R3). The
 *  app writes its registry through the Host only then; otherwise (an S2 Host, or none) it writes the
 *  file itself, as it always has. */
export function hostSpeaksWorktrees(status: { connected: boolean; features: readonly string[] }): boolean {
  return status.connected && status.features.includes(HOST_FEATURE_WORKTREES)
}

/** Whether the connected Host drives Jobs itself (S4+S5 §4.2, D5): the dispatch loop, the pending
 *  reports, the resume sweep, the schedule fires, the coordinator nudges, and the validation, review and
 *  repair that follow a report. The app yields all of that to such a Host (its hello says
 *  `HOST_YIELD_DISPATCH`) and keeps doing it in front of one that did not announce it (an S3 or S2
 *  Host, or none). Read live from the status, so it changes in the same turn the handshake does.
 *
 *  **An unresponsive Host still counts** (Task 14 review I1). `markUnresponsive` sets `connected: false`
 *  but keeps the socket and the features: the Host still sees a yielding app attached and still
 *  drives, so an app that took the drive here would nudge the same coordinator twice and kill a Host
 *  validation run with no mark. Nobody drives until the Host answers again, is replaced (a new hello
 *  sets the features) or the connection drops (the close sets `unresponsive: false`, and the app
 *  drives in that same turn). That is the safe side: every spawn goes through that Host anyway. */
export function hostSpeaksDispatch(status: {
  connected: boolean
  unresponsive?: boolean
  features: readonly string[]
}): boolean {
  return (status.connected || status.unresponsive === true) && status.features.includes(HOST_FEATURE_DISPATCH)
}
