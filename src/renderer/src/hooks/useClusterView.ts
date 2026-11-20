// The cluster view's state and live data (spec §4.2 to §4.5, K2, K4, §4.12): what the person picked, remembered per
// bottom-panel root; the cluster's namespaces, custom kinds and counts; the picked kind's list and the selected object,
// followed by watches only while the view is seen; and the detail's one-shot reads for the tab that shows.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { K8sObject } from '../../../core/kube/objects'
import type { KubeContexts } from '../../../core/kube/types'
import { columnsOf, filterRows, rowsOf, sortRows } from '../../../core/kube/cluster/columns'
import { KIND_GROUPS, crdKinds, kindDefOf } from '../../../core/kube/cluster/kinds'
import { ownerRefOf, podSelectorOf } from '../../../core/kube/cluster/summary'
import type { Column, CountInfo, GroupId, KindDef, KindGroup, ObjectRef, Read, Row, WatchEvent, WatchSpec } from '../../../core/kube/cluster/types'
import {
  applyPending,
  contextMissing,
  contextsFailure,
  createWatchBatcher,
  initialView,
  memoryKey,
  mergeCounts,
  readMemory,
  withContext,
  withKind,
  withNamespace,
  withSort,
  type ClusterViewState,
  type DetailTab
} from '../../../core/kube/cluster/viewState'
import { keyOf } from '../../../core/kube/cluster/watch'
import { createWatchClient, type WatchClient } from '../lib/kubeWatchClient'
import { createLatest } from '../lib/latest'
import { startSerialPoll } from '../lib/serialPoll'
import { errText } from './useFileOps'

export const COUNTS_INTERVAL_MS = 30_000

/** `paused`: nothing is watched (not seen, no usable context, or the watch ended); `limit`: main refused the watch. */
export type ClusterLive = 'live' | 'paused' | { error: string } | 'limit'

export interface ClusterViewModel {
  /** What the person picked: context, namespace (null: All namespaces), kind, selected row uid, filter, sort, open groups, detail tab. */
  view: ClusterViewState
  /** kubeconfig's contexts, the list the manifests picker shows; null until read. */
  contexts: KubeContexts | null
  /** The picked context is not in kubeconfig: the pill shows it missing and nothing is read or watched (no fallback, C11). */
  contextMissing: boolean
  /** kubeconfig could not be read (kubectl's first line): shown instead of a missing cluster, and nothing is read. */
  contextsError: string | null
  /** The cluster's namespace names for the pill, which adds "All namespaces" first itself; null until read or when the read failed. */
  namespaces: string[] | null
  /** Listing namespaces is Forbidden: the pill becomes a free-text field. */
  namespacesForbidden: boolean
  /** The tree's fixed groups and kinds (the custom group comes with no kinds of its own). */
  groups: KindGroup[]
  /** The cluster's custom resource kinds, listed under the custom group. */
  customKinds: KindDef[]
  /** Count (null: it could not be read), problem dot and Forbidden reason per resource, for the picked context and
   *  namespace; a count a later read could not get again is the last one, marked stale. Empty until read. */
  counts: Record<string, CountInfo>
  /** The picked kind; null while a custom kind's CRD is not known (yet). */
  kind: KindDef | null
  /** The table's columns for the picked kind (Namespace first under All namespaces). */
  columns: Column[]
  /** The table's rows: the live list (read once when the watch is refused at the limit), filtered by name and sorted. */
  rows: Row[]
  /** The list has not arrived yet, so empty `rows` do not mean an empty kind. */
  loading: boolean
  /** The one-shot read of the list, made when its watch was refused at the limit, failed (its line): the table says so
   *  where the rows would be. */
  listFailed: string | null
  /** The selected object's latest content (a Secret masked); kept when it is deleted. */
  selected: K8sObject | null
  /** Where the selected object lives, for reads, reveal, the menu and the editor tab. */
  selectedRef: ObjectRef | null
  /** The selected object was deleted in the cluster: `selected` is its last content, to show greyed. */
  deleted: boolean
  /** The selected object's owner chain, nearest first, up to two levels (a Pod's ReplicaSet, then its Deployment). */
  owners: ObjectRef[]
  /** The selected object's events, newest first, read while the Summary or Events tab shows and again (throttled) when the
   *  object changes; null until read. */
  events: Read<{ events: K8sObject[] }> | null
  /** `kubectl describe` text, read while the describe tab shows and again when the object changes; null until read. */
  describe: Read<{ text: string }> | null
  /** The Pods the selected object selects, read while the Pods tab shows and again when the object changes; null until
   *  read, or when it selects none. */
  pods: Read<{ columns: Column[]; rows: Row[] }> | null
  /** Whether the table and the detail follow the cluster. */
  live: ClusterLive
  /** Why `live` is 'paused', when a watch says so; null when the view is paused only because it is not seen or has
   *  nothing to follow. */
  pauseReason: PauseReason | null
  /** The picked kind may not be listed (kubectl's Forbidden line): the table says so instead of rows, and the view is
   *  not failed (§4.3). */
  listForbidden: string | null
  /** The selected object's watch failed (kubectl's line): the detail says so and keeps its content, and the view stays
   *  as it is (§4.3). */
  detailError: string | null
  /** Picks a context: its kubeconfig namespace (else default), nothing selected; remembered for this root. */
  setContext(name: string): void
  /** Picks a namespace (null: All namespaces); remembered for this root. */
  setNamespace(namespace: string | null): void
  /** Shows a kind by its resource; the selection goes, the filter stays. */
  selectKind(resource: string): void
  /** Selects a row of the table by uid (null: none). */
  select(uid: string | null): void
  /** Selects an object of any kind, switching the table to it: the owner link, a row of the Pods tab. */
  selectRef(ref: ObjectRef): void
  setFilter(text: string): void
  /** Sorts by a column index; the sorted column again flips the direction. */
  sortBy(column: number): void
  toggleGroup(id: GroupId): void
  setDetailTab(tab: DetailTab): void
  /** Reads everything again and lists afresh. */
  refresh(): void
  /** The error line's retry: the same fresh start as refresh. */
  retry(): void
}

