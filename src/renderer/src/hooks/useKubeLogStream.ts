// A Pod's log stream for one logs tab (spec §4.8): main runs one kubectl per stream and sends its lines on the one
// 'kube:log' channel; the hook keeps them in a bounded buffer, applied once per animation frame so a busy container
// costs one render per frame rather than one per chunk.
import { useCallback, useEffect, useRef, useState } from 'react'
import { appendLines, emptyLogBuffer, type LogBuffer } from '../../../core/kube/cluster/logs'
import type { LogMessage, LogOptions, LogSpec, ObjectRef } from '../../../core/kube/cluster/types'
import { errText } from './useFileOps'

export type LogState = 'starting' | 'streaming' | 'ended' | { error: string }

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
  /** The stream the buffer and state belong to. Until the effect starts a new one, a render already asked for it reads
   *  as starting with no lines, not as the last stream's end. */
  const streamKey = JSON.stringify([refKey, container, previous, follow, gen])
  const [owner, setOwner] = useState(streamKey)

  useEffect(() => {
    const spec: LogSpec = { ref: JSON.parse(refKey) as ObjectRef, options: { container, previous, follow } }
    let alive = true
    let pending: string[] = []
    let cancelFrame: (() => void) | null = null
    const flush = (): void => {
      cancelFrame?.()
      cancelFrame = null
      if (pending.length === 0) return
      const batch = pending
      pending = []
      setBuffer((b) => appendLines(b, batch))
    }
    dropPending.current = () => {
      pending = []
    }
    setBuffer(emptyLogBuffer())
    setState('starting')
    setOwner(streamKey)
    const stream = logClient().open(
      spec,
      (m) => {
        if (!alive) return
        if (m.kind === 'lines') {
          // A loop, not push(...lines): a very large batch would exceed the argument limit.
          for (const line of m.lines) pending.push(line)
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
      alive = false
      cancelFrame?.()
      stream.close()
    }
  }, [refKey, container, previous, follow, gen])

  const restart = useCallback(() => setGen((g) => g + 1), [])
  const clear = useCallback(() => {
    dropPending.current()
    setBuffer(emptyLogBuffer())
  }, [])
  return owner === streamKey ? { buffer, state, restart, clear } : { buffer: NO_LINES, state: 'starting', restart, clear }
}
