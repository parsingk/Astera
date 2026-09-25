// The app's half of `coordinator-idle` (final round 3, I-A). When the app drives, its fire runs the
// command layer here, but the `check --wait` calls that say a coordinator is parked are served by the
// Host, since every CLI call reaches the Host. So the app asks it, before a fire replaces a Run that has
// only its coordinator left, and before `run-coordinator-stop` stops an unfinished Run's coordinator.
//
// **Unknown, never a guess.** A Host that did not announce the feature, one that is not connected, a
// call that fails or runs out the orch-call deadline, and any answer that is not `{ idle: boolean }` all
// answer `null`, which the command layer reads as "skip". Never throws: the fire path awaits it.
import { hostSpeaksCoordinatorIdle } from './outdated'

export interface CoordinatorIdleDeps {
  /** The Host client's status, read live at each ask; null with no client. */
  status(): { connected: boolean; features: readonly string[] } | null
  /** The app's `orch-call`, which already carries the Host call deadline (ipc.ts's orchCall). */
  call(m: { cmd: string; args: Record<string, unknown>; sessionId: string }): Promise<{ status: number; body: unknown }>
  log?(m: string): void
}

export async function askHostCoordinatorIdle(
  d: CoordinatorIdleDeps,
  runId: string,
  sessionId: string
): Promise<boolean | null> {
  const status = d.status()
  if (!status || !hostSpeaksCoordinatorIdle(status)) return null
  try {
    const r = await d.call({ cmd: 'coordinator-idle', args: { runId, sessionId }, sessionId: '' })
    const idle = r.status === 200 ? (r.body as { idle?: unknown } | null)?.idle : undefined
    return typeof idle === 'boolean' ? idle : null
  } catch (e) {
    d.log?.(`coordinator-idle for run ${runId}: no answer from the Host, read as unknown (${String(e)})`)
    return null
  }
}
