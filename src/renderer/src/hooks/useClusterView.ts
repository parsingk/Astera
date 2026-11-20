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
  initialView,
  memoryKey,
  noPending,
  queueWatch,
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
  /** The cluster's namespace names for the pill, which adds "All namespaces" first itself; null until read or when the read failed. */
  namespaces: string[] | null
  /** Listing namespaces is Forbidden: the pill becomes a free-text field. */
  namespacesForbidden: boolean
  /** The tree's fixed groups and kinds (the custom group comes with no kinds of its own). */
  groups: KindGroup[]
  /** The cluster's custom resource kinds, listed under the custom group. */
  customKinds: KindDef[]
  /** Count, problem dot and Forbidden reason per resource, for the picked context and namespace; empty until read. */
  counts: Record<string, CountInfo>
  /** The picked kind; null while a custom kind's CRD is not known (yet). */
  kind: KindDef | null
  /** The table's columns for the picked kind (Namespace first under All namespaces). */
  columns: Column[]
  /** The table's rows: the live list (read once when the watch is refused at the limit), filtered by name and sorted. */
  rows: Row[]
  /** The list has not arrived yet, so empty `rows` do not mean an empty kind. */
  loading: boolean
  /** The selected object's latest content (a Secret masked); kept when it is deleted. */
  selected: K8sObject | null
  /** Where the selected object lives, for reads, reveal, the menu and the editor tab. */
  selectedRef: ObjectRef | null
  /** The selected object was deleted in the cluster: `selected` is its last content, to show greyed. */
  deleted: boolean
  /** The selected object's owner chain, nearest first, up to two levels (a Pod's ReplicaSet, then its Deployment). */
  owners: ObjectRef[]
  /** The selected object's events, newest first, read while the Summary or Events tab shows; null until read. */
  events: Read<{ events: K8sObject[] }> | null
  /** `kubectl describe` text, read while the describe tab shows; null until read. */
  describe: Read<{ text: string }> | null
  /** The Pods the selected object selects, read while the Pods tab shows; null until read, or when it selects none. */
  pods: Read<{ columns: Column[]; rows: Row[] }> | null
  /** Whether the table and the detail follow the cluster. */
  live: ClusterLive
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

/** What one watch is doing; `ended`: it stopped without an error. */
type WatchState = 'live' | 'limit' | 'ended' | { error: string }
/** A value kept with what it was read for (a context, a namespace, a selection), so it never shows for another. */
type Keyed<T> = { key: string; value: T }

const valueFor = <T>(k: Keyed<T> | null, key: string | null): T | null => (k !== null && k.key === key ? k.value : null)

const NO_CONTEXTS: KubeContexts = { contexts: [], current: null }
const NO_OBJECTS: ReadonlyMap<string, K8sObject> = new Map()
const NO_CRDS = { kinds: [] as KindDef[], objects: [] as K8sObject[] }
const NO_COUNTS: Record<string, CountInfo> = {}
const FIXED_KINDS = KIND_GROUPS.flatMap((g) => g.kinds)

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
 *  once, and its messages, like any after the cleanup, go nowhere. */
