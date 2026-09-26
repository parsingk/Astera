// The app's view of the Host's rolls (S6 design §3.4): the two pushes, turned into the fan-out the app's
// own rolls make, in an order the renderer can take. The Host already rekeyed the Dispatch; this adopts
// the new session first, forwards the rekey, and only then lets the old session's exit through, so the
// old tab is replaced rather than closed.
//
// Fix round 1 (I2): "only then" also waits for the app's orchestration mirror. The Host commits its
// rekey of the Dispatch and the coordinator slot and pushes the state; the app's own exit path closes a
// Dispatch still open on the old id after EXIT_DEFER_MS. A push later than the adoption plus that window
// would let the app close the Dispatch first and the Host's rekey find it closed — so the exit is held
// until the mirror names the old id no more (rekeyed or closed), checked on every `orch-state` push and
// on a short poll, or until settleMs, after which it goes anyway and the log says so.
import type { HostMessage } from '../../core/host/protocol'
import type { OrchState } from '../../core/orchestration/state'
import type { RollStateEvent, SessionInfo } from '../../core/types'

type Exit = { sessionId: string; exitCode: number }

/** How long an exit waits for the mirror before it is delivered anyway (fix round 1, I2). */
export const HOST_ROLL_SETTLE_MS = 15_000
/** How often a waiting exit looks at the mirror between pushes. */
export const HOST_ROLL_POLL_MS = 250

export interface HostRollView {
  /** A pushed message; ignores every type but the two roll pushes and `orch-state`. Never throws. */
  pushed(m: HostMessage): void
  /** The last lasting state the Host announced for this session, or null. */
  stateOf(sessionId: string): RollStateEvent | null
  /** Whether the Host has pushed anything about this session (a roll state, or a rekey onto it or off
   *  it) — one of the two things that make `rolling.state` worth a round trip (fix round 1, 4). */
  knows(sessionId: string): boolean
  /** Whether this exit is of a session a Host roll is replacing and must wait (the ordering hold). */
  holds(sessionId: string): boolean
  /** Hands the view an exit it holds; delivered after the rekey is forwarded and the mirror moved. */
  hold(e: Exit, deliver: (e: Exit) => void): void
  /** Whether this session is being adopted as the new half of a pushed Host roll (preflight C10). */
  adopting(sessionId: string): boolean
  /** The old session id of the pushed Host roll this session is the new half of, while it is being
   *  adopted; null otherwise. */
  rolledFrom(sessionId: string): string | null
  /** The old session id of a forwarded rekey whose new session was not adopted (fix round 1, 3): its
   *  Work Unit fork was made but no note took the forkSeen. Handed out once, to the adopter. */
  takePendingFork(sessionId: string): string | null
  /** Fix round 1, M1: the chat adopter found the new half of a Host roll before its push (the sweep's
   *  proc list landed first, or no push is coming) and re-points the old tab now, forwarding the rekey
   *  as the push would. A push for the same roll that follows adopts and settles as usual and does not
   *  forward it again. `dest` is the codex copy the roll resumed onto, when the note kept it (CT-16),
   *  forwarded as the push's own `dest` is. Never throws. */
  repointed(oldSessionId: string, info: SessionInfo, dest?: string | null): void
}

