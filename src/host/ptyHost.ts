// The Host's answer to the pty-* messages (slice 2 design §5). Everything it knows about sessions is
// in the registry; everything it knows about the wire is the two functions it is handed. Nothing here
// touches `net`, so it is tested with a fake pty and no socket at all.
import { HOST_FEATURE_PTY_SEQ, type ClientMessage, type HostMessage } from '../core/host/protocol'
import type { PtyRegistry } from './registry'
import { ENDED_WITHOUT_A_CODE } from './exits'

/** Which connection a message came from, as host/index.ts passes it: the socket's number and the role its hello named
 *  (server.ts `outwardRole`: a hello with no role reads as `'cli'`). */
export interface HandlerFrom {
  socket: number
  role: 'app' | 'cli' | 'mcp'
}

/** What a spawn asked of anything but the app is answered with (final fix pass, C2). */
export const PTY_SPAWN_APP_ONLY = 'pty-spawn is served to the Astera app only'

/** Every message this handler owns. **Each is the proven app's alone** (sandbox follow-ups, round 2): each reads a
 *  terminal (its list, its scrollback) or drives one (types into it, sizes, pauses, kills or notes it), and a write is
 *  recorded as the person's. Only the app sends any of them (src/main); a CLI, an MCP client and the Remote's
 *  controllers reach a session through the command layer (`sessions read`, `sessions send`, the gateway link), which
 *  holds its own rules. */
const PTY_MESSAGES: ReadonlySet<ClientMessage['t']> = new Set(['pty-spawn', 'pty-write', 'pty-resize', 'pty-kill', 'pty-pause', 'pty-resume', 'pty-note', 'pty-list', 'pty-attach'])

/**
 * Returns a handler for one connection. It reports whether it owned the message, so the server can
 * fall through to its own handshake messages for anything else.
 *
 * `send` reaches the client that asked; `broadcast` reaches every connected client. Output and exit
 * broadcast because the app that attaches after a restart is not the app that spawned.
 */
export type PtyHandler = ((m: ClientMessage, send: (h: HostMessage) => void, from?: HandlerFrom) => boolean) & {
  /** A socket closed: every pty it paused and did not resume is resumed, unless another socket still holds it paused
   *  (remote runtime design §3.7, N2). A dead app no longer leaves its terminals frozen. */
  socketGone(socket: number): void
  /** How many ptys some socket holds paused (tests). */
  pausedHeld(): number
}

