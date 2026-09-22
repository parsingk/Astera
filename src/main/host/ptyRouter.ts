// One PtyFactory for the app's whole life, routing to whichever implementation is current.
//
// createCore builds SessionManager, RunManager and TerminalManager, and it runs before registerIpc —
// so before there is a Host client to talk to. Handing all three this router means the decision can be
// made later: with no Host the fallback is node-pty and the app behaves exactly as it always has,
// which is this slice's standing constraint.
//
// **The decision is unmade as well as made.** It used to be made once and never unmade, on the
// reasoning that a dropped connection is no reason to route away from the Host: its ptys survive a
// dropped socket and are exactly what a reconnect takes back. That is still true of a drop, and it is
// not true of the case that turned up on 2026-09-22 — a Host still connected and no longer answering
// anything. Routing to it then sends every new session into a twenty-second wait and a dead end, so
// `use(null)` has a caller now: the status subscription in ipc.ts, which routes here whenever the Host
// is not answering and back the moment it is
// (docs/2026-09-22-host-unresponsive-recovery-design.md F1).
//
// The router used to answer "do the ptys outlive the app" for the whole app at once. It does not any
// more, because the honest answer is per pty: the Host takes a moment to start, so ptys of both kinds
// coexist. What it does instead is write the answer for each one onto the handle it hands back, and
// the quit path and the close confirmation both read that.
import type { PtyFactory } from '../../core/sessions/pty'

export function createPtyRouter(fallback: PtyFactory): {
  factory: PtyFactory
  use(f: PtyFactory | null): void
} {
  let current: PtyFactory | null = null
  return {
    factory: (file, args, opts) => {
      // Stamped here because here is the only place that knows. Both factories hand back the same
      // PtyLike, the managers store it without caring which they got, and the quit path — which has
      // to end the app's own children and leave the Host's alone — arrives long after the choice was
      // made. Writing the answer onto the handle keeps it with the pty rather than in a second map
      // that would have to be kept in step with every spawn, exit and adoption. `attach` in
      // `createHostPtyFactory` stamps its own, being the one creation path that never comes here.
      const outlivesApp = current !== null
      const p = (current ?? fallback)(file, args, opts)
      p.outlivesApp = outlivesApp
      return p
    },
    use: (f) => {
      current = f
    }
  }
}
