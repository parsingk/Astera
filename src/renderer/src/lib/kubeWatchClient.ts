// The renderer's side of the cluster watches (spec K4, §5): main sends every watch's messages on the one 'kube:watch'
// channel, and this hands each to the subscription its watchId names. The route is in place before main is asked, so a
// message that beats the answer is not lost, and gone once stopped, so output a dying kubectl still flushes is dropped.
import type { WatchMessage, WatchSpec } from '../../../core/kube/cluster/types'

export interface WatchApi {
  watch(watchId: string, spec: WatchSpec): Promise<{ ok: true } | { ok: false; reason: 'limit' }>
  unwatch(watchId: string): Promise<void>
  on(cb: (m: WatchMessage) => void): () => void
}

export type WatchSubscription = { ok: true; stop(): void } | { ok: false; reason: 'limit' }

export interface WatchClient {
  /** `limit`: main already runs MAX_WATCHES; nothing is kept for this one. Rejects when the IPC call does. */
  subscribe(spec: WatchSpec, cb: (m: WatchMessage) => void): Promise<WatchSubscription>
}

export function createWatchClient(api: WatchApi, newId: () => string = () => crypto.randomUUID()): WatchClient {
  const routes = new Map<string, (m: WatchMessage) => void>()
  // Listening only while something is subscribed, so a closed view leaves no listener behind.
  let off: (() => void) | null = null

  const drop = (id: string): void => {
    routes.delete(id)
    if (routes.size === 0 && off) {
      off()
      off = null
    }
  }

  return {
    async subscribe(spec, cb) {
      const id = newId()
      routes.set(id, cb)
      off ??= api.on((m) => routes.get(m.watchId)?.(m))
      let answer: Awaited<ReturnType<WatchApi['watch']>>
      try {
        answer = await api.watch(id, spec)
      } catch (err) {
        drop(id)
        throw err
      }
      if (!answer.ok) {
        drop(id)
        return answer
      }
      let stopped = false
      return {
        ok: true,
        stop() {
          if (stopped) return
          stopped = true
          drop(id)
          // Main kills the process; a failed call here leaves nothing the renderer could do differently.
          api.unwatch(id).catch(() => {})
        }
      }
    }
  }
}
