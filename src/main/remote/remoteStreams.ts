// A remote session tab's output (remote runtime design Phase 9b, N13, §3.7): main subscribes to the Runtime's pty
// through that Runtime's client, whose link keeps the stream going across gaps and reconnects, and forwards it to the
// renderer under the tab's key, `<runtimeId>:<sessionId>` (D1.4). The renderer's session bus then carries it as it
// carries a local session's output:
//
// - `session:reset { sessionId, state, pending, cols, rows, exitCode? }`: a checkpoint; the view resets and writes
//   `state` then `pending`. It comes first, after every gap, and after every reconnect that could not resume.
// - `session:data { sessionId, data }`: output after it, each byte once.
// - `session:remote-size { sessionId, cols, rows }`: the pty was resized on the Runtime.
// - `session:remote-exit { sessionId, code }`: the pty ended.
// - `session:remote-gone { sessionId, code, message }`: the stream was given up (no such pty, a Runtime that cannot
//   stream, a pairing that is gone).
// - `session:remote-link { sessionId, state }`: its connection dropped (`down`, the link is reconnecting) or is back
//   (`up`), for the tab to say it is reconnecting meanwhile.
//
// The link does not tell its streams when it is closed, so a re-paired or removed Runtime is `rebind`'s to handle.
import type { PtyStreamHandlers } from '../../core/remote/link'
import type { RemotePtyEvent } from '../../core/remote/frames'
import { remoteSessionKey } from '../../core/panes/tabId'

type Client = { subscribePty(ptyId: string, h: PtyStreamHandlers): () => void }

export interface RemoteStreams {
  /** Subscribes the tab to the pty; false when the Runtime cannot be reached for it (reported gone). */
  attach(runtimeId: string, sessionId: string, ptyId: string): Promise<boolean>
  detach(key: string): void
  /** The Runtime's client was replaced or removed: its streams subscribe again, or are reported gone. */
  rebind(runtimeId: string): Promise<void>
  close(): void
}

export function createRemoteStreams(a: {
  clientOf(runtimeId: string): Promise<Client | { code: string; message: string }>
  send(channel: string, payload: unknown): void
}): RemoteStreams {
  /** One per tab key. `gen` marks the subscription current: a replaced or detached one's late calls are dropped. */
  const streams = new Map<string, { runtimeId: string; sessionId: string; ptyId: string; gen: number; stop: (() => void) | null }>()
  let gen = 0

  const forward = (key: string, mine: number): PtyStreamHandlers => {
    const live = (): boolean => streams.get(key)?.gen === mine
    return {
      onReset: (c) => {
        if (!live()) return
        a.send('session:reset', {
          sessionId: key,
          state: c.state,
          pending: c.pending,
          cols: c.cols,
          rows: c.rows,
          ...(c.exitCode !== undefined ? { exitCode: c.exitCode } : {})
        })
      },
      onEvents: (events: RemotePtyEvent[]) => {
        if (!live()) return
        // Data runs between size and exit events are joined, so a batch is one message per run.
        let data = ''
        const flush = (): void => {
          if (data !== '') a.send('session:data', { sessionId: key, data })
          data = ''
        }
        for (const e of events) {
          if (e.kind === 'data') data += e.data
          else if (e.kind === 'resize') {
            flush()
            a.send('session:remote-size', { sessionId: key, cols: e.cols, rows: e.rows })
          } else {
            flush()
            a.send('session:remote-exit', { sessionId: key, code: e.code })
          }
        }
        flush()
      },
      onGone: (code, message) => {
        if (!live()) return
        a.send('session:remote-gone', { sessionId: key, code, message })
      },
      onLinkState: (state) => {
        if (!live()) return
        a.send('session:remote-link', { sessionId: key, state })
      }
    }
  }

  const subscribe = async (key: string): Promise<boolean> => {
    const s = streams.get(key)
    if (!s) return false
    const mine = s.gen
    const client = await a.clientOf(s.runtimeId)
    // Detached or replaced while the client was being found.
    if (streams.get(key)?.gen !== mine) return false
    if (!('subscribePty' in client)) {
      a.send('session:remote-gone', { sessionId: key, code: client.code, message: client.message })
      return false
    }
    s.stop = client.subscribePty(s.ptyId, forward(key, mine))
    return true
  }

  const drop = (key: string): void => {
    const s = streams.get(key)
    if (!s) return
    streams.delete(key)
    s.stop?.()
  }

  return {
    attach: (runtimeId, sessionId, ptyId) => {
      const key = remoteSessionKey(runtimeId, sessionId)
      // Always afresh, even for the same pty (review I2): a view attaching again has nothing on screen, and only a new
      // subscription starts it from a checkpoint.
      drop(key)
      streams.set(key, { runtimeId, sessionId, ptyId, gen: ++gen, stop: null })
      return subscribe(key)
    },
    detach: drop,
    rebind: async (runtimeId) => {
      const keys = [...streams.entries()].filter(([, s]) => s.runtimeId === runtimeId).map(([k]) => k)
      await Promise.all(
        keys.map((key) => {
          const s = streams.get(key)!
          s.stop?.()
          streams.set(key, { ...s, gen: ++gen, stop: null })
          return subscribe(key)
        })
      )
    },
    close: () => {
      for (const key of [...streams.keys()]) drop(key)
    }
  }
}
