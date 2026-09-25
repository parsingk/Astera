// The unattended permission policy (chat takeover Task 7, spec C3): under `deny-after-60s`, an approval
// the Host holds as a session's writer is denied once 60 s passed with nobody able to answer it in the
// app. Under `hold`, the default, it waits for someone (the app, or `astera chats answer`).
//
// P12: the 60 s count from when the Host became the writer of an open prompt, so a review on a writer
// change arms from then. P6: approvals only, a question is never denied. Review Focus 4: every
// condition is asked again at the fire, so an app that attached at 59 s (or a prompt answered
// elsewhere, or listed answered in the note) stops the deny even when no review ran in between.
//
// Imports nothing outside core and this folder: this bundles into the Host.
import type { ChatRequest, UnattendedPermission } from '../core/chat/types'

export const UNATTENDED_DENY_MS = 60_000

/** What the CLI, and so the model, is told with an unattended deny (chat takeover e2e E2). The encoder's
 *  own text says a person declined, which nobody did here. */
export const UNATTENDED_DENY_MESSAGE =
  'No one answered this permission prompt within 60 seconds, so Astera denied it automatically (the session is set to deny after 60 s when no one is there).'

export interface ChatPolicy {
  /** Arms a timer for each open approval of this session that the policy covers, cancels the rest. */
  review(sessionId: string): void
  reviewAll(sessionIds: readonly string[]): void
  forget(sessionId: string): void
  dispose(): void
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createChatPolicy(d: {
  policyOf(sessionId: string): UnattendedPermission
  isWriter(sessionId: string): boolean
  open(sessionId: string): ChatRequest[]
  answered(sessionId: string): readonly string[]
  deny(sessionId: string, requestId: string): Promise<void>
  log(m: string): void
  after?(ms: number, fn: () => void): () => void
}): ChatPolicy {
  const after =
    d.after ??
    ((ms: number, fn: () => void): (() => void) => {
      const h = setTimeout(fn, ms)
      h.unref?.()
      return () => clearTimeout(h)
    })

  /** sessionId → request id → the cancel of its armed timer. */
  const armed = new Map<string, Map<string, () => void>>()
  /** `sessionId request id` of a deny still in flight: not re-armed until it settles. */
  const inFlight = new Set<string>()
  let disposed = false
  const keyOf = (sid: string, rid: string): string => `${sid} ${rid}`

  /** The open approvals of the session the policy may deny now; empty when any session-wide condition
   *  fails. A throw from a dependency counts as "may not". */
  const coveredOf = (sid: string): Map<string, ChatRequest> => {
    const out = new Map<string, ChatRequest>()
    try {
      if (d.policyOf(sid) !== 'deny-after-60s' || !d.isWriter(sid)) return out
      const answered = new Set(d.answered(sid))
      for (const r of d.open(sid)) if (r.kind === 'approval' && !answered.has(r.id)) out.set(r.id, r)
    } catch (err) {
      d.log(`unattended: reviewing session ${sid} failed: ${errText(err)}`)
      out.clear()
    }
    return out
  }

  const drop = (sid: string, rid: string): void => {
    const m = armed.get(sid)
    if (!m) return
    m.get(rid)?.()
    m.delete(rid)
    if (m.size === 0) armed.delete(sid)
  }

  const fire = (sid: string, rid: string): void => {
    armed.get(sid)?.delete(rid)
    if (armed.get(sid)?.size === 0) armed.delete(sid)
    if (disposed) return
    const r = coveredOf(sid).get(rid)
    if (!r || r.kind !== 'approval') return
    const key = keyOf(sid, rid)
    inFlight.add(key)
    let denied: Promise<void>
    try {
      denied = d.deny(sid, rid)
    } catch (err) {
      denied = Promise.reject(err)
    }
    denied
      .then(
        () => d.log(`unattended: denied ${r.about.tool} in session ${sid} after 60 s (policy deny-after-60s)`),
        (err: unknown) => d.log(`unattended: denying ${r.about.tool} in session ${sid} failed: ${errText(err)}`)
      )
      .catch(() => {})
      .finally(() => inFlight.delete(key))
  }

  const review = (sid: string): void => {
    if (disposed) return
    const covered = coveredOf(sid)
    for (const rid of [...(armed.get(sid)?.keys() ?? [])]) if (!covered.has(rid)) drop(sid, rid)
    for (const rid of covered.keys()) {
      if (armed.get(sid)?.has(rid) || inFlight.has(keyOf(sid, rid))) continue
      let m = armed.get(sid)
      if (!m) armed.set(sid, (m = new Map()))
      m.set(rid, after(UNATTENDED_DENY_MS, () => fire(sid, rid)))
    }
  }

  return {
    review,
    reviewAll(ids) {
      const seen = new Set(ids)
      for (const sid of [...armed.keys()]) if (!seen.has(sid)) review(sid)
      for (const sid of ids) review(sid)
    },
    forget(sid) {
      for (const rid of [...(armed.get(sid)?.keys() ?? [])]) drop(sid, rid)
    },
    dispose() {
      disposed = true
      for (const sid of [...armed.keys()]) for (const rid of [...(armed.get(sid)?.keys() ?? [])]) drop(sid, rid)
    }
  }
}