export function createHostRollView(d: {
  /** Adopts the new session: its pty (ipc.ts's takeSessionsBack with that pty id) or, for a chat roll,
   *  its line process (`session-rolled.procId`, chat takeover). */
  adopt(ptyId: string | null, procId: string | null): Promise<void>
  /** The app's fan-out (index.ts fanOutRollEvent). Always without orchestration: the Host rekeyed.
   *  `renderer: false` (S6-17): a rekey whose new session the app did not adopt goes to the app's own
   *  taps but not to the renderer, which the next sweep's adopter brings up to date instead. */
  forward(
    channel: 'session:rolled' | 'session:rollState',
    payload: unknown,
    opts: { orchestration: false; renderer?: false }
  ): void
  log(m: string): void
  /** Whether the app's orchestration mirror still names this session (orchHoldsSession). Absent: never. */
  orchHolds?(sessionId: string): boolean
  /** Whether this session is one the app holds now. Absent: always, and a push's adoption then counts
   *  as done when `adopt` did not fail (S6-17). */
  isAdopted?(sessionId: string): boolean
  settleMs?: number
  pollMs?: number
}): HostRollView {
  const settleMs = d.settleMs ?? HOST_ROLL_SETTLE_MS
  const pollMs = d.pollMs ?? HOST_ROLL_POLL_MS
  const last = new Map<string, RollStateEvent>()
  const replacing = new Map<string, Array<() => void>>()
  /** New session id → the old one, while the new half is being adopted. */
  const inFlight = new Map<string, string>()
  const known = new Set<string>()
  const pendingFork = new Map<string, string>()
  /** Old session id → the check that releases its exits once the mirror moved (I2). */
  const settling = new Map<string, () => void>()
  /** New session ids whose rekey the adopter already forwarded (M1), by the old id it named. */
  const repointedBy = new Map<string, string>()
  const safe = (what: string, fn: () => void): void => {
    try {
      fn()
    } catch (err) {
      d.log(`host roll view: ${what} failed: ${String(err)}`)
    }
  }
  const release = (oldId: string): void => {
    const held = replacing.get(oldId) ?? []
    replacing.delete(oldId)
    for (const deliver of held) safe('delivering a held exit', deliver)
  }
  const orchHolds = (id: string): boolean => {
    try {
      return d.orchHolds?.(id) ?? false
    } catch (err) {
      d.log(`host roll view: the mirror could not be read for ${id}: ${String(err)}`)
      return false
    }
  }
  /** Releases now when the mirror has moved; otherwise waits on pushes and the poll, up to settleMs. */
  const settle = (oldId: string): void => {
    if (!orchHolds(oldId)) return release(oldId)
    const done = (): void => {
      clearInterval(poll)
      clearTimeout(deadline)
      settling.delete(oldId)
      release(oldId)
    }
    const check = (): void => {
      if (!orchHolds(oldId)) done()
    }
    const poll = setInterval(check, pollMs)
    const deadline = setTimeout(() => {
      d.log(`host roll view: the mirror still names ${oldId} after ${settleMs}ms — its exit goes anyway`)
      done()
    }, settleMs)
    poll.unref?.()
    deadline.unref?.()
    settling.set(oldId, check)
  }
  return {
    pushed: (m) => {
      if (m.t === 'orch-state') {
        // The mirror took this push in the listener startHostClient subscribed first; the poll covers
        // any order in which it has not yet.
        for (const check of [...settling.values()]) safe('checking the mirror', check)
        return
      }
      if (m.t === 'roll-state') {
        const e = m.event
        known.add(e.sessionId)
        if (e.state === 'none') last.delete(e.sessionId)
        else if (e.state !== 'nudged' && e.state !== 'stalled') last.set(e.sessionId, e)
        safe('forwarding a roll state', () => d.forward('session:rollState', e, { orchestration: false }))
        return
      }
      if (m.t !== 'session-rolled') return
      known.add(m.oldSessionId)
      known.add(m.info.id)
      replacing.set(m.oldSessionId, replacing.get(m.oldSessionId) ?? [])
      inFlight.set(m.info.id, m.oldSessionId)
      // Wrapped so a synchronous throw from adopt is the same failed adoption as a rejection.
      void Promise.resolve()
        .then(() => d.adopt(m.ptyId, m.procId ?? null))
        .then(
          () => true,
          (err) => {
            d.log(`host roll view: the rolled session ${m.info.id} could not be adopted first: ${String(err)}`)
            return false
          }
        )
        .then((adoptOk) => {
          // S6-17: whether the app holds the new session now. The app's own answer when it has one (a
          // sweep can resolve without adopting, or another sweep can have adopted it while this one
          // threw); otherwise whether adopt failed.
          const held = ((): boolean => {
            if (!d.isAdopted) return adoptOk
            try {
              return d.isAdopted(m.info.id)
            } catch (err) {
              d.log(`host roll view: could not tell whether ${m.info.id} was adopted: ${String(err)}`)
              return false
            }
          })()
          const was = last.get(m.oldSessionId)
          last.delete(m.oldSessionId)
          if (was) last.set(m.info.id, { ...was, sessionId: m.info.id })
          // M1: the adopter re-pointed this roll's tab already; the same rekey twice would be a second
          // Slack notice and a second fork. Once: a later roll onto this id is its own.
          if (repointedBy.get(m.info.id) === m.oldSessionId) repointedBy.delete(m.info.id)
          else
            safe('forwarding a rekey', () =>
              d.forward(
                'session:rolled',
                { oldSessionId: m.oldSessionId, info: m.info, ...(m.dest ? { dest: m.dest } : {}) },
                // Not to the renderer when the app does not hold the new session: it would re-point the
                // old tab at a session with nothing behind it, and the next sweep's adopter would then
                // announce a second tab. The old tab closes on the released exit instead.
                held ? { orchestration: false } : { orchestration: false, renderer: false }
              )
            )
          inFlight.delete(m.info.id)
          // The fan-out's forkSeen found no session to write into: the adopter writes it later.
          if (!held) pendingFork.set(m.info.id, m.oldSessionId)
          settle(m.oldSessionId)
        })
    },
    repointed: (oldId, info, dest) => {
      known.add(oldId)
      known.add(info.id)
      repointedBy.set(info.id, oldId)
      const was = last.get(oldId)
      last.delete(oldId)
      if (was) last.set(info.id, { ...was, sessionId: info.id })
      safe('forwarding a re-point', () =>
        d.forward('session:rolled', { oldSessionId: oldId, info, ...(dest ? { dest } : {}) }, { orchestration: false })
      )
    },
    stateOf: (id) => last.get(id) ?? null,
    knows: (id) => known.has(id),
    holds: (id) => replacing.has(id),
    adopting: (id) => inFlight.has(id),
    rolledFrom: (id) => inFlight.get(id) ?? null,
    takePendingFork: (id) => {
      const old = pendingFork.get(id) ?? null
      pendingFork.delete(id)
      return old
    },
    hold: (e, deliver) => {
      const q = replacing.get(e.sessionId)
      if (!q) return deliver(e)
      q.push(() => deliver(e))
    }
  }
}

