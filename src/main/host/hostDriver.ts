// The app's view of who drives Jobs, as its Host says it (limits pass L3, design A38).
//
// A Host that announced `driver` pushes a `driver` message right after the hello and on every change.
// This keeps the last one, forgets it when the connection goes (what a gone Host said is not true of
// the next one), and tells ipc.ts each change so the window's Jobs sidebar can say why a parked Host
// starts nothing. A Host that stopped answering keeps its last report: the sidebar puts not answering
// first anyway (core/orchestration/jobsView.ts's jobsStall). An older Host says nothing, and nothing
// is known.
//
// ipc.ts only wires it: the client's onMessage to `pushed`, its onStatusChange to `status`.
import { HOST_FEATURE_DRIVER, type HostMessage } from '../../core/host/protocol'
import type { HostDriverReport } from '../../core/types'

export interface HostDriverView {
  /** A Host push. Takes `driver` from a Host that announced it; everything else is ignored. Never throws. */
  pushed(m: HostMessage): void
  /** Every change of the client's status. A connection that is gone, not merely silent, forgets the
   *  report. Never throws. */
  status(s: { connected: boolean; unresponsive: boolean }): void
  current(): HostDriverReport | null
}

const DRIVERS: ReadonlyArray<HostDriverReport['driver']> = ['host', 'app', 'parked']
const GATES: ReadonlyArray<HostDriverReport['gate']> = ['no-settings', 'migrated', 'not-migrated', 'unreadable', null]

/** The report a `driver` message carries, or null when it is not one this app can read (R3). */
function reportOf(m: unknown): HostDriverReport | null {
  const o = m as { driver?: unknown; gate?: unknown }
  if (!DRIVERS.includes(o.driver as HostDriverReport['driver'])) return null
  if (!GATES.includes(o.gate as HostDriverReport['gate'])) return null
  return { driver: o.driver as HostDriverReport['driver'], gate: o.gate as HostDriverReport['gate'] }
}

export function createHostDriverView(d: {
  status(): { features: readonly string[] }
  changed(r: HostDriverReport | null): void
  log(m: string): void
}): HostDriverView {
  const log = (m: string): void => {
    try {
      d.log(m)
    } catch {
      /* nowhere to say it */
    }
  }
  let current: HostDriverReport | null = null
  const set = (next: HostDriverReport | null): void => {
    if (next?.driver === current?.driver && next?.gate === current?.gate) return
    current = next
    try {
      d.changed(next === null ? null : { ...next })
    } catch (err) {
      log(`host: the driver could not be told to the window: ${String(err)}`)
    }
  }
  return {
    pushed: (m) => {
      try {
        if (m?.t !== 'driver' || !d.status().features.includes(HOST_FEATURE_DRIVER)) return
        const r = reportOf(m)
        if (r) set(r)
        else log('host: a driver push the app cannot read was dropped')
      } catch (err) {
        log(`host: a driver push could not be read: ${String(err)}`)
      }
    },
    status: (s) => {
      try {
        if (!s.connected && !s.unresponsive) set(null)
      } catch (err) {
        log(`host: the driver could not follow a status change: ${String(err)}`)
      }
    },
    current: () => (current === null ? null : { ...current })
  }
}
