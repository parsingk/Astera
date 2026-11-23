/** The live `kubectl port-forward` processes of the forwards: each reports once that it listens and once when it ends,
 *  and the local port a new forward proposes is checked here, where the network stack is. */
import { connect, createServer } from 'node:net'
import { forwardArgs, listeningPort, lostCause } from '../../core/kube/cluster/forward'
import type { ForwardMessage, ForwardSpec } from '../../core/kube/cluster/types'
import type { KubectlStream, StreamExit } from '../../core/kube/stream'
import { firstStderrLine, streamFailureMessage } from './cluster'

export type { ForwardMessage, ForwardSpec }
/** Before kubectl listens its first stderr line is what matters, so the head is kept; after, a forward lives for hours
 *  and kubectl's closing line comes last, so a tail of this size is kept instead. */
const STDERR_CAP = 4096

interface Handlers {
  onStdout(c: string): void
  onStderr(c: string): void
  onExit(e: StreamExit): void
}

interface Entry {
  /** Identifies the current spawn: output and exits from a stopped or replaced process are stale and ignored. */
  run: object
  stream: KubectlStream | null
}

export function createForwardRegistry(deps: {
  stream(args: string[], h: Handlers): KubectlStream
  redact(stderr: string): string
  emit(m: ForwardMessage): void
}): {
  start(forwardId: string, spec: ForwardSpec): void
  stop(forwardId: string): void
  stopAll(): void
  size(): number
} {
  const entries = new Map<string, Entry>()

  const halt = (e: Entry): void => {
    e.run = {}
    e.stream?.stop()
    e.stream = null
  }

  const spawn = (forwardId: string, spec: ForwardSpec, e: Entry): void => {
    const run = {}
    e.run = run
    const live = (): boolean => entries.get(forwardId) === e && e.run === run
    let carry = ''
    let stderr = ''
    let listening = false
    e.stream = deps.stream(forwardArgs(spec), {
      onStdout(chunk) {
        if (!live() || listening || chunk === '') return
        const parts = chunk.split('\n')
        parts[0] = carry + parts[0]
        carry = parts.pop() ?? ''
        for (const p of parts) {
          const local = listeningPort(p)
          if (local === null) continue
          listening = true
          carry = ''
          deps.emit({ forwardId, kind: 'listening', local })
          return
        }
      },
      onStderr(chunk) {
        if (!live()) return
        if (!listening) {
          if (stderr.length < STDERR_CAP) stderr += chunk
          return
        }
        stderr += chunk
        if (stderr.length > STDERR_CAP) {
          // Cut at the first newline so a partial line cannot pass for a real one.
          const tail = stderr.slice(-STDERR_CAP)
          const nl = tail.indexOf('\n')
          stderr = nl === -1 ? tail : tail.slice(nl + 1)
        }
      },
      onExit(x) {
        if (!live() || x.stopped) return
        e.stream = null
        entries.delete(forwardId)
        e.run = {}
        const redacted = deps.redact(stderr)
        const message = x.errorCode && x.code === null ? streamFailureMessage(x, redacted) : (firstStderrLine(redacted) ?? null)
        const cause = message?.includes('lost connection to pod') ? lostCause(redacted) : null
        deps.emit(cause ? { forwardId, kind: 'exit', message, cause } : { forwardId, kind: 'exit', message })
      }
    })
  }

  return {
    start(forwardId, spec) {
      const old = entries.get(forwardId)
      if (old) halt(old)
      const e: Entry = { run: {}, stream: null }
      entries.set(forwardId, e)
      // The stream reads kubectl's path and environment from the settings before it starts, which can throw: the
      // forward then ends as one whose kubectl could not start does.
      try {
        spawn(forwardId, spec, e)
      } catch (err) {
        entries.delete(forwardId)
        e.run = {}
        e.stream = null
        deps.emit({ forwardId, kind: 'exit', message: deps.redact(err instanceof Error ? err.message : String(err)) })
      }
    },
    stop(forwardId) {
      const e = entries.get(forwardId)
      if (!e) return
      entries.delete(forwardId)
      halt(e)
    },
    stopAll() {
      for (const e of entries.values()) halt(e)
      entries.clear()
    },
    size: () => entries.size
  }
}

/** True when the port is free on 127.0.0.1 right now (see realPortProbe). */
export type PortProbe = (port: number) => Promise<boolean>

export async function pickLocalPort(wanted: number, probe: PortProbe, anyFree: () => Promise<number>): Promise<number> {
  return (await probe(wanted)) ? wanted : await anyFree()
}

/** True when nothing answers on 127.0.0.1:<port>: a TCP connect there is refused (a timeout counts as busy). */
const refusesConnections = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (free: boolean): void => {
      socket.destroy()
      resolve(free)
    }
    socket.setTimeout(500, () => done(false))
    socket.once('connect', () => done(false))
    socket.once('error', (e: NodeJS.ErrnoException) => done(e.code === 'ECONNREFUSED'))
  })

/** A port is free when 127.0.0.1:<port> can be bound and nothing answers a connect there. The bind alone is not enough:
 *  on Windows it succeeds beside another program's 0.0.0.0 or :: listener, which kubectl's 127.0.0.1 bind would then
 *  shadow. (`exclusive: true` only concerns Node's cluster module, not the operating system.) */
export const realPortProbe: PortProbe = async (port) => {
  const bound = await new Promise<boolean>((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen({ host: '127.0.0.1', port }, () => server.close(() => resolve(true)))
  })
  return bound && (await refusesConnections(port))
}

/** A port the system hands out for 127.0.0.1, read before the socket is closed again. */
export const realAnyFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
