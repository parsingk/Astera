/** What the cluster view shows and how it starts, plus the batching of watch events. Imported by the renderer: no `node:` here. */
import type { K8sObject } from '../objects'
import type { KubeContexts } from '../types'
import { KIND_GROUPS } from './kinds'
import type { CountInfo, GroupId, WatchEvent } from './types'
import { keyOf } from './watch'

export type DetailTab = 'summary' | 'yaml' | 'events' | 'describe' | 'pods'
/** `namespace` null: All namespaces. `selected`: the selected row's uid. `sort.by`: a column index of the picked kind. */
export interface ClusterViewState { context: string | null; namespace: string | null; resource: string; selected: string | null; filter: string; sort: { by: number; dir: 'asc' | 'desc' }; expanded: GroupId[]; detailTab: DetailTab }

export const memoryKey = (root: string): string => `kube.cluster.${root}`

/** Remembered by K2 per bottom-panel root; anything that does not parse to that shape is forgotten. */
export function readMemory(raw: string | null): { context: string; namespace: string | null } | null {
  if (raw === null) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const { context, namespace } = v as { context?: unknown; namespace?: unknown }
  if (typeof context !== 'string' || context === '') return null
  if (typeof namespace !== 'string' && namespace !== null) return null
  return { context, namespace }
}

const FIRST_COLUMN = { by: 0, dir: 'asc' } as const

const namespaceOf = (contexts: KubeContexts, context: string | null): string =>
  contexts.contexts.find((c) => c.name === context)?.namespace ?? 'default'

/** Memory wins even when its context is gone: falling back to another cluster is what C11 forbids. */
export function initialView(memory: { context: string; namespace: string | null } | null, contexts: KubeContexts): ClusterViewState {
  const picked = memory ?? { context: contexts.current, namespace: namespaceOf(contexts, contexts.current) }
  return { ...picked, resource: 'pods', selected: null, filter: '', sort: FIRST_COLUMN, expanded: ['workloads'], detailTab: 'summary' }
}

/** Not when kubeconfig could not be read: it then lists no contexts, so nothing is known to be missing, and the view
 *  shows the read's error (`contextsFailure`) instead of calling the remembered cluster missing. */
export function contextMissing(s: ClusterViewState, contexts: KubeContexts): boolean {
  return contexts.error === undefined && s.context !== null && !contexts.contexts.some((c) => c.name === s.context)
}

/** Why kubeconfig could not be read: the first line of kubectl's (redacted) stderr, else its error code; null when it
 *  was read. */
export function contextsFailure(contexts: KubeContexts): string | null {
  const e = contexts.error
  if (e === undefined) return null
  return e.stderr.split(/\r?\n/).map((l) => l.trim()).find((l) => l) ?? e.errorCode ?? ''
}

const isFixed = (resource: string): boolean => KIND_GROUPS.some((g) => g.kinds.some((k) => k.resource === resource))

/** The other cluster's namespaces, objects and CRDs are not this one's: its own namespace (else default), nothing
 *  selected, and a custom kind gives way to Pods since the other cluster may not serve it. */
export function withContext(s: ClusterViewState, context: string, contexts: KubeContexts): ClusterViewState {
  return { ...s, context, namespace: namespaceOf(contexts, context), resource: isFixed(s.resource) ? s.resource : 'pods', selected: null, sort: FIRST_COLUMN }
}

/** "All namespaces" adds the Namespace column, so a column index would point at another column: the sort starts over. */
export function withNamespace(s: ClusterViewState, namespace: string | null): ClusterViewState {
  return { ...s, namespace, selected: null, sort: FIRST_COLUMN }
}

/** Another kind has other columns: the sort starts over. The name filter stays, to follow one name across kinds. */
export function withKind(s: ClusterViewState, resource: string): ClusterViewState {
  return { ...s, resource, selected: null, sort: FIRST_COLUMN }
}