function follow(client: WatchClient, spec: WatchSpec, onEvent: (m: WatchEvent | 'resync') => void, onState: (s: WatchState) => void): () => void {
  let alive = true
  let stop: (() => void) | null = null
  onState('live')
  client
    .subscribe(spec, (m) => {
      if (!alive) return
      if (m.kind === 'error') onState({ error: m.message })
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

/** A one-shot read for the life of an effect, stored under `key` unless the effect was cleaned up first. */
function readInto<T>(read: Promise<Read<T>>, key: string, set: (v: Keyed<Read<T>>) => void): () => void {
  let alive = true
  read.then(
    (value) => {
      if (alive) set({ key, value })
    },
    (err) => {
      if (alive) set({ key, value: { ok: false, message: errText(err) } })
    }
  )
  return () => {
    alive = false
  }
}

function liveOf(list: WatchState, pick: WatchState): ClusterLive {
  if (typeof list === 'object') return list
  if (typeof pick === 'object') return pick
  if (list === 'limit' || pick === 'limit') return 'limit'
  return list === 'ended' || pick === 'ended' ? 'paused' : 'live'
}

function useWatchClient(): WatchClient {
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
  const [list, setList] = useState<ReadonlyMap<string, K8sObject>>(NO_OBJECTS)
  /** Nothing has arrived since the list (re)started. */
  const [fresh, setFresh] = useState(true)
  const [listWatch, setListWatch] = useState<WatchState>('live')
  const [pick, setPick] = useState<Keyed<{ object: K8sObject; deleted: boolean }> | null>(null)
  const [pickWatch, setPickWatch] = useState<WatchState>('live')
  const [ownerUp, setOwnerUp] = useState<Keyed<K8sObject> | null>(null)
  const [events, setEvents] = useState<Keyed<Read<{ events: K8sObject[] }>> | null>(null)
  const [describe, setDescribe] = useState<Keyed<Read<{ text: string }>> | null>(null)
  const [pods, setPods] = useState<Keyed<Read<{ objects: K8sObject[] }>> | null>(null)

  const missing = contexts !== null && contextMissing(view, contexts)
  /** The context reads and watches go to; null while contexts are unknown, none is picked, or the picked one is missing. */
  const context = contexts !== null && !missing ? view.context : null
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
  // A relist of an empty kind brings no event at all, so the counts are what says the old rows are gone. Not while the
  // watch fails: a failed count reads 0 (Task 7), and the rows then stay as last seen (§4.12).
  const saysEmpty = listWatch === 'live' && kindCount?.count === 0 && !kindCount.forbidden
  const objects = fresh && saysEmpty ? NO_OBJECTS : list
  const selected = valueFor(pick, view.selected)
  const selectedRef = selected !== null && context !== null && kind !== null ? refOf(context, kind, selected.object) : null
  const selectedKey = selectedRef && JSON.stringify(selectedRef)
  const owner = selected !== null && context !== null ? ownerRefOf(selected.object, context) : null
  const ownerKey = owner && JSON.stringify(owner)
  const ownerObject = valueFor(ownerUp, ownerKey)
  const selector = selected !== null && kind !== null ? podSelectorOf(kind.kind, selected.object) : null
  const podsRead = selector === null ? null : valueFor(pods, view.selected)

  const now = { visible, contexts, view, context, customKinds, kind, listSpec, objects, selected, selectedRef, owner, ownerObject, podsRead }
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

  const countTicket = useRef(createLatest())
  const countNow = (): void => {
    const { context: ctx, view: v, customKinds: custom } = latest.current
    if (ctx === null) return
    const key = JSON.stringify([ctx, v.namespace])
    const ticket = countTicket.current.next()
    api.counts(ctx, v.namespace, [...FIXED_KINDS, ...custom]).then(
      (value) => {
        if (countTicket.current.isCurrent(ticket)) setCounts({ key, value })
      },
      () => {} // the last counts stay; the table's watch reports what is wrong with the cluster
    )
  }

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

  // Counted once the custom kinds are known (so they are counted too), again for another namespace, and on a slow
  // interval while seen (§4.3).
  useEffect(() => {
    if (!latest.current.visible || crds === null || crds.key !== latest.current.context) return
    countNow()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crds, view.namespace])

  useEffect(() => {
    if (!visible || context === null) return
    const timer = setInterval(() => {
      setTick((t) => t + 1)
      countNow()
    }, COUNTS_INTERVAL_MS)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, context])

  // --- The picked kind's list (K4: only while seen) ---

  const shownList = useRef<string | null>(null)
  useEffect(() => {
    const spec = latest.current.listSpec
    if (!visible || spec === null || listKey === null) return
    let pending = noPending()
    if (shownList.current !== listKey) {
      shownList.current = listKey
      setList(NO_OBJECTS)
    } else {
      // Seen again or refreshed: the rows stay until the relisted objects replace them, so the table does not flash empty.
      queueWatch(pending, 'resync')
    }
    setFresh(true)
    let alive = true
    let cancelFrame: (() => void) | null = null
    // One copy of the list per frame, not per event: a big namespace's first list is N ADDED events (Task 5 review).
    const flush = (): void => {
      cancelFrame = null
      const burst = pending
      pending = noPending()
      setList((prev) => applyPending(prev, burst))
      setFresh(false)
    }
    const stop = follow(
      client,
      spec,
      (m) => {
        queueWatch(pending, m)
        if (m === 'resync') {
          // It drops what was queued, so the reset waits for the relist's events: a frame already scheduled would show
          // an empty table until kubectl relists.
          cancelFrame?.()
          cancelFrame = null
          setFresh(true)
        } else cancelFrame ??= nextFrame(flush)
      },
      (s) => {
        setListWatch(s)
        if (s !== 'limit') return
        // Refused at the limit: one read so the table is not empty, again on refresh; `live` says it does not follow.
        api.list(spec).then(
          (r) => {
            if (!alive || !r.ok) return
            setList(new Map(r.objects.map((o) => [keyOf(o), o])))
            setFresh(false)
          },
          () => {}
        )
      }
    )
    return () => {
      alive = false
      stop()
      cancelFrame?.()
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

  useEffect(() => {
    const first = latest.current.owner
    if (!visible || first === null || ownerKey === null) return
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
  }, [visible, ownerKey, gen])

  // --- The detail's reads, for the tab that shows (the Summary needs the events too) ---

  const eventsShown = view.detailTab === 'summary' || view.detailTab === 'events'
  useEffect(() => {
    const ref = latest.current.selectedRef
    const uid = latest.current.selected?.object.metadata.uid
    if (!visible || !eventsShown || ref === null || view.selected === null || typeof uid !== 'string') return
    return readInto(api.events(ref, uid), view.selected, setEvents)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, selectedKey, view.selected, eventsShown, gen])

  const describeShown = view.detailTab === 'describe'
  useEffect(() => {
    const ref = latest.current.selectedRef
    if (!visible || !describeShown || ref === null || view.selected === null) return
    return readInto(api.describe(ref), view.selected, setDescribe)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, selectedKey, view.selected, describeShown, gen])

  const podsShown = view.detailTab === 'pods' && selector !== null
  useEffect(() => {
    const ref = latest.current.selectedRef
    if (!visible || !podsShown || selector === null || ref === null || ref.namespace === null || view.selected === null) return
    return readInto(api.pods(ref.context, ref.namespace, selector), view.selected, setPods)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, selectedKey, view.selected, podsShown, selector, gen])

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

  // --- Actions ---

  return {
    view,
    contexts,
    contextMissing: missing,
    namespaces: nsRead?.ok ? nsRead.names : null,
    namespacesForbidden: nsRead?.ok === false && nsRead.forbidden === true,
    groups: KIND_GROUPS,
    customKinds,
    counts: countInfo,
    kind,
    columns,
    rows,
    loading: live === 'live' && fresh && list.size === 0 && !saysEmpty,
    selected: selected?.object ?? null,
    selectedRef,
    deleted: selected?.deleted ?? false,
    owners: owner === null ? [] : nextOwner === null ? [owner] : [owner, nextOwner],
    events: valueFor(events, view.selected),
    describe: valueFor(describe, view.selected),
    pods: podsModel,
    live,
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
      const object = uid === null ? undefined : latest.current.objects.get(uid)
      if (uid !== null && object === undefined) return
      setView((s) => ({ ...s, selected: uid }))
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
