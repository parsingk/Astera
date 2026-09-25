// Which app sockets hold which line process (chat takeover, constraint 3). A chat proc has one writer:
// the app while an app socket holds it, the Host otherwise. A hold is placed by a greeted socket's
// `proc-spawn` or `proc-attach` and released when that socket goes (an app leaving) or the proc ends.
// Reading is free: only the writer is decided here.
//
// Imports only core types, so the Host bundle can carry it.
import type { ClientMessage } from '../core/host/protocol'

/** The proc a client message makes its socket hold: a greeted socket's proc-spawn or proc-attach. */
export function procHeldBy(m: ClientMessage, from: { greeted: boolean }): string | null {
  if (!from.greeted) return null
  return m.t === 'proc-spawn' || m.t === 'proc-attach' ? m.id : null
}

export interface ProcHolders {
  /** A change only when the socket did not hold the proc yet. */
  heldBy(procId: string, socket: number): void
  /** One change when the socket held anything. */
  appGone(socket: number): void
  /** Drops the proc's holds without telling a change. */
  ended(procId: string): void
  holdersOf(procId: string): number[]
  onChange(fn: () => void): () => void
}

export function createProcHolders(d: { log?(m: string): void } = {}): ProcHolders {
  const holds = new Map<string, Set<number>>()
  const listeners = new Set<() => void>()
  const changed = (): void => {
    for (const fn of [...listeners]) {
      try {
        fn()
      } catch (err) {
        d.log?.(`a proc holder listener threw: ${String(err)}`)
      }
    }
  }
  return {
    heldBy(procId, socket) {
      let set = holds.get(procId)
      if (!set) holds.set(procId, (set = new Set()))
      if (set.has(socket)) return
      set.add(socket)
      changed()
    },
    appGone(socket) {
      let released = false
      for (const [procId, set] of holds) {
        if (!set.delete(socket)) continue
        released = true
        if (set.size === 0) holds.delete(procId)
      }
      if (released) changed()
    },
    // Bookkeeping only, not a change: an ended proc has no writer to change (constraint 3 changes the
    // writer only when a hold is placed or an app leaves), and its session goes with its exit.
    ended(procId) {
      holds.delete(procId)
    },
    holdersOf(procId) {
      return [...(holds.get(procId) ?? [])]
    },
    onChange(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    }
  }
}
