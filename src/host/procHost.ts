// The Host's answer to the proc-* messages — attachPtyHost's twin for line processes (chat-sessions
// design §6.5). Everything it knows about processes is in the registry; everything it knows about the
// wire is the two functions it is handed. Nothing here touches `net`.
import type { ClientMessage, HostMessage } from '../core/host/protocol'
import type { ProcRegistry } from './procRegistry'

/** Returns a handler for one connection that reports whether it owned the message, so the server can
 *  try the pty handler and its own handshake messages for anything else. Lines and exits broadcast,
 *  because the app that attaches after a restart is not the app that spawned. */
export function attachProcHost(a: {
  registry: ProcRegistry
  broadcast(m: HostMessage): void
  /** Whether the client on this socket marks a person's lines (its hello yields HOST_YIELD_PERSON_WRITES). Absent, or for
   *  a message with no socket: every sender does. */
  marksWrites?(socket: number): boolean
}): (m: ClientMessage, send: (h: HostMessage) => void, from?: { socket: number }) => boolean {
  a.registry.onLine((id, seq, line) => a.broadcast({ t: 'proc-line', id, seq, line }))
  a.registry.onExit((id, exitCode, stderrTail) =>
    a.broadcast({ t: 'proc-exit', id, exitCode, ...(stderrTail !== undefined ? { stderrTail } : {}) })
  )

  return (m, send, from) => {
    switch (m.t) {
      case 'proc-spawn': {
        const res = a.registry.open({ id: m.id, file: m.file, args: m.args, opts: m.opts, meta: m.meta })
        send(res.ok ? { t: 'proc-spawned', id: m.id, pid: res.pid } : { t: 'proc-failed', id: m.id, error: res.error })
        return true
      }
      case 'proc-write':
        // A person's line only when the app marks it so: the turn a person sent (observe deferred fix round 2, I-a). Its
        // handshake, control lines and own turns (a schedule, a roll's carry-on) are not. An older app marks nothing, so
        // who wrote its lines is not known, and the chat's turns are read as unknown
        a.registry.write(
          m.id,
          m.line,
          from !== undefined && a.marksWrites?.(from.socket) === false ? { unmarked: true } : m.typed === true ? { person: true } : undefined
        )
        return true
      case 'proc-kill':
        a.registry.kill(m.id)
        return true
      case 'proc-note':
        a.registry.note(m.id, m.patch)
        return true
      case 'proc-list':
        send({ t: 'proc-listed', entries: a.registry.list() })
        return true
      case 'proc-attach':
        // The whole buffer in one message: the receiver needs to know where the replay ends, so it
        // can order the lines that arrived live meanwhile behind it (procFactory.ts).
        send({ t: 'proc-attached', id: m.id, lines: a.registry.buffer(m.id) })
        return true
      default:
        return false
    }
  }
}
