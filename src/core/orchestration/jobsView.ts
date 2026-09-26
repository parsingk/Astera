// Which of the Jobs sidebar's four screens to draw. Renderer-safe on purpose — no `node:` import, so
// `JobsView.tsx` can import it (unlike `view.ts`, whose header says why that one is main-side only).
//
// **This is one `if` chain lifted out of the component because its order was a defect nothing could
// see** (ruling F41). The Host gate used to arrive as a field on `OrchSnapshot`, and with no project
// open the renderer substitutes a synthetic snapshot of its own — so the gate was dropped on the
// floor and a person with four dead features read "no project is open". Ordering matters here and the
// renderer has no test environment (vitest runs `environment: 'node'`), so the order lives where a
// test can hold it.
import { HOST_FEATURE_DISPATCH } from '../host/protocol'
import type { HostDriverReport, HostStatus, OrchHostGate, OrchSnapshot } from '../types'

/** `host` — the Host gate's own screen. `blank` — nothing is known yet, so nothing is drawn (drawing
 *  the empty state here flashes "no jobs" for a frame on every project switch). `empty` — a real
 *  answer of no Runs. `runs` — the list. */
export type JobsViewScreen = 'host' | 'blank' | 'empty' | 'runs'

/**
 * **The gate wins over every snapshot, including the ones that are not really snapshots.** That is
 * the rule F41 asked for: `null` (the reply has not landed), the renderer's synthetic
 * `{ runs: [], projectFolderBusy: false }` for "no project open", and a folded one alike. The two can
 * only disagree while orchestration is down, and then the gate is the only one of the two that knows
 * why — the snapshot is empty either way and says nothing.
 */
export function jobsViewScreen(a: {
  hostGate: OrchHostGate | null
  snapshot: OrchSnapshot | null
}): JobsViewScreen {
  if (a.hostGate) return 'host'
  if (a.snapshot === null) return 'blank'
  return a.snapshot.runs.length === 0 ? 'empty' : 'runs'
}

/** Why nothing in the Jobs sidebar moves, when the Host is the reason and still answers the gate
 *  above's question (limits pass L3, design A38 and A52). `parked` — the Host holds the state and will
 *  not start work, and `gate` says why. `unresponsive` — the Host is there and is not answering, so
 *  the app keeps yielding to it and no Job moves. */
export type JobsStall =
  | { kind: 'unresponsive' }
  | { kind: 'parked'; gate: 'not-migrated' | 'unreadable' }
  | { kind: 'reading' }

/** How long a parked Host with no gate read yet stays unnamed before the sidebar says it is still
 *  reading its settings (S6-11). The first read normally lands well inside it; one that hangs past it
 *  is the silence the limits pass left (A108), now named. */
export const JOBS_STALL_READING_MS = 10_000

const parkedUnread = (d: HostDriverReport | null): boolean => d?.driver === 'parked' && d.gate === null

/**
 * **Not answering comes first.** What a Host that stopped answering last said about itself is stale,
 * and the one fact that is true now is that it does not answer. **Only for a Host the app yields
 * Jobs to** (final review M1): one that announces `dispatch`, the same test the app's own
 * `hostSpeaksDispatch` makes (src/main/host/outdated.ts, which this renderer-safe file cannot import).
 * In front of a Host without it (no spawner, or an older Host) the app drives by itself, Jobs move,
 * and saying they do not would be false. A parked Host is named only with the
 * reason that parks it: a parked driver with no gate read yet is the Host's first moment (N2) and
 * lasts until its first read, so it has no reason to show. A Host that drives, an app that drives,
 * and an older Host that says nothing all draw nothing.
 *
 * **Unless that first moment lasts** (S6-11): parked with no gate read for `JOBS_STALL_READING_MS`
 * since `parkedSinceMs` (when the caller first saw that report) answers `reading`, so a first read that
 * hangs is named instead of silent. With no `parkedSinceMs` the moment is not timed and stays unnamed.
 */
export function jobsStall(a: {
  hostStatus: Pick<HostStatus, 'unresponsive' | 'features'> | null
  driver: HostDriverReport | null
  parkedSinceMs?: number | null
  nowMs?: number
}): JobsStall | null {
  if (a.hostStatus?.unresponsive === true && a.hostStatus.features.includes(HOST_FEATURE_DISPATCH)) return { kind: 'unresponsive' }
  const d = a.driver
  if (d?.driver === 'parked' && (d.gate === 'not-migrated' || d.gate === 'unreadable')) return { kind: 'parked', gate: d.gate }
  if (parkedUnread(d) && a.parkedSinceMs != null && a.nowMs !== undefined && a.nowMs - a.parkedSinceMs >= JOBS_STALL_READING_MS)
    return { kind: 'reading' }
  return null
}

/** How long until `jobsStall` could answer `reading` for this report, so the caller knows when to look
 *  again: null when it never will (not parked unread, not timed) or already does. */
export function jobsStallRecheckInMs(a: {
  driver: HostDriverReport | null
  parkedSinceMs: number | null
  nowMs: number
}): number | null {
  if (!parkedUnread(a.driver) || a.parkedSinceMs === null) return null
  const left = a.parkedSinceMs + JOBS_STALL_READING_MS - a.nowMs
  return left > 0 ? left : null
}
