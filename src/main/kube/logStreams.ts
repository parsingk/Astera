/** The live `kubectl logs` processes of the logs tabs: stdout is cut into whole lines and sent in batches, so a chatty
 *  container costs the renderer a message every few tens of milliseconds, not one per chunk. */
import { logsArgs } from '../../core/kube/cluster/args'
import { KUBECTL_MISSING, type LogMessage, type LogSpec } from '../../core/kube/cluster/types'
import type { KubectlStream, StreamExit } from '../../core/kube/stream'
import { streamFailureMessage } from './cluster'

export type { LogMessage, LogSpec }
export const LOG_FLUSH_MS = 50
/** A line longer than this is cut here: a process that never prints a newline would otherwise grow one string without end. */
export const LOG_LINE_MAX_CHARS = 1_000_000
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

/** One whole line, its CR removed, cut at the cap when it is longer. */
function pushLine(e: Entry, raw: string, max: number): void {
  let line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
  while (line.length > max) {
    e.pending.push(line.slice(0, max))
    line = line.slice(max)
  }
  e.pending.push(line)
}

export function createLogRegistry(deps: {
  stream(args: string[], h: Handlers): KubectlStream
  redact(stderr: string): string
  /** The cap on one line; only tests set it. */
  maxLineChars?: number
  emit(m: LogMessage): void
  later(fn: () => void, ms: number): { cancel(): void }
}): {
  start(logId: string, spec: LogSpec): void
  stop(logId: string): void
  stopAll(): void
  size(): number
} {
  const max = deps.maxLineChars ?? LOG_LINE_MAX_CHARS
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

  const spawn = (logId: string, spec: LogSpec, e: Entry): void => {
    const run = {}
    e.run = run
    const live = (): boolean => entries.get(logId) === e && e.run === run
    let carry = ''
    let stderr = ''
    e.stream = deps.stream(logsArgs(spec.ref, spec.options), {
      onStdout(chunk) {
        if (!live() || chunk === '') return
        // Only the new chunk is scanned for a newline: the carry is never re-split, so a long line costs linear time.
        const parts = chunk.split('\n')
        parts[0] = carry + parts[0]
        carry = parts.pop() ?? ''
        for (const p of parts) pushLine(e, p, max)
        while (carry.length > max) {
          e.pending.push(carry.slice(0, max))
          carry = carry.slice(max)
        }
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
        if (carry !== '') pushLine(e, carry, max)
        carry = ''
        flush(logId, e)
        entries.delete(logId)
        e.run = {}
        deps.emit(x.code === 0 ? { logId, kind: 'ended' } : { logId, kind: 'error', message: streamFailureMessage(x, deps.redact(stderr)) })
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
