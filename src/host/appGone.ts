// The app-left rule (S4+S5 tidy R-m4, S6 R25, design §3A.3), one implementation for its two watchers
// (leftovers Task 1, S6-5): the driver's app-left steps (driving.ts) and the rolling's takeover (the watch
// below). They differ on purpose in one point (A69), which is a parameter here rather than a second copy:
// for the driver an app that attaches within the grace is judged by its pid (the same live pid is that app
// back, another is a new instance, and the steps run beside it); for the takeover any app that attaches
// cancels it outright, because a new instance restores the old one's chains itself, and running the
// takeover beside it would make two owners. Imports only node builtins.

/** How long a yielding app must stay gone before the Host takes up what it left (S4+S5 tidy, re-review
 *  R-m4). A socket that drops while its app lives counts as the app leaving, and that app reconnects
 *  after its first backoff (1 s, `BACKOFF_MS` in src/main/host/client.ts). Taken up at once, a repair
 *  that app was starting (a person's retry-once) would be started by both, two agents on one
 *  Dispatch, and a check it was about to settle would be killed. Long enough for the first two
 *  reconnect attempts, short beside a tick. */
export const APP_LEFT_GRACE_MS = 5000

export interface AppLeftGrace {
  /** An app left (its socket closed): a fresh grace starts, and whatever a kept app left is decided afresh. */
  left(): void
  /** An app attached. */
  attached(): void
  /** A tick. With no app attached, a kept app whose pid no longer lives is gone. */
  tick(): void
  dispose(): void
}

/** One gone decision: why, when the app left (ms, from `nowMs`), and whether an app is attached now. */
export interface AppGoneDecision { why: string; leftAt: number; appAttached: boolean }

/** **Told apart by pid**: `appPid()` is the profile's `app.pid`, falling back to the pid the app gave in its
 *  hello (`liveAppPid`), which the app writes at start and removes on a clean quit. The same live pid as when
 *  it left is the same app back (or still alive, detached), and what it left stays its own. Another pid, or
 *  none, is a new instance or a quit. A same-pid app at the end of the grace is **kept**, not dropped: it may
 *  stay detached and then quit without ever reconnecting, and a tick decides it then. */
export function createAppLeftGrace(d: {
  hasApp(): boolean
  appPid(): number | null
  /** A69: true for the takeover (an attach within the grace cancels it whatever the pid), false for the
   *  driver (an attach is judged by its pid like the grace's end). */
  attachCancels: boolean
  onGone(e: AppGoneDecision): void
  log(m: string): void
  nowMs?(): number
  graceMs?: number
  /** Test seam; defaults to setTimeout, unref'd. Answers a cancel. */
  after?(ms: number, fn: () => void): () => void
}): AppLeftGrace {
  const after =
    d.after ??
    ((ms: number, fn: () => void): (() => void) => {
      const h = setTimeout(fn, ms)
      h.unref?.()
      return () => clearTimeout(h)
    })
  const nowMs = d.nowMs ?? Date.now
  /** The grace in progress: its cancel, the pid named when the app left, and when. */
  let pending: { cancel: () => void; pid: number | null; at: number } | null = null
  /** What a same-pid app kept at the end of its grace: the pid, and when it left. */
  let kept: { pid: number; at: number } | null = null
  const gone = (why: string, at: number): void => d.onGone({ why, leftAt: at, appAttached: d.hasApp() })

  const decide = (at: 'the grace ended' | 'an app attached'): void => {
    const p = pending
    if (!p) return
    p.cancel()
    pending = null
    // The takeover never runs beside an attached app (an attach cancels it; this is the belt).
    if (d.attachCancels && d.hasApp()) return
    const now = d.appPid()
    if (p.pid !== null && now === p.pid) {
      d.log(`${at} and the app's pid still names ${now}: the same app, so what it left stays its own`)
      if (!d.hasApp()) kept = { pid: p.pid, at: p.at }
      return
    }
    gone(at === 'the grace ended' ? 'the app left and did not come back' : 'another app attached within the grace', p.at)
  }
  /** Decides kept steps again: at an attach (the same pid is that app back, and they are its own; any other
   *  pid is a new instance) and on a tick with no app attached (a `kept.pid` no longer live is that app gone). */
  const settleKept = (at: 'an app attached' | 'a tick'): void => {
    const k = kept
    if (!k) return
    const now = d.appPid()
    if (at === 'a tick' && now === k.pid) return
    kept = null
    if (now === k.pid) return
    d.log(`${at}: the app that kept what it left (pid ${k.pid}) is gone`)
    gone(at === 'a tick' ? 'a kept app quit without reconnecting' : 'another app attached after a kept app left', k.at)
  }

  return {
    left: () => {
      kept = null
      pending?.cancel()
      pending = { pid: d.appPid(), at: nowMs(), cancel: after(d.graceMs ?? APP_LEFT_GRACE_MS, () => decide('the grace ended')) }
    },
    attached: () => {
      if (d.attachCancels) {
        pending?.cancel()
        pending = null
        kept = null
        return
      }
      decide('an app attached')
      settleKept('an app attached')
    },
    tick: () => {
      if (d.hasApp()) return
      settleKept('a tick')
    },
    dispose: () => {
      pending?.cancel()
      pending = null
      kept = null
    }
  }
}

export interface AppGoneWatch { appsChanged(): void; tick(): void; dispose(): void }

/** The rolling's app-gone watch: `createAppLeftGrace` with `attachCancels`, plus preflight R13 (after a
 *  gone decision, every tick with no app attached runs the pass again, until an app attaches). */
export function createAppGoneWatch(d: {
  hasApp(): boolean
  appPid(): number | null
  onGone(why: string): void
  log(m: string): void
  graceMs?: number
  after?(ms: number, fn: () => void): () => void
}): AppGoneWatch {
  // Preflight B2: nothing is read when the watch is built (index.ts builds it before the server exists).
  // No app can be attached before the server is, and the first appsChanged sets this.
  let attached = false
  /** Set by a gone decision; while it holds, each tick with no app attached runs the pass again (R13). */
  let goneDecided = false
  const gone = (why: string): void => {
    goneDecided = true
    try {
      d.onGone(why)
    } catch (err) {
      d.log(`the takeover after ${why} failed: ${String(err)}`)
    }
  }
  const grace = createAppLeftGrace({
    hasApp: () => d.hasApp(),
    appPid: () => d.appPid(),
    attachCancels: true,
    onGone: (e) => gone(e.why),
    log: (m) => d.log(m),
    ...(d.graceMs !== undefined ? { graceMs: d.graceMs } : {}),
    ...(d.after ? { after: d.after } : {})
  })
  return {
    appsChanged: () => {
      const now = d.hasApp()
      if (now) {
        grace.attached()
        goneDecided = false
      } else if (attached) grace.left()
      attached = now
    },
    tick: () => {
      if (d.hasApp()) return
      if (goneDecided) return gone('a tick after the app left (sessions skipped before are retried)')
      grace.tick()
    },
    dispose: () => {
      grace.dispose()
      goneDecided = false
    }
  }
}
