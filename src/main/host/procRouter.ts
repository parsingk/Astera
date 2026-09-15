// One ProcFactory for the app's whole life, routing to whichever implementation is current —
// createPtyRouter for line processes, and for its reasons: the Host connects after the managers are
// built, and the answer "does this process outlive the app" is per process, so it is stamped on each
// handle here where the choice is made.
import type { ProcFactory } from '../../core/sessions/proc'

export function createProcRouter(fallback: ProcFactory): {
  factory: ProcFactory
  use(f: ProcFactory | null): void
} {
  let current: ProcFactory | null = null
  return {
    factory: (file, args, opts) => {
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
