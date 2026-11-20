// A Pod's log stream for one logs tab (spec §4.8): main runs one kubectl per stream and sends its lines on the one
// 'kube:log' channel; the hook keeps them in a bounded buffer, applied once per animation frame so a busy container
// costs one render per frame rather than one per chunk.
import { useCallback, useEffect, useRef, useState } from 'react'
import { LOG_MAX_LINES, appendLines, emptyLogBuffer, linesAfter, splitTimestamp, type LogBuffer } from '../../../core/kube/cluster/logs'
import type { LogMessage, LogOptions, LogSpec, ObjectRef } from '../../../core/kube/cluster/types'
import { errText } from './useFileOps'

/** `stopped`: follow was turned off; kubectl is gone and the lines stay. */
export type LogState = 'starting' | 'streaming' | 'stopped' | 'ended' | { error: string }

export interface KubeLogStream {
  buffer: LogBuffer
  state: LogState
  /** Opens the stream again (the buffer starts empty). */
  restart(): void
  /** Empties the buffer; the stream keeps running. */
  clear(): void
}

export interface LogApi {
  start(id: string, spec: LogSpec): Promise<void>
  stop(id: string): Promise<void>
  on(cb: (m: LogMessage) => void): () => void
}

export interface LogClient {
  /** `onStarted`: main started kubectl for this still-open stream (a quiet container sends no line to say so). */
  open(spec: LogSpec, cb: (m: LogMessage) => void, onStarted?: () => void): { close(): void }
}

/** The renderer's side of the log streams, as the watch client is for watches: the route is in place before main is
 *  asked, the listener lives only while a stream is open, and a stream's messages are gone once it is closed, so what a
 *  dying kubectl still flushes is dropped. */
export function createLogClient(api: LogApi, newId: () => string = () => crypto.randomUUID()): LogClient {
  const routes = new Map<string, (m: LogMessage) => void>()
  let off: (() => void) | null = null

  const drop = (id: string): void => {
    routes.delete(id)
    if (routes.size === 0 && off) {
      off()
      off = null
    }
  }

  return {
    open(spec, cb, onStarted) {
      const id = newId()
      routes.set(id, cb)
      off ??= api.on((m) => routes.get(m.logId)?.(m))
      api.start(id, spec).then(
        () => {
          if (routes.has(id)) onStarted?.()
        },
        (err) => routes.get(id)?.({ logId: id, kind: 'error', message: errText(err) })
      )
      let closed = false
      return {
        close() {
          if (closed) return
          closed = true
          drop(id)
          // Main kills the process; a failed call here leaves nothing the renderer could do differently.
          api.stop(id).catch(() => {})
        }
      }
    }
  }
}

/** `fn` at the next animation frame, or after a short timeout where there are none; returns the cancel. */
function nextFrame(fn: () => void): () => void {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(fn)
    return () => cancelAnimationFrame(id)
  }
  const id = setTimeout(fn, 16)
  return () => clearTimeout(id)
}

/** One empty buffer, so a render between streams hands the same one each time. */
const NO_LINES = emptyLogBuffer()

let shared: LogClient | null = null
function logClient(): LogClient {
  shared ??= createLogClient({
    start: (id, spec) => window.api.kube.logs.start(id, spec),
    stop: (id) => window.api.kube.logs.stop(id),
    on: (cb) => window.api.on('kube:log', cb)
  })
  return shared
}

