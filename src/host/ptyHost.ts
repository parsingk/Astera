// The Host's answer to the pty-* messages (slice 2 design §5). Everything it knows about sessions is
// in the registry; everything it knows about the wire is the two functions it is handed. Nothing here
// touches `net`, so it is tested with a fake pty and no socket at all.
import type { ClientMessage, HostMessage } from '../core/host/protocol'
import type { PtyRegistry } from './registry'
import { ENDED_WITHOUT_A_CODE } from './exits'

/**
 * Returns a handler for one connection. It reports whether it owned the message, so the server can
 * fall through to its own handshake messages for anything else.
 *
 * `send` reaches the client that asked; `broadcast` reaches every connected client. Output and exit
 * broadcast because the app that attaches after a restart is not the app that spawned.
 */
export function attachPtyHost(a: {
  registry: PtyRegistry
  broadcast(m: HostMessage): void
}): (m: ClientMessage, send: (h: HostMessage) => void) => boolean {
  a.registry.onData((id, data) => a.broadcast({ t: 'pty-data', id, data }))
  a.registry.onExit((id, exitCode) => a.broadcast({ t: 'pty-exit', id, exitCode }))

  return (m, send) => {
    switch (m.t) {
      case 'pty-spawn': {
        const res = a.registry.open({ id: m.id, file: m.file, args: m.args, opts: m.opts, meta: m.meta })
        send(res.ok ? { t: 'pty-spawned', id: m.id, pid: res.pid } : { t: 'pty-failed', id: m.id, error: res.error })
        return true
      }
      case 'pty-write':
        a.registry.write(m.id, m.data)
        return true
      case 'pty-resize':
        a.registry.resize(m.id, m.cols, m.rows)
        return true
      case 'pty-kill':
        a.registry.kill(m.id)
        return true
      case 'pty-pause':
        a.registry.pause(m.id)
        return true
      case 'pty-resume':
        a.registry.resume(m.id)
        return true
      case 'pty-note':
        // Nothing to answer: the app is telling us something about its own session, not asking. The
        // registry decides what a patch for an id it does not have, or for one that has exited, means.
        a.registry.note(m.id, m.patch)
        return true
      case 'pty-list':
        send({ t: 'pty-listed', entries: a.registry.list() })
        return true
      case 'pty-attach': {
        // The scrollback goes only to the client that asked, and only if there is any: an empty
        // replay would be an empty data message the app has to think about for nothing.
        const buffered = a.registry.buffer(m.id)
        if (buffered !== '') send({ t: 'pty-data', id: m.id, data: buffered })
        // **A pty that already ended is answered with its exit** (Host S2 fix round, M3). The app can
        // adopt one in the half round trip between the `pty-listed` that said alive and this attach,
        // and the `pty-exit` broadcast in that window found no handle to end. After the replay, so the
        // last screen is on the tab before the tab says it ended. Additive: an older app ends a handle
        // it has adopted exactly as it ends one on a broadcast exit.
        const ended = a.registry.exitCodeOf(m.id)
        if (ended) send({ t: 'pty-exit', id: m.id, exitCode: ended.code ?? ENDED_WITHOUT_A_CODE })
        return true
      }
      default:
        return false
    }
  }
}
