// A pty that lives in the Host, behind the same PtyLike the app has always used (slice 2 design §3).
//
// The factory is synchronous and a spawn across a socket is not, so the handle comes back before the
// Host has answered: `pid` is 0 until it does, and writes made in between are queued. That is safe
// because `pid` is read in exactly one place in this repository — RunManager's tree-kill, at stop
// time. Everything else only writes, resizes and listens.
import { randomUUID } from 'node:crypto'
import type { ClientMessage, HostMessage } from '../../core/host/protocol'
import type { PtyFactory, PtyLike, PtySpawnOptions } from '../../core/sessions/pty'

export interface HostPtyTransport {
  send(m: ClientMessage): void
  onHostMessage(cb: (m: HostMessage) => void): () => void
  /** The connection to the Host went away. Every pty went with it, and no `pty-exit` will ever
   *  arrive to say so — without this a session stays "running" in the app forever (design §11). */
  onHostGone(cb: () => void): () => void
}

type Queued = { t: 'pty-write'; data: string } | { t: 'pty-resize'; cols: number; rows: number }

function handle(t: HostPtyTransport, id: string, startLive: boolean, startPid: number): PtyLike {
  let state: 'pending' | 'live' | 'exited' = startLive ? 'live' : 'pending'
  let pid = startPid
  const queue: Queued[] = []
  let onData: (d: string) => void = () => {}
  let onExit: (e: { exitCode: number }) => void = () => {}

  const end = (exitCode: number): void => {
    state = 'exited'
    queue.length = 0
    unsubscribe()
    unsubscribeGone()
    onExit({ exitCode })
  }

  // -1 rather than an ordinary code: the process may well still be alive, and this is the app losing
  // sight of it rather than the pty reporting how it ended.
  const unsubscribeGone = t.onHostGone(() => {
    if (state !== 'exited') end(-1)
  })

  const unsubscribe = t.onHostMessage((m) => {
    if (!('id' in m) || m.id !== id) return
    if (m.t === 'pty-spawned') {
      state = 'live'
      pid = m.pid
      for (const q of queue) t.send(q.t === 'pty-write' ? { t: 'pty-write', id, data: q.data } : { t: 'pty-resize', id, cols: q.cols, rows: q.rows })
      queue.length = 0
      return
    }
    if (m.t === 'pty-data') {
      onData(m.data)
      return
    }
    // A refusal and an exit end the same way: this handle is a session that is over. Callers all have
    // a path for that; none of them has a path for "the spawn was refused".
    if (m.t === 'pty-failed' || m.t === 'pty-exit') end(m.t === 'pty-exit' ? m.exitCode : 1)
  })

  const forward = (q: Queued): void => {
    if (state === 'exited') return
    if (state === 'pending') {
      queue.push(q)
      return
    }
    t.send(q.t === 'pty-write' ? { t: 'pty-write', id, data: q.data } : { t: 'pty-resize', id, cols: q.cols, rows: q.rows })
  }

  return {
    get pid() {
      return pid
    },
    onData: (cb) => {
      onData = cb
    },
    onExit: (cb) => {
      onExit = cb
    },
    write: (data) => forward({ t: 'pty-write', data }),
    resize: (cols, rows) => forward({ t: 'pty-resize', cols, rows }),
    kill: () => {
      if (state !== 'exited') t.send({ t: 'pty-kill', id })
    },
    pause: () => {
      if (state !== 'exited') t.send({ t: 'pty-pause', id })
    },
    resume: () => {
      if (state !== 'exited') t.send({ t: 'pty-resume', id })
    }
  } as PtyLike
}

export function createHostPtyFactory(t: HostPtyTransport): {
  factory: PtyFactory
  /** A handle for a pty the Host already has, for adoption after a restart. It starts live, with the
   *  pid the registry reported and nothing queued. */
  attach(a: { id: string; pid: number }): PtyLike
} {
  const factory: PtyFactory = (file, args, opts: PtySpawnOptions) => {
    const id = randomUUID()
    const h = handle(t, id, false, 0)
    t.send({
      t: 'pty-spawn',
      id,
      file,
      args,
      opts: { cwd: opts.cwd, cols: opts.cols, rows: opts.rows, env: opts.env },
      ...(opts.meta ? { meta: opts.meta } : {})
    })
    return h
  }
  return { factory, attach: (a) => handle(t, a.id, true, a.pid) }
}
