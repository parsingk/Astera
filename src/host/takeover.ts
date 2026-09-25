// The Host takes over an app's sessions once that app is gone (S6 Q2, R2, design §3A.3). One
// synchronous pass: for each pty that qualifies, the mark is written before the chain is restored, so no
// instant exists at which a pty is marked with no chain, or chained and unmarked. It runs only with no app
// attached, so no arriving app can have read a note this pass is about to mark. Pure over its deps.
import { parseRollSnapshot, type RollSnapshot } from '../core/rolling/snapshot'
import { chatInfoFromNote, sessionInfoFromNote } from '../core/sessions/noteInfo'
import { isUnattendedPermission } from '../core/chat/types'
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
    // Fix round 1: restore refuses a snapshot whose current account is not the note's (both coordinators
    // check it), so such a pty would be resumed, marked and unmarked on every tick for nothing.
    if (snap.accountIds[snap.currentIndex] !== info.accountId) {
      skip('the snapshot sits on another account than the note — restore would refuse it')
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
    // A restore that throws is taken as one that refused (fix round 1): the mark comes back either way,
    // so no pty is left marked with no chain.
    let ok: boolean
    try {
      ok = d.restore(info, snap)
    } catch (err) {
      d.log(`takeover: restoring ${id} threw — the mark is taken back: ${String(err)}`)
      ok = false
    }
    if (!ok) {
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

/** The chat twin (chat takeover spec §3.3, plan rulings P3, P5). For each live chat proc a new app wrote
 *  (a valid `unattendedPermission` in its note) that no socket holds and the Host holds no adapter on:
 *  the chain part first (the mark, then the restore, the mark taken back on a refusal or a throw), then
 *  the adopt, always, in the same synchronous turn, so the adapter's `ready` at its adopt start reaches
 *  the restored chain. A chain is restored only with `rollAccountIds`, no `rolledBy` and no chain yet;
 *  the mark is written only with a restored chain (P3). An adopt that fails after a restore takes the
 *  mark back and drops the chain: a chain with no adapter would never hear a limit. Pure over its deps. */
export function takeOverChats(d: {
  hasApp(): boolean
  announces(): boolean
  retiring(): boolean
  entries(): PtyEntry[]
  holdersOf(procId: string): number[]
  note(procId: string, patch: Record<string, unknown>): void
  hasChain(sessionId: string): boolean
  held(sessionId: string): boolean
  restore(info: SessionInfo, snap: RollSnapshot): boolean
  unregister(sessionId: string): void
  adopt(entry: PtyEntry): boolean
  log(m: string): void
  /** Fix round 1 (Minor 1): proc id → the note it failed to adopt with. Such a proc is not tried again
   *  (a restore has side effects: its roll config, onNativeSession) until it ends or its note changes.
   *  The caller keeps the map across passes. */
  adoptFailed?: Map<string, string>
}): { taken: string[]; adopted: string[]; skipped: Array<{ sessionId: string; why: string }> } {
  const taken: string[] = []
  const adopted: string[] = []
  const skipped: Array<{ sessionId: string; why: string }> = []
  if (d.hasApp() || !d.announces() || d.retiring()) return { taken, adopted, skipped }
  const entries = d.entries()
  const failed = d.adoptFailed
  if (failed) {
    const live = new Set(entries.filter((e) => e.alive).map((e) => e.id))
    for (const p of [...failed.keys()]) if (!live.has(p)) failed.delete(p)
  }
  for (const e of entries) {
    if (!e.alive || e.meta?.kind !== 'chat') continue
    const id = e.meta.id
    const key = failed ? noteKey(e.meta.restore) : ''
    if (failed?.has(e.id)) {
      if (failed.get(e.id) === key) continue
      failed.delete(e.id)
    }
    const skip = (why: string): void => {
      skipped.push({ sessionId: id, why })
    }
    const r = e.meta.restore
    const info = chatInfoFromNote(e.meta)
    if (!info) continue
    if (!isUnattendedPermission(r.unattendedPermission)) {
      skip('an Astera from before chat takeover wrote this note, so it is not taken (spec §3.6)')
      continue
    }
    if (d.holdersOf(e.id).length > 0) {
      skip('a socket still holds it')
      continue
    }
    // Final review M1: an adapter the Host already holds does not end the pass for this proc. A first
    // pass may have adopted it with its chain part skipped (say the snapshot sat on another account mid
    // roll); an app that reopened, kept it and quit again leaves it chainless, so the chain part runs
    // again, and only the adopt is not repeated.
    const alreadyHeld = d.held(id)
    const ids = info.rollAccountIds ?? []
    const wantsChain = ids.length >= 1 && r.rolledBy !== 'host' && !d.hasChain(id)
    if (alreadyHeld && !wantsChain) continue

    // The chain part: only for a chain the Host does not roll yet.
    let chained = false
    if (wantsChain) {
      const snap = parseRollSnapshot(r.roll)
      if (!snap) {
        skip('no snapshot (an app from before chat takeover) — it stalls at a limit, as before')
      } else if (ids.length !== snap.accountIds.length || ids.some((x, i) => x !== snap.accountIds[i])) {
        skip('the snapshot names other accounts than the note')
      } else if (snap.accountIds[snap.currentIndex] !== info.accountId) {
        skip('the snapshot sits on another account than the note — restore would refuse it')
      } else {
        d.note(e.id, { rolledBy: 'host' })
        let ok: boolean
        try {
          ok = d.restore(info, snap)
        } catch (err) {
          d.log(`takeover: restoring chat ${id} threw — the mark is taken back: ${String(err)}`)
          ok = false
        }
        if (ok) chained = true
        else {
          d.note(e.id, { rolledBy: null })
          skip('the chain could not be restored from its snapshot')
        }
      }
    }

    if (alreadyHeld) {
      if (chained) taken.push(id)
      continue
    }

    // The adopt, always (P3: answering a held prompt from the CLI needs an adapter, chain or not).
    let adoptedOk: boolean
    try {
      adoptedOk = d.adopt(e)
    } catch (err) {
      d.log(`takeover: adopting chat ${id} threw: ${String(err)}`)
      adoptedOk = false
    }
    if (!adoptedOk) {
      if (chained) {
        d.unregister(id)
        d.note(e.id, { rolledBy: null })
      }
      skip('the Host could not take an adapter on it')
      if (failed) {
        failed.set(e.id, key)
        d.log(`takeover: chat ${id} could not be adopted — not tried again until its proc ends or its note changes`)
      }
      continue
    }
    adopted.push(id)
    if (chained) taken.push(id)
  }
  if (taken.length > 0) d.log(`takeover: the Host now rolls chat ${taken.join(', ')} (the app that held them is gone)`)
  if (adopted.length > 0) d.log(`takeover: the Host now carries chat ${adopted.join(', ')} (the app that held them is gone)`)
  return { taken, adopted, skipped }
}

/** The note as the chat pass compares it across passes: without `rolledBy`, the one key the pass writes
 *  itself (a failed adopt takes its mark back, and that must not read as a change). */
function noteKey(restore: Record<string, unknown>): string {
  const { rolledBy: _rolledBy, ...rest } = restore
  return JSON.stringify(rest)
}
