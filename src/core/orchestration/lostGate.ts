// The lost-worker Tasks nobody else will look after (design D6, plan ruling R16).
//
// A worker that exits unreported while no app is attached is closed by `handleExit`, and its
// `onDispatchLost` is dropped (it is FIRE_AND_FORGET with no app). The Task then stays `dispatched`
// over a lost Dispatch forever. The Host cannot read the app's journal (D8), so it cannot resume one;
// what it can do is hand the Task to a person with a Gate. Which Tasks: the ones `candidates()` names
// — the reconciler's own rule, so "lost" means one thing in both processes — **in a Run with no
// coordinator slot**. A Run with a coordinator is left to it: it sees the closed Dispatch and starts
// again with `--retry-of`.
//
// The caller decides *when* (only while the Host drives and no app is attached, N5); this decides
// *which*. Pure.
import { candidates, type LostAttemptSeed } from '../recovery/candidates'
import type { OrchState } from './state'

/** R16: the lost-worker Tasks nobody else will look after — candidates() in Runs with no coordinator. */
export function lostWithNobody(s: OrchState): LostAttemptSeed[] {
  return candidates(s).filter((seed) => {
    const run = s.runs.find((r) => r.id === seed.runId)
    return run !== undefined && !run.coordinatorSessionId
  })
}
