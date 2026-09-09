// One PtyFactory for the app's whole life, routing to whichever implementation is current.
//
// createCore builds SessionManager, RunManager and TerminalManager, and it runs before registerIpc —
// so before there is a Host client to talk to. Handing all three this router means the decision can be
// made later: with no Host the fallback is node-pty and the app behaves exactly as it always has,
// which is this slice's standing constraint. In practice it is made once and never unmade — `use(null)`
// has no caller outside this module's test, and a dropped connection is not a reason to call it: the
// Host's ptys survive a dropped socket, and are exactly what a reconnect takes back.
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
