// The Host takes over an app's sessions once that app is gone (S6 Q2, R2, design §3A.3). One
// synchronous pass: for each pty that qualifies, the mark is written before the chain is restored, so no
// instant exists at which a pty is marked with no chain, or chained and unmarked. It runs only with no app
// attached, so no arriving app can have read a note this pass is about to mark. Pure over its deps.
import { parseRollSnapshot, type RollSnapshot } from '../core/rolling/snapshot'
import { sessionInfoFromNote } from '../core/sessions/noteInfo'
import type { PtyEntry } from '../core/host/protocol'
import type { SessionInfo } from '../core/types'

export function takeOverSessions(d: {
  hasApp(): boolean
  announces(): boolean
  retiring(): boolean
  entries(): PtyEntry[]
  holdersOf(ptyId: string): number[]
  note(ptyId: string, patch: Record<string, unknown>): void
  hasChain(sessionId: string): boolean
  resume(ptyId: string): void
  restore(info: SessionInfo, snap: RollSnapshot): boolean
  log(m: string): void
}): { taken: string[]; skipped: Array<{ sessionId: string; why: string }> } {
  const taken: string[] = []
  const skipped: Array<{ sessionId: string; why: string }> = []
  if (d.hasApp() || !d.announces() || d.retiring()) return { taken, skipped }
  for (const e of d.entries()) {
    if (!e.alive || e.meta?.kind !== 'session') continue
    const id = e.meta.id
    const skip = (why: string): void => {
      skipped.push({ sessionId: id, why })
    }
    const r = e.meta.restore
    if (r.rolledBy === 'host') continue
    const info = sessionInfoFromNote(e.meta)
    if (!info || (info.rollAccountIds?.length ?? 0) < 1) continue
    const snap = parseRollSnapshot(r.roll)
    if (!snap) {
      skip('no snapshot (an app from before S6) — it stalls at a limit, as before')
      continue
    }
    const ids = info.rollAccountIds!
    if (ids.length !== snap.accountIds.length || ids.some((x, i) => x !== snap.accountIds[i])) {
      skip('the snapshot names other accounts than the note')
      continue
    }
    if (d.holdersOf(e.id).length > 0) {
      skip('a socket still holds it')
      continue
    }
    if (d.hasChain(id)) continue
    // R31 (preflight R4): an app that died inside a backpressure pause left the pty paused, and nothing
    // in the Host releases it (SessionManager.adopt does it for the app). Released before the mark.
    d.resume(e.id)
    d.note(e.id, { rolledBy: 'host' })
    if (!d.restore(info, snap)) {
      d.note(e.id, { rolledBy: null })
      skip('the chain could not be restored from its snapshot')
      continue
    }
    taken.push(id)
  }
  // Passes repeat on every tick (R13), so the caller logs each (session, reason) once; this returns them.
  if (taken.length > 0) d.log(`takeover: the Host now rolls ${taken.join(', ')} (the app that held them is gone)`)
  return { taken, skipped }
}
