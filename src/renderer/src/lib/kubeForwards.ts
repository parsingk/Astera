// The port forwards the cluster view started (spec 4.9): one row per forward, kept after it ends so the person sees how it
// ended and can start it again. useKubeForwards feeds this list from main's 'kube:forward' messages.
import { forwardReason } from '../../../core/kube/cluster/forward'
import type { ForwardMessage, ForwardSpec } from '../../../core/kube/cluster/types'

export type ForwardState = 'connecting' | 'connected' | 'stopped' | 'disconnected' | 'failed'

/** connectedAt / endedAt in ms; reason: forwardReason of the exit message (disconnected, failed). */
export interface KubeForward {
  id: string
  spec: ForwardSpec
  state: ForwardState
  reason: string | null
  connectedAt: number | null
  endedAt: number | null
}

export const isLive = (f: KubeForward): boolean => f.state === 'connecting' || f.state === 'connected'

const change = (list: readonly KubeForward[], id: string, next: (f: KubeForward) => KubeForward): KubeForward[] =>
  list.map((f) => (f.id === id ? next(f) : f))

export function addForward(list: readonly KubeForward[], id: string, spec: ForwardSpec): KubeForward[] {
  return [...list, { id, spec, state: 'connecting', reason: null, connectedAt: null, endedAt: null }]
}

/** What main said of a forward: kubectl is listening, or the forward ended. A message for a row that is not live (stopped
 *  by the person, or already ended) or for no row changes nothing. */
export function forwardMessage(list: readonly KubeForward[], m: ForwardMessage, now: number): KubeForward[] {
  return change(list, m.forwardId, (f) => {
    if (!isLive(f)) return f
    if (m.kind === 'listening') return f.state === 'connecting' ? { ...f, state: 'connected', connectedAt: now } : f
    return {
      ...f,
      state: f.state === 'connected' ? 'disconnected' : 'failed',
      reason: forwardReason(m.message),
      endedAt: now
    }
  })
}

export function stopForward(list: readonly KubeForward[], id: string, now: number): KubeForward[] {
  return change(list, id, (f) => (isLive(f) ? { ...f, state: 'stopped', endedAt: now } : f))
}

/** An ended row goes back to connecting; the caller starts it again under the same id. */
export function reconnectForward(list: readonly KubeForward[], id: string): KubeForward[] {
  return change(list, id, (f) =>
    isLive(f) ? f : { ...f, state: 'connecting', reason: null, connectedAt: null, endedAt: null }
  )
}

export function removeForward(list: readonly KubeForward[], id: string): KubeForward[] {
  return list.filter((f) => f.id !== id)
}

/** How long the forward has run: so far while connected, until it ended after it had connected, else null. */
export function forwardRunMs(f: KubeForward, now: number): number | null {
  if (f.state === 'connected' && f.connectedAt !== null) return now - f.connectedAt
  if (!isLive(f) && f.connectedAt !== null && f.endedAt !== null) return f.endedAt - f.connectedAt
  return null
}