/** The app's exit handler with the ordering hold in front (S6 §3.4): an exit the view holds is handed
 *  to it and re-enters here once released, when `holds` is false. */
export function withHostRollHold(view: Pick<HostRollView, 'holds' | 'hold'>, handler: (e: Exit) => void): (e: Exit) => void {
  const wrapped = (e: Exit): void => {
    if (view.holds(e.sessionId)) return view.hold(e, wrapped)
    handler(e)
  }
  return wrapped
}

/** S6-20: ipc.ts's exit wiring. One handler, with the ordering hold in front, set as the exit of every
 *  manager given (the pty manager and the chat manager: a chat session's exit has to reach the same
 *  consumers a pty's does). Handed back for callers that also call it directly. */
export function installHostRollExit(
  view: Pick<HostRollView, 'holds' | 'hold'>,
  managers: ReadonlyArray<{ onExit?: (e: Exit) => void }>,
  handler: (e: Exit) => void
): (e: Exit) => void {
  const onExit = withHostRollHold(view, handler)
  for (const m of managers) m.onExit = onExit
  return onExit
}

/** Whether the adopter announces this session to the renderer with `session:created`. Not the new half
 *  of a Host roll whose old session the app holds: the forwarded `session:rolled` re-points the old tab
 *  at it, as the app's own roll does, and a created tab beside it is a second tab for one session
 *  (Task 18 e2e, B2). Announced when the app never held the old session, since then nothing re-points a
 *  tab. */
export function announcesAdopted(
  view: Pick<HostRollView, 'rolledFrom'>,
  sessionId: string,
  appHolds: (sessionId: string) => boolean
): boolean {
  const old = view.rolledFrom(sessionId)
  return old === null || !appHolds(old)
}

/** Fix round 1, I2: whether the mirror still names this session — an open Dispatch on it (the same
 *  "open" rekeyDispatch looks for) or a coordinator slot. No mirror (orchestration never loaded) names
 *  nothing. */
export function orchHoldsSession(state: OrchState | null, sessionId: string): boolean {
  if (!state) return false
  return (
    state.dispatches.some((x) => x.sessionId === sessionId && !x.endedAt) ||
    state.runs.some((r) => r.coordinatorSessionId === sessionId)
  )
}

/** S6 final review M1: the Host's `roll-force` answer (always 200) read as whether the chain acted.
 *  `forced: false` is "nothing happened" (the chain was rolling, waiting, settling or quiet), logged
 *  with the Host's reason and not thrown: the dev hook asked for a roll and there was none to force.
 *  An older Host answered `{ forced: true }` for a no-op too, so anything but an explicit false counts
 *  as forced, as it did before. */
export function hostForced(body: unknown, sessionId: string, log: (m: string) => void): boolean {
  const b = body as { forced?: unknown; why?: unknown } | null
  if (b?.forced !== false) return true
  log(`roll-force on ${sessionId}: nothing happened (${typeof b.why === 'string' ? b.why : 'no reason given'})`)
  return false
}