/** What one watch is doing; `ended`: it stopped without an error; `forbidden`: kubectl was refused the list. */
export type WatchState = 'live' | 'limit' | 'ended' | { error: string; forbidden?: true }
/** A value kept with what it was read for (a context, a namespace, a selection), so it never shows for another. */
type Keyed<T> = { key: string; value: T }

const valueFor = <T>(k: Keyed<T> | null, key: string | null): T | null => (k !== null && k.key === key ? k.value : null)

const NO_CONTEXTS: KubeContexts = { contexts: [], current: null }
const NO_OBJECTS: ReadonlyMap<string, K8sObject> = new Map()
const NO_CRDS = { kinds: [] as KindDef[], objects: [] as K8sObject[] }
const NO_COUNTS: Record<string, CountInfo> = {}
const FIXED_KINDS = KIND_GROUPS.flatMap((g) => g.kinds)

/** The list's objects when they were listed for `key` (the picked context, namespace and kind), else none: until the
 *  new list starts, the rows of the last one would be drawn under the new kind's columns and could be selected as one
 *  of its objects. */
export function objectsFor(list: Keyed<ReadonlyMap<string, K8sObject>> | null, key: string | null): ReadonlyMap<string, K8sObject> {
  return valueFor(list, key) ?? NO_OBJECTS
}

function recall(root: string): { context: string; namespace: string | null } | null {
  try {
    return readMemory(localStorage.getItem(memoryKey(root)))
  } catch {
    return null // storage off: start on the current context, as the first time does
  }
}

function remember(root: string, context: string | null, namespace: string | null): void {
  if (context === null) return
  try {
    localStorage.setItem(memoryKey(root), JSON.stringify({ context, namespace }))
  } catch {
    // Storage off or full: the pick holds for this run and is forgotten after a restart.
  }
}

const refOf = (context: string, kind: KindDef, o: K8sObject): ObjectRef => ({
  context,
  namespace: kind.namespaced ? (o.metadata.namespace ?? null) : null,
  resource: kind.resource,
  kind: kind.kind,
  name: o.metadata.name ?? ''
})

/** The CRD a custom kind came from: its printer columns are the table's. */
const crdOf = (resource: string, crds: K8sObject[]): K8sObject | undefined => crds.find((c) => crdKinds([c])[0]?.resource === resource)

/** `fn` at the next animation frame, or after a short timeout where there are none; returns the cancel. */
function nextFrame(fn: () => void): () => void {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(fn)
    return () => cancelAnimationFrame(id)
  }
  const id = setTimeout(fn, 16)
  return () => clearTimeout(id)
}

/** A watch for the life of an effect; returns its cleanup. A subscription answering after the cleanup is stopped at
 *  once, and its messages, like any after the cleanup, go nowhere. The editor tab of a cluster object follows its
 *  object with it too (KubeObjectTab). */