export function useKubeLogStream(ref: ObjectRef, options: LogOptions): KubeLogStream {
  const [buffer, setBuffer] = useState<LogBuffer>(emptyLogBuffer)
  const [state, setState] = useState<LogState>('starting')
  /** Bumped by restart. */
  const [gen, setGen] = useState(0)
  /** Drops the lines the current stream received but has not yet applied; set by its effect. */
  const dropPending = useRef<() => void>(() => {})
  const refKey = JSON.stringify(ref)
  const { container, previous, follow } = options
  /** One read of the logs with its own buffer: another Pod, container or previous, or a restart, starts the next.
   *  Follow turned off and on again stays in it. Until the effect starts a new one, a render already asking for it
   *  reads as starting with no lines, not as the last one's end. */
  const session = JSON.stringify([refKey, container, previous, gen])
  const [owner, setOwner] = useState(session)
  /** The session the effect last ran for, and the time stamp of the last line it received, to read on from. */
  const last = useRef<{ session: string; stamp: string | null }>({ session: '', stamp: null })

  useEffect(() => {
    const resumed = last.current.session === session
    if (!resumed) last.current = { session, stamp: null }
    // Follow turned off: the cleanup stopped kubectl, and the lines stay.
    if (resumed && !follow) {
      setState((s) => (s === 'starting' || s === 'streaming' ? 'stopped' : s))
      return
    }
    // Follow turned on again: from the last line received, so nothing is read twice or missed meanwhile.
    let since = resumed ? last.current.stamp : null
    const spec: LogSpec = {
      ref: JSON.parse(refKey) as ObjectRef,
      options: { container, previous, follow, ...(since !== null ? { sinceTime: since } : {}) }
    }
    let alive = true
    let pending: string[] = []
    /** The oldest lines dropped from `pending` before a frame applied them, for the buffer's count. */
    let trimmed = 0
    let cancelFrame: (() => void) | null = null
    const flush = (): void => {
      cancelFrame?.()
      cancelFrame = null
      if (pending.length === 0) return
      const batch = pending
      const cut = trimmed
      pending = []
      trimmed = 0
      setBuffer((b) => {
        const next = appendLines(b, batch)
        return cut > 0 ? { ...next, dropped: next.dropped + cut } : next
      })
    }
    dropPending.current = () => {
      pending = []
      trimmed = 0
    }
    if (!resumed) {
      setBuffer(emptyLogBuffer())
      setOwner(session)
    }
    setState('starting')
    const stream = logClient().open(
      spec,
      (m) => {
        if (!alive) return
        if (m.kind === 'lines') {
          let lines = m.lines
          // --since-time counts whole seconds: that second's lines come again, up to the last one already shown.
          if (since !== null) {
            lines = linesAfter(lines, since)
            if (lines.length > 0) since = null
          }
          for (let i = lines.length - 1; i >= 0; i--) {
            const ts = splitTimestamp(lines[i]).ts
            if (ts !== null) {
              last.current.stamp = ts
              break
            }
          }
          // A loop, not push(...lines): a very large batch would exceed the argument limit.
          for (const line of lines) pending.push(line)
          // A hidden window gets no frames while the lines keep coming: no more wait than the buffer would keep.
          if (pending.length > LOG_MAX_LINES) {
            trimmed += pending.length - LOG_MAX_LINES
            pending = pending.slice(pending.length - LOG_MAX_LINES)
          }
          setState((s) => (s === 'starting' ? 'streaming' : s))
          cancelFrame ??= nextFrame(() => {
            cancelFrame = null
            flush()
          })
          return
        }
        // Lines already received show before the way it ended.
        flush()
        setState(m.kind === 'ended' ? 'ended' : { error: m.message })
      },
      () => {
        if (alive) setState((s) => (s === 'starting' ? 'streaming' : s))
      }
    )
    return () => {
      // Lines received but not yet drawn still show: follow turned off keeps all it had. A new session empties the
      // buffer after this.
      flush()
      alive = false
      stream.close()
    }
  }, [refKey, container, previous, follow, gen])

  const restart = useCallback(() => setGen((g) => g + 1), [])
  const clear = useCallback(() => {
    dropPending.current()
    setBuffer(emptyLogBuffer())
  }, [])
  return owner === session ? { buffer, state, restart, clear } : { buffer: NO_LINES, state: 'starting', restart, clear }
}
