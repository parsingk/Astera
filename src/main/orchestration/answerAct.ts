// Answering one `orch-act` — the Host asking the app for something it cannot do itself (host control
// plane design §5).
//
// **The table is the app's own `OrchServerDeps` object** (`orch.deps` in ipc.ts), looked up by name
// rather than copied into a second list beside it. A copy is the thing that drifts, and the decision about which
// names travel is not the app's to hold: it lives in the Host (`src/host/orchDeps.ts`), behind a
// typecheck-enforced guard that names anything it has not classified.
import type { OrchServerDeps } from '../../core/orchestration/command'

/** The bound function that answers `name`, or null when this app has nothing of that name.
 *
 *  A dotted name (`handoffs.save`, `sessionTasks.start`) is one of the two dependencies that are
 *  objects of methods rather than functions; nothing else nests, and nothing nests twice. Bound to
 *  its owner so a method that reads `this` still works. */
export function orchActionOf(
  deps: OrchServerDeps | null,
  name: string
): ((...args: unknown[]) => unknown) | null {
  if (!deps) return null
  const bag = deps as unknown as Record<string, unknown>
  const [head, member] = name.split('.')
  const owner = member ? (bag[head] as Record<string, unknown> | undefined) : bag
  const fn = owner?.[member ?? head]
  return typeof fn === 'function' ? (fn as (...a: unknown[]) => unknown).bind(owner) : null
}

/** The S5 starts an app that yields dispatch does not run for the Host (the m6 ruling). */
const YIELDED_STARTS: ReadonlySet<string> = new Set(['startValidation', 'startReview', 'startRepair'])

/**
 * Runs one action and shapes the reply the `orch-acted` message carries.
 *
 * **Every argument travels, always, as the array it arrived in.** `trackingEnabled()` arrives as `[]`,
 * `startWorker(x)` as `[x]`, `mergeWorktrees(cwd, paths)` as `[cwd, paths]` — and, the case that
 * settled the rule, `removeWorktrees(paths)` as `[paths]`. That last one takes a single argument that
 * is itself an array, so it goes on the wire byte-identically to a two-argument call: anything here
 * that looked at the shape to decide how to call would call one as the other. Spread, never
 * inspected.
 *
 * `ok: false` is this action's own failure, which is not the same fact as the app being unreachable —
 * the Host keeps those apart (`server.ts`'s `fromApp`) and the command that asked decides what each
 * one means. Nothing throws out of here: a rejection would leave the Host waiting for a reply that is
 * never coming.
 */
export async function answerOrchAct(a: {
  deps: OrchServerDeps | null
  act: string
  args: unknown
  /** This app yields dispatch to the Host that asked (it announced `dispatch`). Read at the ask. */
  yieldsDispatch?: boolean
}): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  // **The m6 ruling (S4+S5 Task 14).** A Host that announces `dispatch` forwards the three S5 starts to
  // the app only while it does not drive: it is parked, or retiring, or an older app keeps dispatch.
  // An app that yields dispatch does not run them then: the Task stays validating or reviewing, or its
  // repair Dispatch stays unstarted, and the Host that drives next restarts it (its handover's resume
  // sweep and repair belt, Task 12), the same way a retiring Host leaves it (Task 13). The cost if this
  // is wrong is one Task waiting for the next Host start. `repairTargetFor` answers null (below);
  // `repairOnce`, a person's retry (R20), and everything else are answered as before.
  if (a.yieldsDispatch === true && YIELDED_STARTS.has(a.act))
    return {
      ok: false,
      error: `this app yields dispatch to the Host, so it does not run ${a.act}; the Task is left for the Host that drives next`
    }
  // **And no repair target** (Task 14 review I2). `repairTargetFor` and `startRepair` switch together
  // (the HOST_DRIVES comment in src/host/orchDeps.ts): a real target here opens a repair Dispatch whose
  // start the line above then refuses, leaving it open with no worker and no Gate. Null is the Host's
  // own not-driving answer (HOST_DRIVES_FALLBACK), so the verdict lands as the repairFailed Gate a
  // person sees. Not `ok: false`: a refusal answers CONFLICT and the verdict is lost.
  if (a.yieldsDispatch === true && a.act === 'repairTargetFor') return { ok: true, value: null }
  const fn = orchActionOf(a.deps, a.act)
  if (!fn)
    return {
      ok: false,
      error: `this app cannot do ${a.act}${a.deps ? '' : ': orchestration is not running in it'}`
    }
  // **Refused rather than read as no arguments.** Anything but an array is a message this app cannot
  // make sense of — a malformed one, or a Host old enough to have put the arguments on the wire some
  // other way — and the quiet reading of it is `startWorker()` with nothing, which fails somewhere
  // further in with a sentence about a missing task id. Said here, by name, where it is still the
  // truth.
  if (!Array.isArray(a.args))
    return { ok: false, error: `${a.act} was asked for with arguments this app cannot read` }
  try {
    return { ok: true, value: await fn(...a.args) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
