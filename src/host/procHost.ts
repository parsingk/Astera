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
}): (m: ClientMessage, send: (h: HostMessage) => void) => boolean {
  a.registry.onLine((id, line) => a.broadcast({ t: 'proc-line', id, line }))
  a.registry.onExit((id, exitCode) => a.broadcast({ t: 'proc-exit', id, exitCode }))

  return (m, send) => {
    switch (m.t) {
      case 'proc-spawn': {
        const res = a.registry.open({ id: m.id, file: m.file, args: m.args, opts: m.opts, meta: m.meta })
        send(res.ok ? { t: 'proc-spawned', id: m.id, pid: res.pid } : { t: 'proc-failed', id: m.id, error: res.error })
        return true
      }
      case 'proc-write':
        a.registry.write(m.id, m.line)
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
      case 'proc-attach': {
        // One message per line rather than one carrying an array: the receiver already has a handler
        // for a line, and a replay is only lines that arrived while it was away.
        for (const line of a.registry.buffer(m.id)) send({ t: 'proc-line', id: m.id, line })
        return true
      }
      default:
        return false
    }
  }
}