export function follow(client: WatchClient, spec: WatchSpec, onEvent: (m: WatchEvent | 'resync') => void, onState: (s: WatchState) => void): () => void {
  let alive = true
  let stop: (() => void) | null = null
  onState('live')
  client
    .subscribe(spec, (m) => {
      if (!alive) return
      if (m.kind === 'error') onState(m.forbidden ? { error: m.message, forbidden: true } : { error: m.message })
      else if (m.kind === 'ended') onState('ended')
      else onEvent(m.kind === 'resync' ? 'resync' : m.event)
    })
    .then(
      (r) => {
        if (!r.ok) {
          if (alive) onState('limit')
        } else if (alive) stop = r.stop
        else r.stop()
      },
      (err) => {
        if (alive) onState({ error: errText(err) })
      }
    )
  return () => {
    alive = false
    stop?.()
  }
}

/** A one-shot read that follows its object (final re-review R2): it reads at once, then again at each `again()`, one
 *  read at a time. An ask made while a read is on its way waits for that read to answer and apply, then reads once more
 *  however many asks came meanwhile, so an object that changes faster than a read takes still shows each answer instead
 *  of none. `stop` drops the answer on its way and the ask waiting. A read that fails applies nothing. */
export function createSerialRead<T>(o: { read(): Promise<T>; apply(value: T): void }): { again(): void; stop(): void } {
  let busy = false
  let waiting = false
  let stopped = false
  const run = (): void => {
    busy = true
    const done = (): void => {
      busy = false
      if (stopped || !waiting) return
      waiting = false
      run()
    }
    o.read().then(
      (value) => {
        if (!stopped) o.apply(value)
        done()
      },
      done
    )
  }
  run()
  return {
    again() {
      if (stopped) return
      if (busy) waiting = true
      else run()
    },
    stop() {
      stopped = true
      waiting = false
    }
  }
}

/** A one-shot read of the detail that follows its object while seen (spec §11): read when `source` comes (null reads
 *  nothing, and drops what is on its way) and when its `key` changes (another object, another tab, a refresh), and
 *  again at each move of `tick`, through createSerialRead. `read` and `apply` are taken with the key, so an answer is
 *  stored for what it was read for. A rejected read applies as a failed one. The editor tab of a cluster object uses it
 *  too. */
export function useFollowingRead<T>(source: { key: string; read(): Promise<Read<T>>; apply(value: Read<T>): void } | null, tick: number): void {
  const reader = useRef<{ again(): void; stop(): void } | null>(null)
  const readTick = useRef(tick)
  const key = source?.key ?? null
  useEffect(() => {
    if (source === null) return
    readTick.current = tick
    const r = createSerialRead({
      read: () => source.read().catch((err): Read<T> => ({ ok: false, message: errText(err) })),
      apply: source.apply
    })
    reader.current = r
    return () => {
      r.stop()
      reader.current = null
    }
    // `key` stands for `source`, which is a new object at every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  useEffect(() => {
    if (readTick.current === tick) return
    readTick.current = tick
    reader.current?.again()
  }, [tick])
}

/** At most this often the detail's one-shot reads follow a change of their object (a crash-looping Pod changes often). */
export const REREAD_MS = 2000

/** When a change of the followed object calls for its one-shot reads again: at once if the last such read is at least
 *  `ms` old, else once at the end of that window, which reads whatever the object is by then. The window starts at
 *  creation, since the object's reads have just run for its selection. */
export function createRereadThrottle(o: {
  ms: number
  now(): number
  later(fn: () => void, ms: number): () => void
  reread(): void
}): { changed(): void; stop(): void } {
  let last = o.now()
  let cancel: (() => void) | null = null
  const fire = (): void => {
    cancel = null
    last = o.now()
    o.reread()
  }
  return {
    changed() {
      if (cancel !== null) return
      const wait = last + o.ms - o.now()
      if (wait <= 0) fire()
      else cancel = o.later(fire, wait)
    },
    stop() {
      cancel?.()
      cancel = null
    }
  }
}

/** A number that moves on when the object `uid` changes (a new `version`), at most once every REREAD_MS: the detail's
 *  reads that do not follow by themselves (events, describe, Pods) take it as a dependency, so they follow the cluster
 *  while seen (spec §11). Another object starts its own window. The editor tab of a cluster object uses it too. */
export function useRereadTick(uid: string | null, version: string): number {
  const [tick, setTick] = useState(0)
  const seen = useRef<{ uid: string | null; version: string } | null>(null)
  const throttle = useRef<ReturnType<typeof createRereadThrottle> | null>(null)
  useEffect(() => {
    const was = seen.current
    seen.current = { uid, version }
    if (was === null || was.uid !== uid) {
      throttle.current?.stop()
      throttle.current = createRereadThrottle({
        ms: REREAD_MS,
        now: Date.now,
        later: (fn, ms) => {
          const timer = setTimeout(fn, ms)
          return () => clearTimeout(timer)
        },
        reread: () => setTick((t) => t + 1)
      })
    } else if (was.version !== version) throttle.current?.changed()
  }, [uid, version])
  useEffect(() => () => throttle.current?.stop(), [])
  return tick
}

