// The Host's own handle on a line process, for a Host-side chat adapter (chat takeover Task 3): the
// ProcLike the app's procFactory.ts gives the app, built straight over the ProcRegistry instead of
// over a socket. Two things set it apart from the app's:
//  - The one-writer rule (constraint 3). Every `write` and `remember` asks `mayWrite` first while an
//    app socket holds the proc, with a log line: a write **throws** `NotWriterError`, so the adapter's
//    own error paths keep its state honest (adapterCore's takeRequest leaves the card open, a turn is
//    not marked running); a note is only dropped. Reading is free, so an adapter in the reader role
//    still decodes every line; it just cannot answer on the wire. `kill` is never gated: killing is
//    the roller's act (spec §3.4), not a writer's.
//  - `release()`: the Host dropping a session (forget, dispose) cuts the handle off the registry, so
//    an adapter nobody holds any more decodes no further line (Task 2 review carry).
//
// One registry subscription per kind, fanned out by proc id (spawner.ts's hostPtyFactory shape), so a
// handle's release is a map delete rather than a registry listener left behind.
//
// Imports nothing outside core and this folder: this bundles into the Host.
import { randomUUID } from 'node:crypto'
import type { ProcLike, ProcSpawnOptions } from '../core/sessions/proc'
import type { ProcRegistry } from './procRegistry'

export interface HostProcHandle extends ProcLike {
  readonly procId: string
  /** Delivers the registry's buffered lines, then the lines held meanwhile, in seq order. Once. */
  replay(): void
  /** Drops the handle's listeners and cuts it off the registry. Every later line and exit is unheard.
   *  Idempotent. */
  release(): void
  /** The one-writer rule, asked now. */
  mayWrite(): boolean
  onLine(cb: (line: string) => void): () => void
  onExit(cb: (e: { exitCode: number; stderrTail?: string }) => void): () => void
}

/** A write the one-writer rule refused: the app is the proc's writer. */
export class NotWriterError extends Error {
  readonly procId: string
  constructor(procId: string) {
    super(`chat proc ${procId}: not the writer, the app is`)
    this.name = 'NotWriterError'
    this.procId = procId
  }
}

type Exit = { exitCode: number; stderrTail?: string }

interface Sink {
  line(seq: number, line: string): void
  exit(e: Exit): void
}

export interface HostProcsDeps {
  registry: Pick<ProcRegistry, 'open' | 'write' | 'kill' | 'note' | 'buffer' | 'onLine' | 'onExit'>
  /** The one-writer rule, asked at every write and every note. */
  mayWrite(procId: string): boolean
  log(m: string): void
}

export interface HostProcs {
  factory(file: string, args: string[], opts: ProcSpawnOptions): HostProcHandle
  attach(a: { procId: string; pid: number }): HostProcHandle
  /** Unsubscribes from the registry. Handles still held deliver nothing afterwards. */
  dispose(): void
}

export function createHostProcs(d: HostProcsDeps): HostProcs {
  const sinks = new Map<string, Set<Sink>>()
  /** One sink's listener that throws costs the others nothing. A refused write is already logged at the
   *  gate, so it is not logged twice (a reader adapter refusing an unreadable request lands here). */
  const guarded = (procId: string, what: string, run: () => void): void => {
    try {
      run()
    } catch (err) {
      if (!(err instanceof NotWriterError)) d.log(`chat proc ${procId}: a ${what} listener threw: ${String(err)}`)
    }
  }
  const offLine = d.registry.onLine((id, seq, line) => {
    for (const s of [...(sinks.get(id) ?? [])]) guarded(id, 'line', () => s.line(seq, line))
  })
  const offExit = d.registry.onExit((id, exitCode, stderrTail) => {
    const all = [...(sinks.get(id) ?? [])]
    sinks.delete(id)
    for (const s of all) guarded(id, 'exit', () => s.exit({ exitCode, ...(stderrTail !== undefined ? { stderrTail } : {}) }))
  })

  const handle = (procId: string, pid: number, replaying: boolean): HostProcHandle => {
    // The app's single-slot ProcLike contract (procFactory.ts, nodeProcFactory.ts): a second onLine
    // takes the first one's place. The manager's bypass respawn silences an old proc that way.
    let onLine: ((line: string) => void) | null = null
    let onExit: ((e: Exit) => void) | null = null
    let lastSeq = 0
    let replayed = !replaying
    let released = false
    const heldLines: Array<{ seq: number; line: string }> = []
    let heldExit: Exit | null = null

    const deliver = (seq: number, line: string): void => {
      if (seq <= lastSeq) return
      lastSeq = seq
      onLine?.(line)
    }
    const sink: Sink = {
      line(seq, line) {
        if (!replayed) heldLines.push({ seq, line })
        else deliver(seq, line)
      },
      exit(e) {
        if (!replayed) heldExit = e
        else onExit?.(e)
      }
    }
    let set = sinks.get(procId)
    if (!set) sinks.set(procId, (set = new Set()))
    set.add(sink)

    const gate = (what: 'write' | 'note'): boolean => {
      if (d.mayWrite(procId)) return true
      d.log(`chat proc ${procId}: a ${what} was dropped, the app is its writer`)
      return false
    }

    return {
      procId,
      pid,
      outlivesApp: true,
      onLine(cb) {
        onLine = cb
        return () => {
          if (onLine === cb) onLine = null
        }
      },
      onExit(cb) {
        onExit = cb
        return () => {
          if (onExit === cb) onExit = null
        }
      },
      mayWrite: () => d.mayWrite(procId),
      write(line) {
        if (!gate('write')) throw new NotWriterError(procId)
        d.registry.write(procId, line)
      },
      kill() {
        d.registry.kill(procId)
      },
      remember(patch) {
        if (!gate('note')) return
        d.registry.note(procId, patch)
      },
      replay() {
        if (replayed || released) return
        replayed = true
        // Each line guarded as a live one is: one the adapter throws on must not cut the replay short.
        for (const l of d.registry.buffer(procId)) guarded(procId, 'line', () => deliver(l.seq, l.line))
        heldLines.sort((x, y) => x.seq - y.seq)
        for (const l of heldLines) guarded(procId, 'line', () => deliver(l.seq, l.line))
        heldLines.length = 0
        const e = heldExit
        heldExit = null
        if (e) guarded(procId, 'exit', () => onExit?.(e))
      },
      release() {
        if (released) return
        released = true
        onLine = null
        onExit = null
        heldLines.length = 0
        heldExit = null
        const s = sinks.get(procId)
        s?.delete(sink)
        if (s && s.size === 0) sinks.delete(procId)
      }
    }
  }

  return {
    factory(file, args, opts) {
      const procId = randomUUID()
      const res = d.registry.open({ id: procId, file, args, opts: { cwd: opts.cwd, env: opts.env }, ...(opts.meta ? { meta: opts.meta } : {}) })
      // Thrown, so the manager's spawn throws and a roll's `try` reschedules.
      if (!res.ok) throw new Error(res.error)
      return handle(procId, res.pid, false)
    },
    attach(a) {
      return handle(a.procId, a.pid, true)
    },
    dispose() {
      offLine()
      offExit()
      sinks.clear()
    }
  }
}
