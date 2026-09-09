// One PtyFactory for the app's whole life, routing to whichever implementation is current.
//
// createCore builds SessionManager, RunManager and TerminalManager, and it runs before registerIpc —
// so before there is a Host client to talk to. Handing all three this router means the decision can
// be made later, and unmade: with no Host the fallback is node-pty and the app behaves exactly as it
// always has, which is this slice's standing constraint.
import type { PtyFactory } from '../../core/sessions/pty'

export function createPtyRouter(fallback: PtyFactory): {
  factory: PtyFactory
  use(f: PtyFactory | null): void
} {
  let current: PtyFactory | null = null
  return {
    factory: (file, args, opts) => (current ?? fallback)(file, args, opts),
    use: (f) => {
      current = f
    }
  }
}
