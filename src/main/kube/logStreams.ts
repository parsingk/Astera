/** The live `kubectl logs` processes of the logs tabs: stdout is cut into whole lines and sent in batches, so a chatty
 *  container costs the renderer a message every few tens of milliseconds, not one per chunk. */
import { logsArgs } from '../../core/kube/cluster/args'
import { KUBECTL_MISSING, type LogMessage, type LogSpec } from '../../core/kube/cluster/types'
import type { KubectlStream, StreamExit } from '../../core/kube/stream'
import { firstStderrLine } from './cluster'

export type { LogMessage, LogSpec }
export const LOG_FLUSH_MS = 50
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
  timer: { cancel(): void } | null
  /** Whole lines waiting for the next flush. */
  pending: string[]
}

export function createLogRegistry(deps: {
  stream(args: string[], h: Handlers): KubectlStream
  redact(stderr: string): string
  emit(m: LogMessage): void
  later(fn: () => void, ms: number): { cancel(): void }
}): {
  start(logId: string, spec: LogSpec): void
  stop(logId: string): void
  stopAll(): void
  size(): number
} {
  const entries = new Map<string, Entry>()

  const halt = (e: Entry): void => {
    e.timer?.cancel()
    e.timer = null
    e.run = {}
    e.pending = []
    e.stream?.stop()
    e.stream = null
  }

  const flush = (logId: string, e: Entry): void => {
    e.timer?.cancel()
    e.timer = null
    if (e.pending.length === 0) return
    const lines = e.pending
    e.pending = []
    deps.emit({ logId, kind: 'lines', lines })
  }

  const failMessage = (x: StreamExit, stderr: string): string =>
    firstStderrLine(deps.redact(stderr)) ??
    (x.code !== null ? `kubectl exited ${x.code}` : x.errorCode === 'ENOENT' ? KUBECTL_MISSING : (x.errorCode ?? 'kubectl exited'))

  const spawn = (logId: string, spec: LogSpec, e: Entry): void => {
    const run = {}
    e.run = run
    const live = (): boolean => entries.get(logId) === e && e.run === run
    let carry = ''
    let stderr = ''
    e.stream = deps.stream(logsArgs(spec.ref, spec.options), {
      onStdout(chunk) {
        if (!live()) return
        const parts = (carry + chunk).split('\n')
        carry = parts.pop() ?? ''
        for (const p of parts) e.pending.push(p.endsWith('\r') ? p.slice(0, -1) : p)
        if (e.pending.length > 0 && !e.timer) {
          e.timer = deps.later(() => {
            e.timer = null
            if (live()) flush(logId, e)
          }, LOG_FLUSH_MS)
        }
      },
      onStderr(chunk) {
        if (live() && stderr.length < STDERR_CAP) stderr += chunk
      },
      onExit(x) {
        if (!live() || x.stopped) return
        e.stream = null
        if (carry !== '') e.pending.push(carry.endsWith('\r') ? carry.slice(0, -1) : carry)
        carry = ''
        flush(logId, e)
        entries.delete(logId)
        e.run = {}
        deps.emit(x.code === 0 ? { logId, kind: 'ended' } : { logId, kind: 'error', message: failMessage(x, stderr) })
      }
    })
  }

  return {
    start(logId, spec) {
      const old = entries.get(logId)
      if (old) halt(old)
      const e: Entry = { run: {}, stream: null, timer: null, pending: [] }
      entries.set(logId, e)
      // The stream reads kubectl's path and environment from the settings before it starts, which can throw: the log
      // then fails as a kubectl that could not start does.
      try {
        spawn(logId, spec, e)
      } catch (err) {
        entries.delete(logId)
        e.run = {}
        e.stream = null
        deps.emit({ logId, kind: 'error', message: deps.redact(err instanceof Error ? err.message : String(err)) })
      }
    },
    stop(logId) {
      const e = entries.get(logId)
      if (!e) return
      entries.delete(logId)
      halt(e)
    },
    stopAll() {
      for (const e of entries.values()) halt(e)
      entries.clear()
    },
    size: () => entries.size
  }
}
