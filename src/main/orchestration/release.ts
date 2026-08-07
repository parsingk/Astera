// The state lookup worker-release needs.
//
// The server hands the coordinator only a dispatchId. The coordinator never reads OrchState at all
// (the server owns the state), so the wiring has to pull the material for the "may this session be
// closed" decision out of the state and pass it in. That computation is this function — inside the
// registerIpc closure it could not be tested without Electron, so it was lifted out.
import type { Dispatch } from '../../core/orchestration/types'

/** The argument OrchCoordinator.releaseWorker takes. null for an unknown dispatch (no session to close) */
export function releaseArgsFor(
  dispatches: Dispatch[],
  dispatchId: string
): { sessionId: string; retained: boolean; isLatestOwner: boolean } | null {
  const d = dispatches.find((x) => x.id === dispatchId)
  if (!d) return null
  // Several Dispatches can use one session in turn (worker-start --terminal reuse). Only the
  // **last opened** Dispatch owns that session, so closing it from any other one kills someone
  // else's worker — section 8 of the orchestration guide: only the session that Dispatch owns is
  // closed, and a reused session is preserved.
  //
  // Why array order decides it: openDispatch (state.ts) always appends, so array order is creation
  // order. Comparing startedAt (an ISO string) ties for two Dispatches opened in the same
  // millisecond and loses the order. (openDispatch already rejects a duplicate sessionId among
  // open dispatches, so at most one Dispatch is open on a given session — what lands here is the
  // "already-closed A + reused, open B" combination.)
  const owners = dispatches.filter((x) => x.sessionId === d.sessionId)
  return {
    sessionId: d.sessionId,
    retained: d.retained,
    isLatestOwner: owners[owners.length - 1]?.id === d.id
  }
}
