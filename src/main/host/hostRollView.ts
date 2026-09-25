// The app's view of the Host's rolls (S6 design §3.4): the two pushes, turned into the fan-out the app's
// own rolls make, in an order the renderer can take. The Host already rekeyed the Dispatch; this adopts
// the new session first, forwards the rekey, and only then lets the old session's exit through, so the
// old tab is replaced rather than closed.
import type { HostMessage } from '../../core/host/protocol'
import type { RollStateEvent } from '../../core/types'

type Exit = { sessionId: string; exitCode: number }

export interface HostRollView {
  /** A pushed message; ignores every type but the two roll pushes. Never throws. */
  pushed(m: HostMessage): void
  /** The last lasting state the Host announced for this session, or null. */
  stateOf(sessionId: string): RollStateEvent | null
  /** Whether this exit is of a session a Host roll is replacing and must wait (the ordering hold). */
  holds(sessionId: string): boolean
  /** Hands the view an exit it holds; delivered after the rekey is forwarded. */
  hold(e: Exit, deliver: (e: Exit) => void): void
  /** Whether this session is being adopted as the new half of a pushed Host roll (preflight C10). */
  adopting(sessionId: string): boolean
}

export function createHostRollView(d: {
  /** Adopts the new session's pty (ipc.ts's takeSessionsBack with that pty id). */
  adopt(ptyId: string | null): Promise<void>
  /** The app's fan-out (index.ts fanOutRollEvent, without orchestration: the Host rekeyed). */
  forward(channel: 'session:rolled' | 'session:rollState', payload: unknown): void
  log(m: string): void
}): HostRollView {
  const last = new Map<string, RollStateEvent>()
  const replacing = new Map<string, Array<() => void>>()
  const inFlight = new Set<string>()
  const safe = (what: string, fn: () => void): void => {
    try {
      fn()
    } catch (err) {
      d.log(`host roll view: ${what} failed: ${String(err)}`)
    }
  }
  return {
    pushed: (m) => {
      if (m.t === 'roll-state') {
        const e = m.event
        if (e.state === 'none') last.delete(e.sessionId)
        else if (e.state !== 'nudged' && e.state !== 'stalled') last.set(e.sessionId, e)
        safe('forwarding a roll state', () => d.forward('session:rollState', e))
        return
      }
      if (m.t !== 'session-rolled') return
      replacing.set(m.oldSessionId, replacing.get(m.oldSessionId) ?? [])
      inFlight.add(m.info.id)
      // Wrapped so a synchronous throw from adopt is the same failed adoption as a rejection.
      void Promise.resolve()
        .then(() => d.adopt(m.ptyId))
        .catch((err) => d.log(`host roll view: the rolled session ${m.info.id} could not be adopted first: ${String(err)}`))
        .then(() => {
          const was = last.get(m.oldSessionId)
          last.delete(m.oldSessionId)
          if (was) last.set(m.info.id, { ...was, sessionId: m.info.id })
          safe('forwarding a rekey', () =>
            d.forward('session:rolled', { oldSessionId: m.oldSessionId, info: m.info, ...(m.dest ? { dest: m.dest } : {}) })
          )
          inFlight.delete(m.info.id)
          const held = replacing.get(m.oldSessionId) ?? []
          replacing.delete(m.oldSessionId)
          for (const deliver of held) safe('delivering a held exit', deliver)
        })
    },
    stateOf: (id) => last.get(id) ?? null,
    holds: (id) => replacing.has(id),
    adopting: (id) => inFlight.has(id),
    hold: (e, deliver) => {
      const q = replacing.get(e.sessionId)
      if (!q) return deliver(e)
      q.push(() => deliver(e))
    }
  }
}
