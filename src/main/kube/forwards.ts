/** The live `kubectl port-forward` processes of the forwards: each reports once that it listens and once when it ends,
 *  and the local port a new forward proposes is checked here, where the network stack is. */
import { createServer } from 'node:net'
import { forwardArgs, listeningPort } from '../../core/kube/cluster/forward'
import type { ForwardMessage, ForwardSpec } from '../../core/kube/cluster/types'
import type { KubectlStream, StreamExit } from '../../core/kube/stream'
import { firstStderrLine, streamFailureMessage } from './cluster'

export type { ForwardMessage, ForwardSpec }
/** Only the first stderr line is reported, so there is no need to keep more than this. */
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
        if (live() && stderr.length < STDERR_CAP) stderr += chunk
      },
      onExit(x) {
        if (!live() || x.stopped) return
        e.stream = null
        entries.delete(forwardId)
        e.run = {}
        const redacted = deps.redact(stderr)
        const message = x.errorCode && x.code === null ? streamFailureMessage(x, redacted) : (firstStderrLine(redacted) ?? null)
        deps.emit({ forwardId, kind: 'exit', message })
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

/** True when 127.0.0.1:<port> can be bound right now. */
export type PortProbe = (port: number) => Promise<boolean>

export async function pickLocalPort(wanted: number, probe: PortProbe, anyFree: () => Promise<number>): Promise<number> {
  return (await probe(wanted)) ? wanted : await anyFree()
}

/** Binds 127.0.0.1:<port> exclusively and lets go at once; any error (in use, refused) means it cannot be used. */
export const realPortProbe: PortProbe = (port) =>
  new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve(true)))
  })

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
