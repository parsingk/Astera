import { useEffect, useRef, useState } from 'react'
import type { KubeFileKind } from '../../../core/kube/types'
import { onFileChanges } from '../lib/fileChanges'

/** Only these names can be Kubernetes files; everything else never costs an IPC round trip. */
export function isKubeCandidate(p: string): boolean {
  const base = p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1).toLowerCase()
  return base.endsWith('.yaml') || base.endsWith('.yml') || base === 'kustomization'
}

export function kubeCandidates(paths: readonly string[]): string[] {
  return paths.filter(isKubeCandidate)
}

/** Most paths one classify call carries, so a large tree is not one unbounded batch. */
export const KUBE_CHUNK = 200

export function chunkPaths(paths: readonly string[], size = KUBE_CHUNK): string[][] {
  const out: string[][] = []
  for (let i = 0; i < paths.length; i += size) out.push(paths.slice(i, i + size))
  return out
}

export interface KubeRequest {
  gen: number
  seq: number
  paths: string[]
}

/** What the hook remembers about its requests. `gen` changes with the root; `latest` is the newest
 *  request number per path; `pending` are paths with a request out; `asked` are paths already answered
 *  once in this generation (even with "not a Kubernetes file"), so a row-list change does not ask again. */
export interface KubeTracker {
  gen: number
  seq: number
  latest: Map<string, number>
  pending: Set<string>
  asked: Set<string>
}

export const newTracker = (gen = 0): KubeTracker => ({
  gen,
  seq: 0,
  latest: new Map(),
  pending: new Set(),
  asked: new Set()
})

/** Candidates that were not answered yet and have no request out — what a pure row-list change needs. */
export function planKubeRequests(candidates: readonly string[], t: KubeTracker): string[] {
  return candidates.filter((p) => !t.asked.has(p) && !t.pending.has(p))
}

/** Registers a request for `paths` and returns its identity (a later request for the same path wins). */
export function beginKubeRequest(t: KubeTracker, paths: readonly string[]): KubeRequest {
  const seq = ++t.seq
  for (const p of paths) {
    t.latest.set(p, seq)
    t.pending.add(p)
  }
  return { gen: t.gen, seq, paths: [...paths] }
}

/** A request failed: nothing is applied; its paths stop being pending unless a newer request took over. */
export function failKubeRequest(t: KubeTracker, req: KubeRequest): void {
  if (req.gen !== t.gen) return
  for (const p of req.paths) {
    if (t.latest.get(p) !== req.seq) continue
    t.latest.delete(p)
    t.pending.delete(p)
  }
}

/** Tracker bookkeeping for one answer, done synchronously when it arrives (never inside a state updater,
 *  which React may run twice or later). Returns the paths whose answer is accepted: this was the path's
 *  latest request, the generation is current, and the path is still listed. */
export function acceptKubeResults(req: KubeRequest, t: KubeTracker, listed: ReadonlySet<string>): string[] {
  if (req.gen !== t.gen) return []
  const accepted: string[] = []
  for (const p of req.paths) {
    if (t.latest.get(p) !== req.seq) continue
    t.latest.delete(p)
    t.pending.delete(p)
    if (!listed.has(p)) continue
    t.asked.add(p)
    accepted.push(p)
  }
  return accepted
}

/** Pure merge of accepted answers into the kinds; a path missing from the answer is dropped (deleted, or
 *  not YAML). Safe to run any number of times with the same input. */
export function mergeKubeKinds(
  kinds: Record<string, KubeFileKind>,
  results: Record<string, KubeFileKind>,
  accepted: readonly string[]
): Record<string, KubeFileKind> {
  const next = { ...kinds }
  let changed = false
  for (const p of accepted) {
    const k = results[p]
    if (k === undefined) {
      if (p in next) {
        delete next[p]
        changed = true
      }
    } else if (next[p] !== k) {
      next[p] = k
      changed = true
    }
  }
  return changed ? next : kinds
}

/** Forgets the answered-state of paths that are no longer listed (tracker only). */
export function pruneKubeTracker(t: KubeTracker, keep: ReadonlySet<string>): void {
  for (const p of [...t.asked]) if (!keep.has(p)) t.asked.delete(p)
}

/** Pure: the kinds without the paths that are no longer listed. */
export function dropUnlistedKinds(
  kinds: Record<string, KubeFileKind>,
  keep: ReadonlySet<string>
): Record<string, KubeFileKind> {
  const stale = Object.keys(kinds).filter((p) => !keep.has(p))
  if (stale.length === 0) return kinds
  const next = { ...kinds }
  for (const p of stale) delete next[p]
  return next
}

/**
 * Kubernetes kind of each YAML (or Kustomization) path in `paths`, for the file icon.
 * `paths` must be a stable (memoised) array. Only paths not answered yet are asked for when it changes;
 * a changed file is asked again by the watcher. A failed query keeps the previous kinds.
 */
export function useKubeKinds(root: string | null, paths: string[]): Record<string, KubeFileKind> {
  const [kinds, setKinds] = useState<Record<string, KubeFileKind>>({})
  const tracker = useRef<KubeTracker>(newTracker())
  const listed = useRef<Set<string>>(new Set())

  const classify = (list: string[]): void => {
    for (const chunk of chunkPaths(list)) {
      const req = beginKubeRequest(tracker.current, chunk)
      window.api.kube
        .classify(chunk)
        .then((res) => {
          const accepted = acceptKubeResults(req, tracker.current, listed.current)
          if (accepted.length > 0) setKinds((prev) => mergeKubeKinds(prev, res, accepted))
        })
        .catch(() => failKubeRequest(tracker.current, req)) // keep the previous kinds; the name-based icon is always safe
    }
  }

  useEffect(() => {
    tracker.current = newTracker(tracker.current.gen + 1) // late answers of an earlier visit are dropped
    setKinds({})
  }, [root])

  useEffect(() => {
    const list = root ? kubeCandidates(paths) : []
    listed.current = new Set(list)
    const keep = listed.current
    pruneKubeTracker(tracker.current, keep)
    setKinds((prev) => dropUnlistedKinds(prev, keep))
    classify(planKubeRequests(list, tracker.current))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, paths])

  useEffect(() => {
    if (!root) return
    return onFileChanges((batch) => {
      const changed = batch.changes.map((c) => c.path).filter((p) => listed.current.has(p))
      classify([...new Set(changed)])
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root])

  return kinds
}