export function attachPtyHost(a: {
  registry: PtyRegistry
  /** Test seam; defaults to the process's. A reattach redraws on POSIX only (issue #8). */
  platform?: NodeJS.Platform
  /** `to` filters by the client's hello: its yields and its features. */
  broadcast(m: HostMessage, to?: (yields: ReadonlySet<string>, features: ReadonlySet<string>) => boolean): void
}): PtyHandler {
  // Each chunk as today to a client without `pty-seq`; each ring event with its seq to one with it (a chunk over the
  // ring's piece size is several events there).
  a.registry.onData((id, data) => a.broadcast({ t: 'pty-data', id, data }, (_y, f) => !f.has(HOST_FEATURE_PTY_SEQ)))
  a.registry.onEvent((id, e) => {
    if (e.kind === 'data') a.broadcast({ t: 'pty-data', id, data: e.data, seq: e.seq }, (_y, f) => f.has(HOST_FEATURE_PTY_SEQ))
  })
  a.registry.onExit((id, exitCode) => a.broadcast({ t: 'pty-exit', id, exitCode }))
  /** A pty's size as the apps hear it, with its session, so the tab can show it whole when it does not own it. */
  const sizeMessage = (id: string, size: { cols: number; rows: number }): HostMessage => {
    const session = a.registry.metaOf(id)?.id
    return { t: 'pty-size', id, ...(session !== undefined ? { session } : {}), cols: size.cols, rows: size.rows, owned: a.registry.localOwns(id) }
  }
  a.registry.onSize((id, size) => a.broadcast(sizeMessage(id, size)))
  /** Which sockets hold each pty paused. An exited pty's go with it (review M7). */
  const pausedBy = new Map<string, Set<number>>()
  a.registry.onExit((id) => void pausedBy.delete(id))

  const handler = (m: ClientMessage, send: (h: HostMessage) => void, from?: HandlerFrom): boolean => {
    // Anything but the proven app (server.ts: a socket is the app only once it proved it) is refused every pty message,
    // owned so nothing else reads it. A spawn is told why, as before (final fix pass, C2); the rest are answered nothing:
    // a `pty-list` with no answer reads to the app as "not known", where an empty one would read as "holds nothing".
    if (PTY_MESSAGES.has(m.t) && from?.role !== 'app') {
      if (m.t === 'pty-spawn') send({ t: 'pty-failed', id: m.id, error: PTY_SPAWN_APP_ONLY })
      return true
    }
    switch (m.t) {
      case 'pty-spawn': {
        // Any program, with any arguments, environment and folder, outside every sandbox: the app's own connection asks
        // for it, and nothing else may (above).
        const res = a.registry.open({ id: m.id, file: m.file, args: m.args, opts: m.opts, meta: m.meta })
        send(res.ok ? { t: 'pty-spawned', id: m.id, pid: res.pid } : { t: 'pty-failed', id: m.id, error: res.error })
        return true
      }
      case 'pty-write':
        // A person typing in a tab, as far as the Host can tell: the app's own few deliveries come this
        // way too, which only makes a finished Run's grace wait longer (registry.ts, lastPersonWriteAt).
        // The app's side for the size: a person typing in the tab takes it back from a controller (registry `sizeOwner`);
        // the app's own writes do not (final review I4). Only what the app marks a person's, typed in the tab or sent from
        // elsewhere (a Slack reply), is a person's prompt; its own deliveries are not (observe deferred fix round 2, I-a).
        a.registry.write(
          m.id,
          m.data,
          m.typed === true ? { person: true, side: 'local' } : m.person === true ? { person: true } : { person: true, delivery: true }
        )
        return true
      case 'pty-resize': {
        // Kept, not applied, while a controller owns the size: the app is told the size the pty has instead.
        if (!a.registry.resizeFor(m.id, 'local', m.cols, m.rows)) {
          // Only for a live pty: an ended one keeps its size for `sessions read`, not for a tab (final review M3).
          const size = a.registry.exitCodeOf(m.id) === null ? a.registry.size(m.id) : null
          if (size) send(sizeMessage(m.id, size))
        }
        return true
      }
      case 'pty-kill':
        a.registry.kill(m.id)
        return true
      case 'pty-pause': {
        // Only a live pty's (second pass H2-4): a pause that raced the exit would be held until the socket closed.
        if (from && a.registry.list().some((e) => e.id === m.id && e.alive)) {
          const by = pausedBy.get(m.id) ?? new Set<number>()
          by.add(from.socket)
          pausedBy.set(m.id, by)
        }
        a.registry.pause(m.id)
        return true
      }
      case 'pty-resume':
        if (from) {
          const by = pausedBy.get(m.id)
          by?.delete(from.socket)
          if (by?.size === 0) pausedBy.delete(m.id)
        }
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
        // A live pty's program draws again for the tab that attached, after the replay (issue #8): POSIX sends SIGWINCH
        // only when the size changes, and the tab asks for the size the pty has. Not for a pty that drew nothing yet (a
        // worker the app takes up as it starts draws its first screen on its own), and not on Windows, left as it was.
        else if (buffered !== '' && (a.platform ?? process.platform) !== 'win32') a.registry.redraw(m.id)
        return true
      }
      default:
        return false
    }
  }
  return Object.assign(handler, {
    pausedHeld: () => pausedBy.size,
    socketGone: (socket: number): void => {
      for (const [id, by] of [...pausedBy]) {
        if (!by.delete(socket)) continue
        if (by.size > 0) continue
        pausedBy.delete(id)
        a.registry.resume(id)
      }
    }
  })
}
