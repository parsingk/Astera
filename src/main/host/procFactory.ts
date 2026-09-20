// A line process that lives in the Host, behind the ProcLike the app holds — ptyFactory.ts's twin
// (chat-sessions design §6.5). Same asynchrony and the same answers to it: the handle comes back before
// the Host has replied, `pid` is 0 until it does, and writes made in between are queued.
import { randomUUID } from 'node:crypto'
import type { ClientMessage, HostMessage } from '../../core/host/protocol'
import { PTY_LOST_SIGHT_EXIT_CODE } from '../../core/sessions/pty'
import type { ProcFactory, ProcLike, ProcSpawnOptions } from '../../core/sessions/proc'
import type { HostPtyTransport } from './ptyFactory'

function handle(t: HostPtyTransport, id: string, startLive: boolean, startPid: number, startDead = false, startReplaying = false): ProcLike {
  let state: 'pending' | 'live' | 'exited' = startLive ? 'live' : 'pending'
  let pid = startPid
  const queue: string[] = []
  let onLine: (line: string) => void = () => {}
  let onExit: (e: { exitCode: number; stderrTail?: string }) => void = () => {}

  // Ordering the replay against the lines arriving live meanwhile (chat-sessions design §6.5): while
  // replaying, a live proc-line is held rather than delivered, so the batch from proc-attached always
  // comes first; seq then tells apart a line already delivered from one still to come.
  let lastSeq = 0
  let replaying = startLive && startReplaying
  const held: Array<{ seq: number; line: string }> = []

  const deliver = (seq: number, line: string): void => {
    if (seq <= lastSeq) return
    lastSeq = seq
    onLine(line)
  }

  const end = (exitCode: number, stderrTail?: string): void => {
    state = 'exited'
    queue.length = 0
    held.length = 0
    unsubscribe()
    unsubscribeGone()
    onExit({ exitCode, ...(stderrTail !== undefined ? { stderrTail } : {}) })
  }

  // The app losing sight of the process, not the process ending — the same named code ptyFactory
  // uses, read downstream by whoever must not treat it as an ordinary exit.
  const unsubscribeGone = t.onHostGone(() => {
    if (state !== 'exited') end(PTY_LOST_SIGHT_EXIT_CODE)
  })

  const unsubscribe = t.onHostMessage((m: HostMessage) => {
    if (!('id' in m) || m.id !== id) return
    if (m.t === 'proc-spawned') {
      state = 'live'
      pid = m.pid
      for (const line of queue) t.send({ t: 'proc-write', id, line })
      queue.length = 0
      return
    }
    if (m.t === 'proc-line') {
      if (state === 'exited') return
      if (replaying) held.push({ seq: m.seq, line: m.line })
      else deliver(m.seq, m.line)
      return
    }
    if (m.t === 'proc-attached') {
      if (state === 'exited') return
      replaying = false
      for (const l of m.lines) deliver(l.seq, l.line)
      held.sort((x, y) => x.seq - y.seq)
      for (const l of held) deliver(l.seq, l.line)
      held.length = 0
      return
    }
    if ((m.t === 'proc-failed' || m.t === 'proc-exit') && state !== 'exited')
      end(m.t === 'proc-exit' ? m.exitCode : 1, m.t === 'proc-exit' ? m.stderrTail : undefined)
  })

  if (startDead) {
    // The spawn never reached the Host: deferred so the caller has registered onExit by the time it lands.
    queueMicrotask(() => {
      if (state === 'exited') return
      try {
        end(1)
      } catch (err) {
        t.log(`onExit threw ending a spawn that never reached the Host: ${String(err)}`)
      }
    })
  }

  return {
    get pid() {
      return pid
    },
    onLine: (cb) => {
      onLine = cb
    },
    onExit: (cb) => {
      onExit = cb
    },
    write: (line) => {
      if (state === 'exited') return
      if (state === 'pending') {
        queue.push(line)
        return
      }
      t.send({ t: 'proc-write', id, line })
    },
    // kill and remember go out at once, even while pending — ordered behind the proc-spawn on one
    // connection, carrying nothing the Host needs the process to already exist for.
    kill: () => {
      if (state !== 'exited') t.send({ t: 'proc-kill', id })
    },
    remember: (patch) => {
      if (state !== 'exited') t.send({ t: 'proc-note', id, patch })
    }
  }
}

export function createHostProcFactory(t: HostPtyTransport): {
  factory: ProcFactory
  /** A handle for a process the Host already has, for adoption after a restart. */
  attach(a: { id: string; pid: number }): ProcLike
} {
  const factory: ProcFactory = (file, args, opts: ProcSpawnOptions) => {
    const id = randomUUID()
    const msg: ClientMessage = { t: 'proc-spawn', id, file, args, opts: { cwd: opts.cwd, env: opts.env }, ...(opts.meta ? { meta: opts.meta } : {}) }
    const sent = t.send(msg)
    return handle(t, id, false, 0, !sent)
  }
  return {
    factory,
    attach: (a) => {
      const p = handle(t, a.id, true, a.pid, false, true)
      p.outlivesApp = true
      return p
    }
  }
}
