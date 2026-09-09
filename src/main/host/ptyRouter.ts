// One PtyFactory for the app's whole life, routing to whichever implementation is current.
//
// createCore builds SessionManager, RunManager and TerminalManager, and it runs before registerIpc —
// so before there is a Host client to talk to. Handing all three this router means the decision can be
// made later: with no Host the fallback is node-pty and the app behaves exactly as it always has,
// which is this slice's standing constraint. In practice it is made once and never unmade — `use(null)`
// has no caller outside this module's test, and `ptysOutliveApp` below says why a dropped connection
// is not a reason to make one.
import type { PtyFactory } from '../../core/sessions/pty'

export function createPtyRouter(fallback: PtyFactory): {
  factory: PtyFactory
  use(f: PtyFactory | null): void
  /** Whether a pty this router hands out now belongs to a process that outlives the app.
   *
   *  The quit path asks it (main/index.ts's will-quit). Before this slice, quitting ended every
   *  session, Run and terminal because those ptys were this process's own children; now a Host-backed
   *  one is a child of the Host, and `SessionManager.kill` reaches across the socket and ends the real
   *  process — so running that cleanup would keep the app's terminals alive only across a crash, which
   *  is the opposite of the promise (design §1).
   *
   *  **A single answer for all ptys, not one per pty.** A pty created before the Host answered went to
   *  the fallback and is still this process's child; it dies with the app whatever the quit handler
   *  does, because node-pty's master closes with the process and the child on the other end of it goes
   *  with it. So the mixed case costs nothing: leaving those alone at quit changes only whether they
   *  are killed a moment before they would have died anyway.
   *
   *  Stays true after the connection drops, deliberately. `use(null)` has no caller, so the router
   *  keeps the Host factory — and that is the right answer, because a dropped socket does not end the
   *  Host's ptys (they are exactly what a reconnect takes back). */
  ptysOutliveApp(): boolean
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
    },
    ptysOutliveApp: () => current !== null
  }
}
