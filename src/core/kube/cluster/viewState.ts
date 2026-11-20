/** What the cluster view shows and how it starts, plus the batching of watch events. Imported by the renderer: no `node:` here. */
import type { K8sObject } from '../objects'
import type { KubeContexts } from '../types'
import { KIND_GROUPS } from './kinds'
import type { GroupId, WatchEvent } from './types'
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

export function contextMissing(s: ClusterViewState, contexts: KubeContexts): boolean {
  return s.context !== null && !contexts.contexts.some((c) => c.name === s.context)
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

/** One copy of the list per burst, not one per event (a big namespace's initial list arrives as N ADDED events). */
export function applyPending(list: ReadonlyMap<string, K8sObject>, p: PendingWatch): Map<string, K8sObject> {
  const next = p.reset ? new Map<string, K8sObject>() : new Map(list)
  for (const [key, e] of p.changes) {
    if (e.type === 'DELETED') next.delete(key)
    else next.set(key, e.object)
  }
  return next
}
