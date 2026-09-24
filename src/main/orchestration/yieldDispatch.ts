// The app's side of yielding dispatch to a Host that drives (S4+S5 Task 14; §4.2, §5.1, D5, N3, R25).
//
// ipc.ts's bootOrch holds the one predicate, `hostDrives()` (N8): the connected Host announced
// `dispatch` (`hostSpeaksDispatch`). It is read at every call, never cached, so the switch happens in
// the same turn the Host's status changes (F58): there is no window where the app and the Host both
// start work. The seams below are what that predicate chooses between, pulled out of ipc.ts so a test
// can call them; each takes the predicate's answer as an argument rather than asking for it itself.
import type { DispatchLoop } from '../../core/orchestration/exec/dispatchLoop'

/** How long the stop button waits on `validation-stop` before it degrades (§5.1). */
export const HOST_STOP_BOUND_MS = 2000

/**
 * The body of the app's 15-second orchestration timer.
 *
 * - Orchestration not serving: the arming is dropped (the reason is `forgetArming`'s).
 * - **A Host that drives (N3)**: the Host fires the schedules and nudges the coordinators, so the app
 *   does neither; it only **arms** (`armOnly`, firesDue's arm half). `orchSnapshotOf` reads the
 *   sidebar's next-fire time off that arming (`nextFireOf`), so without it the time would freeze at
 *   the last one the app computed. It also means a Host that goes away hands the app an arming that is
 *   already past every time the Host fired, so the app's first fire after it is not a burst.
 * - Otherwise (an S3 or S2 Host, or none, D5): fire and nudge, as the app always has.
 *
 * Never throws: it runs inside a `setInterval` in the main process.
 */
export function appTimerTick(
  loop: Pick<DispatchLoop, 'forgetArming' | 'armOnly' | 'fireTick' | 'nudge'>,
  a: { serving: boolean; hostDrives: boolean; log(m: string): void }
): void {
  try {
    if (!a.serving) {
      loop.forgetArming()
      return
    }
    if (a.hostDrives) {
      loop.armOnly()
      return
    }
  } catch (e) {
    a.log(`schedule arming failed: ${String(e)}`)
    return
  }
  void loop.fireTick().catch((e) => a.log(`fire tick failed: ${String(e)}`))
  void loop.nudge().catch((e) => a.log(`nudge failed: ${String(e)}`))
}

/**
 * The run panel's stop button (§5.1; the Task 9 and Task 10 carries).
 *
 * A person stopping a validation run means "could not prove it", not "the work is wrong", so the run
 * is marked stopped before it is killed and its exit goes to a Gate rather than being settled as a
 * failure (TaskValidator.markStopped). **Who marks is whoever started it.**
 *
 * - **While the Host drives**, a validation run is the Host's validator's. The stop goes to the Host as
 *   `validation-stop`, which marks the run and kills it, in that order. The app must **not** kill it as
 *   well: a kill from here can land before the Host's mark, and the Host would then read the exit as a
 *   real failed check (a repair opened, one fix attempt spent) instead of "not proven".
 * - An answer of `stopped: false` means the Host did not start that run (the app's own validator did,
 *   before the Host drove): it is stopped the app's way.
 * - A 501 (a Host that runs no validations), any other failure, or no answer within
 *   `HOST_STOP_BOUND_MS` is logged, and the app marks and kills the run itself, so the button always
 *   stops it. After a 501 the run is the app's own, so its mark holds ("not proven"); after a failure or
 *   no answer the run may be the Host's, and the stop degrades to §5.1's "exit read as a result".
 * - Not driving (an S3 or S2 Host, or none, D5), or an ordinary run: as before.
 */
export async function stopRunFromPanel(a: {
  runId: string
  isValidation: boolean
  hostDrives: boolean
  askHost(runId: string): Promise<{ status: number; body: unknown }>
  markStopped(runId: string): void
  stop(runId: string): void
  log(m: string): void
  boundMs?: number
}): Promise<void> {
  if (a.isValidation && a.hostDrives) {
    const answer = await bounded(a.askHost(a.runId), a.boundMs ?? HOST_STOP_BOUND_MS)
    if (answer.kind === 'answered' && answer.reply.status === 200) {
      if ((answer.reply.body as { stopped?: unknown } | null)?.stopped === true) return
    } else
      a.log(
        `validation-stop run=${a.runId} ${
          answer.kind === 'answered'
            ? `was answered ${answer.reply.status} ${JSON.stringify(answer.reply.body)}`
            : answer.kind === 'failed'
              ? `failed: ${answer.error}`
              : `had no answer within ${a.boundMs ?? HOST_STOP_BOUND_MS} ms`
        } — ${
          answer.kind === 'answered'
            ? // A non-200 (a 501 from a Host that runs no validations): that Host started no check, so
              // the run is this app's own, and the app's mark below makes its exit read as "not proven".
              'the app marks and stops the run itself'
            : // No answer: the run may be the Host's, whose validator then reads the exit as a result.
              'the app stops the run itself; if the Host started it, the Host reads its exit as a result'
        }`
      )
  }
  if (a.isValidation) a.markStopped(a.runId)
  a.stop(a.runId)
}

type Bounded<T> = { kind: 'answered'; reply: T } | { kind: 'failed'; error: string } | { kind: 'timeout' }

function bounded<T>(p: Promise<T>, ms: number): Promise<Bounded<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'timeout' }), ms)
    p.then(
      (reply) => {
        clearTimeout(timer)
        resolve({ kind: 'answered', reply })
      },
      (err) => {
        clearTimeout(timer)
        resolve({
          kind: 'failed',
          error: err instanceof Error ? err.message : String(err)
        })
      }
    )
  })
}

/**
 * `OrchServerDeps.discardRunWorktree` for the app (R25, the S3 carry 3), so run-start's cleanup of a
 * fresh Run worktree whose coordinator failed to start takes the same branch in both processes.
 * `reapWorktree` is the app's in-use-checked removal, and its `false` means "not removed" for **any**
 * reason (in use, a git failure, a folder it would not touch), so this never claims `inUse` and the
 * 400 says the folder "could not be removed" (C7).
 */
export function appDiscardRunWorktree(
  reap: (path: string) => Promise<boolean>
): (path: string) => Promise<{ removed: boolean; inUse: boolean }> {
  return async (p) => ({ removed: await reap(p), inUse: false })
}
