// A short-lived memo around the login probe, for the rolling coordinators only.
//
// Why it exists: each chain asks `loginStatus` for every account in its roll chain on every 15-second
// tick, and the chains overlap — four chains sharing three accounts ask twelve times for three answers.
// On win32 that is a file read each; on darwin `claudeLoginProbe` can fall through to the Keychain,
// which spawns a `security` process per ask. A login does not change between two ticks often enough to
// be worth that, so the coordinators share one memo with a TTL a little under the tick.
//
// **Deliberately not applied to the IPC path.** `ipcMain.handle('accounts.loginStatus')` answers the
// renderer, which re-queries on window focus precisely because the person just went and logged in in
// another window; a cached verdict there would show them a stale marker for as long as the TTL. The
// coordinators want the opposite trade — they are running a filter, not showing a fact.
//
// Pure: no timers, no I/O of its own, and `now` is injectable, like the rest of core.

/** The verdict last resolved for an id, and when. */
interface Entry {
  at: number
  value: boolean
}

/**
 * Wraps `probe` so that repeated asks for the same id inside `ttlMs` are answered from the last
 * resolved verdict.
 *
 * Two things it deliberately does not do:
 * - **A rejection is not cached.** "We could not tell" is not a verdict, and holding it for the whole
 *   TTL would extend one failed read across every chain. The caller decides what a failure means (the
 *   coordinators read it as logged in, so a broken probe never strands a chain) and gets to decide
 *   again on the next ask.
 * - **It never de-duplicates across ids.** Each id has its own entry and its own in-flight promise.
 *
 * Concurrent misses for the same id share one call: the first stores its promise, and every caller that
 * arrives before it settles is handed that same promise rather than starting a second probe.
 */
export function memoiseLoginStatus(
  probe: (id: string) => Promise<boolean>,
  opts: { ttlMs: number; now?: () => number }
): (id: string) => Promise<boolean> {
  const now = opts.now ?? Date.now
  const cache = new Map<string, Entry>()
  const inFlight = new Map<string, Promise<boolean>>()
  return (id) => {
    const hit = cache.get(id)
    if (hit && now() - hit.at < opts.ttlMs) return Promise.resolve(hit.value)
    const flying = inFlight.get(id)
    if (flying) return flying
    const round = probe(id).then(
      (value) => {
        // Timestamped on resolution, not on the ask: a probe that took a second is worth ttlMs from the
        // moment its answer was true, and that also keeps a slow round from expiring the instant it lands.
        cache.set(id, { at: now(), value })
        inFlight.delete(id)
        return value
      },
      (err) => {
        inFlight.delete(id)
        throw err
      }
    )
    inFlight.set(id, round)
    return round
  }
}
