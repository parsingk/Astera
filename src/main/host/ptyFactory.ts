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
  /** Whether the message actually reached the Host — false with no connection right now, the same
   *  contract `HostClient.send` already has. The factory checks this for `pty-spawn`: a spawn that
   *  never left the app will get no `pty-spawned` or `pty-failed` reply either, so nothing would ever
   *  end a handle left waiting on one. */
  send(m: ClientMessage): boolean
  onHostMessage(cb: (m: HostMessage) => void): () => void
  /** The connection to the Host went away. Every pty went with it, and no `pty-exit` will ever
   *  arrive to say so — without this a session stays "running" in the app forever (design §11). */
  onHostGone(cb: () => void): () => void
  /** Where a failure this module cannot let escape gets recorded. `pty-exit` and `onHostGone` both
   *  reach `end()` through HostClient's own per-subscriber try/catch (`onMessage`/`onDisconnect`'s
   *  fan-out), so a caller's `onExit` throwing there is already contained and logged. The deferred
   *  `end()` a failed `pty-spawn` schedules (see `startDead` below) runs outside that fan-out — this
   *  is what gives it the same containment. */
  log(m: string): void
}

type Queued = { t: 'pty-write'; data: string } | { t: 'pty-resize'; cols: number; rows: number }

function handle(t: HostPtyTransport, id: string, startLive: boolean, startPid: number, startDead = false): PtyLike {
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
    // a path for that; none of them has a path for "the spawn was refused". Guarded the same way
    // `onHostGone` guards its own end() so this does not rely on `unsubscribe()` (below) having
    // already taken the handle out of the transport's set — the two read alike, and neither depends
    // on the other's cleanup for its correctness.
    if ((m.t === 'pty-failed' || m.t === 'pty-exit') && state !== 'exited') end(m.t === 'pty-exit' ? m.exitCode : 1)
  })

  if (startDead) {
    // The spawn never reached the Host — `t.send` already returned false, so no `pty-spawned` or
    // `pty-failed` will ever arrive to end this the ordinary way. Deferred to a microtask rather than
    // ended right here: this runs inside the `factory` call that is about to hand the caller this
    // very handle, and the caller only registers `onExit` once that call returns — an end delivered
    // before then would have nowhere to land.
    queueMicrotask(() => {
      if (state === 'exited') return
      try {
        end(1)
      } catch (err) {
        // pty-exit and onHostGone both reach end() through HostClient's own per-subscriber
        // try/catch, so a caller's onExit throwing there is already contained and logged. This
        // microtask runs outside that fan-out — nothing may throw out of this module either.
        t.log(`onExit threw ending a spawn that never reached the Host: ${String(err)}`)
      }
    })
  }

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
    // kill, pause and resume go out at once, even while pending, rather than queuing like write and
    // resize do: they carry no payload the Host needs the pty to already exist for, and the
    // connection delivers in order, so the Host always sees them after the pty-spawn they are
    // ordered behind. write and resize queue instead because their payload is real content — input
    // the user typed, a size the app needs applied — that must not be sent to a pty that turns out
    // never to have started at all.
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
    const sent = t.send({
      t: 'pty-spawn',
      id,
      file,
      args,
      opts: { cwd: opts.cwd, cols: opts.cols, rows: opts.rows, env: opts.env },
      ...(opts.meta ? { meta: opts.meta } : {})
    })
    // `sent` false means there is no connection right now — the same gap `ipc.ts` closes by only
    // installing this factory once connected, kept here too as a second line of defence for a
    // connection that drops again later.
    return handle(t, id, false, 0, !sent)
  }
  return { factory, attach: (a) => handle(t, a.id, true, a.pid) }
}