export function withSort(s: ClusterViewState, by: number): ClusterViewState {
  const dir = s.sort.by === by && s.sort.dir === 'asc' ? 'desc' : 'asc'
  return { ...s, sort: { by, dir } }
}

/** A new read's counts. A kind it could not count (`count` null, no reason) keeps the count read last time for the same
 *  context and namespace, marked stale, so a failed read never shows a false 0 or drops a problem dot; a kind never read
 *  stays unknown. Only the kinds the read asked for are kept (custom kinds are asked only while their group is open). */
export function mergeCounts(prev: Readonly<Record<string, CountInfo>> | null, next: Readonly<Record<string, CountInfo>>): Record<string, CountInfo> {
  const out: Record<string, CountInfo> = {}
  for (const [resource, info] of Object.entries(next)) {
    const last = prev?.[resource]
    const keep = info.count === null && info.forbidden === undefined && last !== undefined && last.count !== null
    out[resource] = keep ? { count: last.count, attention: last.attention, stale: true } : info
  }
  return out
}

/** Watch events waiting for the next frame, only the last per object: what one by one would leave, and a window that
 *  draws nothing for a while (minimised) holds no more than one entry per object. `reset`: a resync came. */
export interface PendingWatch { reset: boolean; changes: Map<string, WatchEvent> }

export const noPending = (): PendingWatch => ({ reset: false, changes: new Map() })

/** Mutates `p`, the accumulator of one frame. */
export function queueWatch(p: PendingWatch, m: WatchEvent | 'resync'): void {
  if (m === 'resync') {
    p.reset = true
    p.changes.clear()
    return
  }
  p.changes.set(keyOf(m.object), m)
}

/** How long a relist must go quiet before it replaces the rows. kubectl prints the relisted objects at once, but they
 *  reach the view as one message each, over several frames. */
export const RELIST_SETTLE_MS = 250
/** A relist still coming after this long (a namespace whose Events never stop) replaces the rows anyway, so the table
 *  does not stay on the old list. */
export const RELIST_MAX_MS = 3000

/** Hands a watch's messages to `apply` in bursts: live changes once per frame; after a resync, the relisted objects in
 *  one step once they stop coming, so the table keeps its old rows meanwhile instead of emptying, or shrinking to the
 *  first objects and filling up again. A relist that brings nothing (an empty kind) is never applied here: the caller
 *  learns that from the counts. */
export function createWatchBatcher(o: {
  apply(p: PendingWatch): void
  frame(fn: () => void): () => void
  later(fn: () => void, ms: number): () => void
}): { push(m: WatchEvent | 'resync'): void; stop(): void } {
  let pending = noPending()
  let cancelFrame: (() => void) | null = null
  let cancelSettle: (() => void) | null = null
  let cancelMax: (() => void) | null = null
  const stop = (): void => {
    cancelFrame?.()
    cancelSettle?.()
    cancelMax?.()
    cancelFrame = cancelSettle = cancelMax = null
  }
  const flush = (): void => {
    stop()
    const burst = pending
    pending = noPending()
    o.apply(burst)
  }
  return {
    push(m) {
      queueWatch(pending, m)
      // A resync drops what was queued, and the wait starts with the relist's first object: kubectl may take seconds
      // to start (an exec auth plugin), and the old rows stay until then.
      if (m === 'resync') return stop()
      if (!pending.reset) {
        cancelFrame ??= o.frame(flush)
        return
      }
      cancelSettle?.()
      cancelSettle = o.later(flush, RELIST_SETTLE_MS)
      cancelMax ??= o.later(flush, RELIST_MAX_MS)
    },
    stop
  }
}

/** One copy of the list per burst, not one per event (a big namespace's initial list arrives as N ADDED events). */
export function applyPending(list: ReadonlyMap<string, K8sObject>, p: PendingWatch): Map<string, K8sObject> {
  const next = p.reset ? new Map<string, K8sObject>() : new Map(list)
  for (const [key, e] of p.changes) {
    if (e.type === 'DELETED') next.delete(key)
    else next.set(key, e.object)
  }
  return next
}