/** How long a selection must stay before the detail's one-shot reads for it start (describe, events, Pods, the owner):
 *  rows passed over with quick clicks start none of their kubectl calls, which cannot be cancelled once asked. */
export const SELECTION_READ_DELAY_MS = 150

/** `value` once it has stayed the same for `ms`; until then the value that last did. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

/** The custom kinds a counts round asks for besides the fixed ones, as a key the rounds restart on: none ('') while their
 *  group is closed or this context's CRDs are not known yet, so the fixed kinds are counted at once (a context switch
 *  would otherwise show no counts until the CRDs answer), and the context's custom kinds once they are. */
export function customCountsKey(open: boolean, crdsKnown: boolean, customKinds: KindDef[]): string {
  return open && crdsKnown ? customKinds.map((k) => k.resource).join(',') : ''
}

/** The one-shot read of a list whose watch main refused at the limit. */
export type ListRead = 'pending' | 'done' | { error: string }

/** What the table says while it has no rows, from the list's own state rather than the view's `live` (which also
 *  follows the selected object): `loading` until the watch brings something (or the counts say the kind is empty), or,
 *  refused at the limit, until its one-shot read answers (`read` null: not asked yet); that read's failure; else
 *  `ready`, where no rows mean an empty kind. */
export function listState(o: { watch: WatchState; read: ListRead | null; fresh: boolean; size: number; saysEmpty: boolean }): 'loading' | 'ready' | { failed: string } {
  if (o.watch === 'limit') return o.read === null || o.read === 'pending' ? 'loading' : o.read === 'done' ? 'ready' : { failed: o.read.error }
  return o.watch === 'live' && o.fresh && o.size === 0 && !o.saysEmpty ? 'loading' : 'ready'
}

/** The list watch's failure, which fails the view; not a Forbidden refusal, which is the picked kind's answer (§4.3). */
export function listFailure(list: WatchState): { error: string } | null {
  return typeof list === 'object' && !list.forbidden ? list : null
}

/** Why the view is paused, for its live indicator (spec 4.2, "paused" with the reason): the picked kind may not be
 *  listed (kubectl's line), or a watch ended. */
export type PauseReason = { forbidden: string } | 'ended'

/** The reason `liveOf` gives 'paused' for these watches; null when it does not (live, at the limit, failed). */
export function pauseReasonOf(list: WatchState, pick: WatchState): PauseReason | null {
  if (typeof list === 'object') return list.forbidden ? { forbidden: list.error } : null
  if (list === 'limit' || pick === 'limit') return null
  return list === 'ended' || pick === 'ended' ? 'ended' : null
}

/** The view's live state from its two watches. Only the list's failure fails the view: the selected object's is the
 *  detail's to show (`detailError`), since an object the person may not read never fails the view (§4.3), and a kind
 *  the person may not list leaves nothing followed (`listForbidden` says why). */
export function liveOf(list: WatchState, pick: WatchState): ClusterLive {
  const failed = listFailure(list)
  if (failed !== null) return failed
  if (typeof list === 'object') return 'paused'
  if (list === 'limit' || pick === 'limit') return 'limit'
  return list === 'ended' || pick === 'ended' ? 'paused' : 'live'
}

export function useWatchClient(): WatchClient {
  const client = useRef<WatchClient | null>(null)
  client.current ??= createWatchClient({
    watch: (id, spec) => window.api.kube.cluster.watch(id, spec),
    unwatch: (id) => window.api.kube.cluster.unwatch(id),
    on: (cb) => window.api.on('kube:watch', cb)
  })
  return client.current
}

