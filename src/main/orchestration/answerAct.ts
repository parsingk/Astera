// Answering one `orch-act` — the Host asking the app for something it cannot do itself (host control
// plane design §5).
//
// **The table is the dependency object `startOrchServer` is given**, looked up by name rather than
// copied into a second list beside it. A copy is the thing that drifts, and the decision about which
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

/**
 * Runs one action and shapes the reply the `orch-acted` message carries.
 *
 * **Every argument travels, always, as the array it arrived in.** `backup()` arrives as `[]`,
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
}): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const fn = orchActionOf(a.deps, a.act)
  if (!fn)
    return {
      ok: false,
      error: `this app cannot do ${a.act}${a.deps ? '' : ': orchestration is not running in it'}`
    }
  try {
    return { ok: true, value: await fn(...(Array.isArray(a.args) ? a.args : [])) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
