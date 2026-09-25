// When the app is gone for rolling's purposes (S6 R25, design §3A.3): the driver's app-left rule
// (driving.ts `decideAppLeft`, `settleKept`) with one difference — an app that attaches within the
// grace cancels it outright, because a new instance restores the old one's chains itself, and running
// the takeover beside it would make two owners. Imports only core modules and node builtins.
import { APP_LEFT_GRACE_MS } from './driving'

export interface AppGoneWatch { appsChanged(): void; tick(): void; dispose(): void }

export function createAppGoneWatch(d: {
  hasApp(): boolean
  appPid(): number | null
  onGone(why: string): void
  log(m: string): void
  graceMs?: number
  after?(ms: number, fn: () => void): () => void
}): AppGoneWatch {
  const after =
    d.after ??
    ((ms: number, fn: () => void): (() => void) => {
      const h = setTimeout(fn, ms)
      h.unref?.()
      return () => clearTimeout(h)
    })
  // Preflight B2: nothing is read when the watch is built (index.ts builds it before the server exists).
  // No app can be attached before the server is, and the first appsChanged sets this.
  let attached = false
  let pending: { cancel: () => void; pid: number | null } | null = null
  let kept: number | null = null
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
  const decide = (): void => {
    const p = pending
    pending = null
    if (!p || d.hasApp()) return
    const now = d.appPid()
    if (p.pid !== null && now === p.pid) {
      d.log(`the grace ended and app.pid still names pid ${now}: the same app, so its sessions stay its own`)
      kept = p.pid
      return
    }
    gone('the app left and did not come back')
  }
  return {
    appsChanged: () => {
      const now = d.hasApp()
      if (now) {
        pending?.cancel()
        pending = null
        kept = null
        goneDecided = false
      } else if (attached) {
        pending?.cancel()
        kept = null
        const pid = d.appPid()
        pending = { pid, cancel: after(d.graceMs ?? APP_LEFT_GRACE_MS, decide) }
      }
      attached = now
    },
    tick: () => {
      if (d.hasApp()) return
      if (goneDecided) return gone('a tick after the app left (sessions skipped before are retried)')
      if (kept === null) return
      if (d.appPid() === kept) return
      d.log(`the app that kept its sessions (pid ${kept}) is gone`)
      kept = null
      gone('a kept app quit without reconnecting')
    },
    dispose: () => {
      pending?.cancel()
      pending = null
      kept = null
      goneDecided = false
    }
  }
}