export function useClusterView(root: string, visible: boolean): ClusterViewModel {
  const api = window.api.kube.cluster
  const client = useWatchClient()
  const [contexts, setContexts] = useState<KubeContexts | null>(null)
  const [view, setView] = useState(() => initialView(recall(root), NO_CONTEXTS))
  /** Bumped by refresh and retry: every read and watch starts again. */
  const [gen, setGen] = useState(0)
  /** Bumped with the counts, so ages move on while nothing else changes. */
  const [tick, setTick] = useState(0)
  const [namespaces, setNamespaces] = useState<Keyed<Read<{ names: string[] }>> | null>(null)
  const [crds, setCrds] = useState<Keyed<typeof NO_CRDS> | null>(null)
  const [counts, setCounts] = useState<Keyed<Record<string, CountInfo>> | null>(null)
  const [list, setList] = useState<Keyed<ReadonlyMap<string, K8sObject>> | null>(null)
  /** Nothing has arrived since the list (re)started. */
  const [fresh, setFresh] = useState(true)
  const [listWatch, setListWatch] = useState<WatchState>('live')
  /** The one-shot read of the list made when its watch is refused at the limit, kept with the list it was made for. */
  const [listRead, setListRead] = useState<Keyed<ListRead> | null>(null)
  const [pick, setPick] = useState<Keyed<{ object: K8sObject; deleted: boolean }> | null>(null)
  const [pickWatch, setPickWatch] = useState<WatchState>('live')
  const [ownerUp, setOwnerUp] = useState<Keyed<K8sObject> | null>(null)
  const [events, setEvents] = useState<Keyed<Read<{ events: K8sObject[] }>> | null>(null)
  const [describe, setDescribe] = useState<Keyed<Read<{ text: string }>> | null>(null)
  const [pods, setPods] = useState<Keyed<Read<{ objects: K8sObject[] }>> | null>(null)

  const missing = contexts !== null && contextMissing(view, contexts)
  const contextsError = contexts !== null ? contextsFailure(contexts) : null
  /** The context reads and watches go to; null while contexts are unknown or could not be read, none is picked, or the
   *  picked one is missing. */
  const context = contexts !== null && contextsError === null && !missing ? view.context : null
  const crdsNow = valueFor(crds, context) ?? NO_CRDS
  const customKinds = crdsNow.kinds
  const kind = kindDefOf(view.resource, customKinds) ?? null
  const crd = kind !== null && !FIXED_KINDS.includes(kind) ? crdOf(kind.resource, crdsNow.objects) : undefined
  const listSpec: WatchSpec | null =
    context !== null && kind !== null
      ? { context, namespace: kind.namespaced ? view.namespace : null, namespaced: kind.namespaced, resource: kind.resource }
      : null
  const listKey = listSpec && JSON.stringify(listSpec)
  const countInfo = valueFor(counts, JSON.stringify([context, view.namespace])) ?? NO_COUNTS
  const kindCount = countInfo[view.resource]
  // A relist of an empty kind brings no event at all, so the counts are what says the old rows are gone: a 0 this round
  // read, not one kept from an earlier round. Not while the watch fails: the rows then stay as last seen (§4.12).
  const saysEmpty = listWatch === 'live' && kindCount?.count === 0 && !kindCount.forbidden && !kindCount.stale
  const listForbidden = typeof listWatch === 'object' && listWatch.forbidden ? listWatch.error : null
  const listed = objectsFor(list, listKey)
  /** Fresh too while the list effect has not yet started this list (the render that switched to it). */
  const listFresh = fresh || list?.key !== listKey
  // A refused list shows its reason, not rows a refresh may no longer be allowed to read.
  const objects = listForbidden !== null || (listFresh && saysEmpty) ? NO_OBJECTS : listed
  const selected = valueFor(pick, view.selected)
  const selectedRef = selected !== null && context !== null && kind !== null ? refOf(context, kind, selected.object) : null
  const selectedKey = selectedRef && JSON.stringify(selectedRef)
  const owner = selected !== null && context !== null ? ownerRefOf(selected.object, context) : null
  const ownerKey = owner && JSON.stringify(owner)
  const ownerObject = valueFor(ownerUp, ownerKey)
  const selector = selected !== null && kind !== null ? podSelectorOf(kind.kind, selected.object) : null
  const podsRead = selector === null ? null : valueFor(pods, view.selected)

  const now = { contexts, view, context, customKinds, kind, listSpec, objects, selected, selectedRef, owner, ownerObject, podsRead }
  const latest = useRef(now)
  latest.current = now

  // --- Contexts and what the person picked ---

  /** Bumped by every change of what is picked, so a `selectRef` read answering later is dropped instead of selecting an
   *  object of another context, namespace or kind. */
  const pickTicket = useRef(createLatest())

  const shownRoot = useRef(root)
  useEffect(() => {
    if (shownRoot.current === root) return
    shownRoot.current = root
    pickTicket.current.next()
    setView(initialView(recall(root), latest.current.contexts ?? NO_CONTEXTS))
  }, [root])

  useEffect(() => {
    if (!visible) return
    let alive = true
    window.api.kube.contexts().then(
      (c) => {
        if (!alive) return
        setContexts(c)
        // Nothing remembered: the kubeconfig's current context, now that it is known (K2).
        setView((v) => {
          if (v.context !== null) return v
          const first = initialView(null, c)
          return { ...v, context: first.context, namespace: first.namespace }
        })
      },
      (err) => {
        if (alive) setContexts({ ...NO_CONTEXTS, error: { stderr: errText(err) } })
      }
    )
    return () => {
      alive = false
    }
  }, [visible, gen])

  // --- Namespaces, custom kinds and counts ---

  useEffect(() => {
    if (!visible || context === null) return
    let alive = true
    api.namespaces(context).then(
      (r) => {
        if (!alive) return
        // A failed re-read keeps the last list (§4.12); Forbidden is an answer, and turns the pill into a text field.
        setNamespaces((prev) => (!r.ok && !r.forbidden && prev?.key === context && prev.value.ok ? prev : { key: context, value: r }))
      },
      () => {}
    )
    api.crds(context).then(
      (r) => {
        if (!alive) return
        // A new object for every answer, failed or not: the counts below follow each one.
        setCrds((prev) => ({ key: context, value: r.ok ? { kinds: r.kinds, objects: r.crds } : prev?.key === context ? prev.value : NO_CRDS }))
      },
      () => {
        if (alive) setCrds((prev) => ({ key: context, value: prev?.key === context ? prev.value : NO_CRDS }))
      }
    )
    return () => {
      alive = false
    }
  }, [visible, context, gen])

  // Counted when the view opens, again for another namespace, on refresh, and on a slow interval while seen (§4.3). One
  // request at a time, the next only an interval after the last answered, so a slow cluster is never asked twice at
  // once; nothing while the window is hidden. Not while the list's watch fails either: the cluster is not answering, and
  // retry starts the counts again; a Forbidden list is not that, and the counts are what greys such kinds in the tree.
  // Custom kinds are counted only while their group is open (customCountsKey): a cluster can serve hundreds.
  const customKey = customCountsKey(view.expanded.includes('custom'), crds !== null && crds.key === context, customKinds)
  const listFailed = listFailure(listWatch) !== null
  useEffect(() => {
    if (!visible || context === null || listFailed) return
    const namespace = view.namespace
    const key = JSON.stringify([context, namespace])
    const kinds = customKey === '' ? FIXED_KINDS : [...FIXED_KINDS, ...latest.current.customKinds]
    let alive = true
    let first = true
    const stop = startSerialPoll(
      async () => {
        // Ages move on with each round of counts, also while nothing else changes.
        if (!first) setTick((t) => t + 1)
        first = false
        const value = await api.counts(context, namespace, kinds)
        // A kind this round could not count keeps the last count, greyed (I1).
        if (alive) setCounts((prev) => ({ key, value: mergeCounts(prev?.key === key ? prev.value : null, value) }))
      },
      COUNTS_INTERVAL_MS,
      { paused: () => document.hidden }
    )
    return () => {
      alive = false
      stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, context, customKey, view.namespace, listFailed, gen])

  // --- The picked kind's list (K4: only while seen) ---

  const shownList = useRef<string | null>(null)
  useEffect(() => {
    const spec = latest.current.listSpec
    if (!visible || spec === null || listKey === null) return
    const key = listKey
    let alive = true
    // One copy of the list per burst, not per event (a big namespace's first list is N ADDED events, Task 5 review),
    // and a relist swapped in whole once it goes quiet (final review I3).
    const batcher = createWatchBatcher({
      apply: (burst) => {
        setList((prev) => ({ key, value: applyPending(objectsFor(prev, key), burst) }))
        setFresh(false)
      },
      frame: nextFrame,
      later: (fn, ms) => {
        const timer = setTimeout(fn, ms)
        return () => clearTimeout(timer)
      }
    })
    if (shownList.current !== listKey) {
      shownList.current = listKey
      setList({ key, value: NO_OBJECTS })
    } else {
      // Seen again (the window restored too) or refreshed: the rows stay until the relisted objects replace them.
      batcher.push('resync')
    }
    setFresh(true)
    const stop = follow(
      client,
      spec,
      (m) => {
        batcher.push(m)
        if (m === 'resync') setFresh(true)
      },
      (s) => {
        setListWatch(s)
        if (s !== 'limit') return
        // Refused at the limit: one read so the table is not empty, again on refresh; `live` says it does not follow, and
        // the table waits for this read and shows its failure.
        setListRead({ key, value: 'pending' })
        api.list(spec).then(
          (r) => {
            if (!alive) return
            if (!r.ok) return setListRead({ key, value: { error: r.message } })
            setList({ key, value: new Map(r.objects.map((o) => [keyOf(o), o])) })
            setFresh(false)
            setListRead({ key, value: 'done' })
          },
          (err) => {
            if (alive) setListRead({ key, value: { error: errText(err) } })
          }
        )
      }
    )
    return () => {
      alive = false
      stop()
      batcher.stop()
    }
  }, [visible, listKey, gen, client])

  // --- The selected object ---

  useEffect(() => {
    const { selectedRef: ref, kind: k } = latest.current
    const uid = view.selected
    if (!visible || ref === null || uid === null || k === null) return
    let alive = true
    let watched = false
    // A name can come back as a new object (a StatefulSet's Pod): that one is a new row, and this one is gone.
    const update = (object: K8sObject | null): void =>
      setPick((p) =>
        p === null || p.key !== uid
          ? p
          : { key: uid, value: object !== null && keyOf(object) === uid ? { object, deleted: false } : { ...p.value, deleted: true } }
      )
    // The watch's first event brings the object too; the read is what tells a deleted one (a watch filtered by name then
    // says nothing), and all there is when the watch is refused at the limit.
    const read = (): void => {
      api.get(ref).then(
        (r) => {
          if (alive && !watched && r.ok) update(r.object)
        },
        () => {}
      )
    }
    read()
    const stop = follow(
      client,
      { context: ref.context, namespace: ref.namespace, namespaced: k.namespaced, resource: ref.resource, name: ref.name },
      (m) => {
        if (m === 'resync') {
          watched = false
          read()
          return
        }
        if (keyOf(m.object) !== uid) return
        watched = true
        update(m.type === 'DELETED' ? null : m.object)
      },
      setPickWatch
    )
    return () => {
      alive = false
      stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, selectedKey, view.selected, gen, client])

  // The detail's reads wait for the selection to settle; the object's own read and watch above start at once.
  const settled = useSettled(view.selected, SELECTION_READ_DELAY_MS) === view.selected

  useEffect(() => {
    const first = latest.current.owner
    if (!visible || !settled || first === null || ownerKey === null) return
    let alive = true
    api.get(first).then(
      (r) => {
        if (alive && r.ok && r.object !== null) setOwnerUp({ key: ownerKey, value: r.object })
      },
      () => {} // the chain stops at the first owner, which the object itself names
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, settled, ownerKey, gen])

  // --- The detail's reads, for the tab that shows (the Summary needs the events too) ---

  // Read again when the selected object changes in the cluster, throttled, so they follow it while seen (§11). Each is
  // stored under the selection it was read for.
  const version = selected?.object.metadata.resourceVersion
  const reread = useRereadTick(view.selected, typeof version === 'string' ? version : '')
  const pickedUid = view.selected
  const objectUid = selected?.object.metadata.uid
  const eventsShown = view.detailTab === 'summary' || view.detailTab === 'events'
  useFollowingRead(
    visible && settled && eventsShown && selectedRef !== null && pickedUid !== null && typeof objectUid === 'string'
      ? { key: JSON.stringify([selectedKey, pickedUid, gen]), read: () => api.events(selectedRef, objectUid), apply: (value) => setEvents({ key: pickedUid, value }) }
      : null,
    reread
  )

  const describeShown = view.detailTab === 'describe'
  useFollowingRead(
    visible && settled && describeShown && selectedRef !== null && pickedUid !== null
      ? { key: JSON.stringify([selectedKey, pickedUid, gen]), read: () => api.describe(selectedRef), apply: (value) => setDescribe({ key: pickedUid, value }) }
      : null,
    reread
  )

  const podsShown = view.detailTab === 'pods' && selector !== null
  const podsNamespace = selectedRef?.namespace ?? null
  useFollowingRead(
    visible && settled && podsShown && selector !== null && selectedRef !== null && podsNamespace !== null && pickedUid !== null
      ? {
          key: JSON.stringify([selectedKey, pickedUid, selector, gen]),
          read: () => api.pods(selectedRef.context, podsNamespace, selector),
          apply: (value) => setPods({ key: pickedUid, value })
        }
      : null,
    reread
  )

  // --- What the view draws ---

  const allNamespaces = view.namespace === null
  const kindName = kind?.kind ?? null
  const columns = useMemo(() => (kindName === null ? [] : columnsOf(kindName, { allNamespaces, crd })), [kindName, allNamespaces, crd])
  const allRows = useMemo(
    () => (kindName === null ? [] : rowsOf(kindName, [...objects.values()], { allNamespaces, nowMs: Date.now(), crd })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kindName, objects, allNamespaces, crd, tick]
  )
  const rows = useMemo(() => sortRows(filterRows(allRows, view.filter), view.sort.by, view.sort.dir), [allRows, view.filter, view.sort])
  const podsModel = useMemo((): ClusterViewModel['pods'] => {
    if (podsRead === null || !podsRead.ok) return podsRead
    return {
      ok: true,
      columns: columnsOf('Pod', { allNamespaces: false }),
      rows: rowsOf('Pod', podsRead.objects, { allNamespaces: false, nowMs: Date.now() })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [podsRead, tick])

  const nsRead = valueFor(namespaces, context)
  const live: ClusterLive = !visible || listSpec === null ? 'paused' : liveOf(listWatch, selectedRef !== null ? pickWatch : 'live')
  const nextOwner = ownerObject !== null && context !== null ? ownerRefOf(ownerObject, context) : null
  const table =
    !visible || listSpec === null
      ? 'ready'
      : listState({ watch: listWatch, read: valueFor(listRead, listKey), fresh: listFresh, size: listed.size, saysEmpty })

  // --- Actions ---

  return {
    view,
    contexts,
    contextMissing: missing,
    contextsError,
    namespaces: nsRead?.ok ? nsRead.names : null,
    namespacesForbidden: nsRead?.ok === false && nsRead.forbidden === true,
    groups: KIND_GROUPS,
    customKinds,
    counts: countInfo,
    kind,
    columns,
    rows,
    loading: table === 'loading',
    listFailed: typeof table === 'object' ? table.failed : null,
    selected: selected?.object ?? null,
    selectedRef,
    deleted: selected?.deleted ?? false,
    owners: owner === null ? [] : nextOwner === null ? [owner] : [owner, nextOwner],
    events: valueFor(events, view.selected),
    describe: valueFor(describe, view.selected),
    pods: podsModel,
    live,
    pauseReason: !visible || listSpec === null ? null : pauseReasonOf(listWatch, selectedRef !== null ? pickWatch : 'live'),
    listForbidden: !visible || listSpec === null ? null : listForbidden,
    detailError: visible && selectedRef !== null && typeof pickWatch === 'object' ? pickWatch.error : null,
    setContext(name) {
      const { view: v, contexts: c } = latest.current
      if (name === v.context) return
      pickTicket.current.next()
      const next = withContext(v, name, c ?? NO_CONTEXTS)
      remember(root, next.context, next.namespace)
      setView((s) => withContext(s, name, c ?? NO_CONTEXTS))
    },
    setNamespace(namespace) {
      const { view: v } = latest.current
      if (namespace === v.namespace) return
      pickTicket.current.next()
      remember(root, v.context, namespace)
      setView((s) => withNamespace(s, namespace))
    },
    selectKind(resource) {
      pickTicket.current.next()
      setView((s) => (s.resource === resource ? s : withKind(s, resource)))
    },
    select(uid) {
      pickTicket.current.next()
      const { objects: shown, view: v } = latest.current
      // Only a row of the list now picked: `objects` holds none of the last kind's, namespace's or context's.
      const object = uid === null ? undefined : shown.get(uid)
      if (uid !== null && object === undefined) return
      // Checked again as the update applies: a click that beats the render of a switch names a row of the old list.
      setView((s) => (s.context === v.context && s.namespace === v.namespace && s.resource === v.resource ? { ...s, selected: uid } : s))
      setPick(uid !== null && object !== undefined ? { key: uid, value: { object, deleted: false } } : null)
    },
    selectRef(ref) {
      const ticket = pickTicket.current.next()
      const take = (object: K8sObject): void => {
        if (!pickTicket.current.isCurrent(ticket)) return // the person picked something else meanwhile
        const uid = keyOf(object)
        setView((s) => ({ ...(s.resource === ref.resource ? s : withKind(s, ref.resource)), selected: uid }))
        setPick({ key: uid, value: { object, deleted: false } })
      }
      // Usually already here: the owner was read for the chain, the Pods tab's rows were read with their objects.
      const { objects: listed, ownerObject: up, podsRead: podsNow } = latest.current
      const known = [...listed.values(), ...(up ? [up] : []), ...(podsNow?.ok ? podsNow.objects : [])].find(
        (o) => o.kind === ref.kind && o.metadata.name === ref.name && (o.metadata.namespace ?? null) === ref.namespace
      )
      if (known) return take(known)
      api.get(ref).then(
        (r) => {
          if (r.ok && r.object !== null) take(r.object)
        },
        () => {}
      )
    },
    setFilter(text) {
      setView((s) => ({ ...s, filter: text }))
    },
    sortBy(column) {
      setView((s) => withSort(s, column))
    },
    toggleGroup(id) {
      setView((s) => ({ ...s, expanded: s.expanded.includes(id) ? s.expanded.filter((g) => g !== id) : [...s.expanded, id] }))
    },
    setDetailTab(tab) {
      setView((s) => ({ ...s, detailTab: tab }))
    },
    refresh() {
      setGen((g) => g + 1)
    },
    retry() {
      setGen((g) => g + 1)
    }
  }
}
