// The Host's half of the roll seam (S6 R7, R14, R19): the app's own tap (core rollTap) over the Host's
// state, after the load, plus the Host's tail following a rekeyed Dispatch. Every entry point swallows
// and logs: its callers are the coordinators' send and an exit handler (constraint 11).
import { OrchRollTap } from '../core/orchestration/exec/rollTap'
import type { OrchServerDeps } from '../core/orchestration/command'
import type { RollStateEvent } from '../core/types'
import type { HostOrch } from './orch'

export interface HostRollTap {
  onRolled(oldSessionId: string, info: { id: string; accountId: string }): Promise<void>
  onRollState(e: RollStateEvent): void
}

export function createHostRollTap(d: {
  orch(): Pick<HostOrch, 'ready' | 'state' | 'internalDeps'>
  retarget(a: { dispatchId: string; sessionId: string; previousSessionId: string }): void
  log(m: string): void
  now(): string
}): HostRollTap {
  // Late-bound: the tap reads the Host's deps at each call, never a copy made before the load.
  const deps = {
    getState: () => d.orch().state(),
    setState: (s: Parameters<OrchServerDeps['setState']>[0]) => d.orch().internalDeps().setState(s),
    log: (m: string) => d.log(m),
    now: () => d.now()
  } as unknown as OrchServerDeps
  const tap = new OrchRollTap(deps)
  return {
    onRolled: async (oldSessionId, info) => {
      try {
        await d.orch().ready()
        const dispatch = await tap.onRolled(oldSessionId, info)
        if (dispatch) d.retarget({ dispatchId: dispatch.id, sessionId: info.id, previousSessionId: oldSessionId })
      } catch (err) {
        d.log(`roll tap: ${oldSessionId} -> ${info.id} failed: ${String(err)}`)
      }
    },
    onRollState: (e) => {
      void d
        .orch()
        .ready()
        .then(() => tap.onRollState(e))
        .catch((err) => d.log(`roll tap: state ${e.state} session=${e.sessionId} failed: ${String(err)}`))
    }
  }
}
