/** The live `kubectl get --watch` processes of the cluster view, bounded so a busy window cannot fork-bomb the machine. */
import { maskSecretPair } from '../../core/kube/objects'
import { listArgs } from '../../core/kube/cluster/args'
import { createJsonSplitter, toWatchEvents } from '../../core/kube/cluster/watch'
import { KUBECTL_MISSING, type WatchMessage, type WatchSpec } from '../../core/kube/cluster/types'
import type { KubectlStream, StreamExit } from '../../core/kube/stream'
import { firstStderrLine, isForbidden } from './cluster'

export const MAX_WATCHES = 6
export const RESTART_DELAY_MS = 1000
/** Only the first stderr line is reported, so there is no need to keep more than this. */
const STDERR_CAP = 4096

interface Handlers {
  onStdout(c: string): void
  onStderr(c: string): void
  onExit(e: StreamExit): void
}

interface Entry {
  spec: WatchSpec
  /** Identifies the current spawn: output and exits from any other process of this id are stale and ignored. */
  run: object
  stream: KubectlStream | null
  timer: { cancel(): void } | null
}

export function createWatchRegistry(deps: {
  stream(args: string[], h: Handlers): KubectlStream
  redact(stderr: string): string
  emit(m: WatchMessage): void
  later(fn: () => void, ms: number): { cancel(): void }
}): {
  watch(id: string, spec: WatchSpec): { ok: true } | { ok: false; reason: 'limit' }
  unwatch(id: string): void
  stopAll(): void
  size(): number
} {
  const entries = new Map<string, Entry>()

  const halt = (e: Entry): void => {
    e.timer?.cancel()
    e.timer = null
    e.run = {}
    e.stream?.stop()
    e.stream = null
  }

  const spawn = (id: string, e: Entry): void => {
    const run = {}
    e.run = run
    e.timer = null
    const live = (): boolean => entries.get(id) === e && e.run === run
    const splitter = createJsonSplitter()
    let stderr = ''
    e.stream = deps.stream(listArgs(e.spec, true), {
      onStdout(chunk) {
        if (!live()) return
        for (const p of splitter.push(chunk)) {
          if (!p.ok) continue
          // A page of a big list is many events, each Secret of it masked like a Secret of its own event.
          for (const ev of toWatchEvents(p.value)) {
            const object = ev.object.kind === 'Secret' ? (maskSecretPair(ev.object, null)[0] ?? ev.object) : ev.object
            deps.emit({ watchId: id, kind: 'event', event: { type: ev.type, object } })
          }
        }
      },
      onStderr(chunk) {
        if (live() && stderr.length < STDERR_CAP) stderr += chunk
      },
      onExit(x) {
        if (!live() || x.stopped) return
        e.stream = null
        if (x.code === 0) {
          deps.emit({ watchId: id, kind: 'resync' })
          e.timer = deps.later(() => {
            if (entries.get(id) === e && e.run === run) spawn(id, e)
          }, RESTART_DELAY_MS)
          return
        }
        const first = firstStderrLine(deps.redact(stderr))
        const message =
          first ?? (x.code !== null ? `kubectl exited ${x.code}` : x.errorCode === 'ENOENT' ? KUBECTL_MISSING : (x.errorCode ?? 'kubectl exited'))
        entries.delete(id)
        e.run = {}
        deps.emit(isForbidden(stderr) ? { watchId: id, kind: 'error', message, forbidden: true } : { watchId: id, kind: 'error', message })
      }
    })
  }

  return {
    watch(id, spec) {
      const old = entries.get(id)
      if (!old && entries.size >= MAX_WATCHES) return { ok: false, reason: 'limit' }
      if (old) halt(old)
      const e: Entry = { spec, run: {}, stream: null, timer: null }
      entries.set(id, e)
      spawn(id, e)
      return { ok: true }
    },
    unwatch(id) {
      const e = entries.get(id)
      if (!e) return
      entries.delete(id)
      halt(e)
    },
    stopAll() {
      for (const e of entries.values()) halt(e)
      entries.clear()
    },
    size: () => entries.size
  }
}
