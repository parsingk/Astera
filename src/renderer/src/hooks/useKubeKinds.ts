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

/**
 * Kubernetes kind of each YAML (or Kustomization) path in `paths`, for the file icon.
 * `paths` must be a stable (memoised) array: a new array identity re-runs the query.
 * The answer is kept on a failed query (e.g. a path guard) and dropped when `root` changes.
 */
export function useKubeKinds(root: string | null, paths: string[]): Record<string, KubeFileKind> {
  const [kinds, setKinds] = useState<Record<string, KubeFileKind>>({})
  const rootRef = useRef(root)
  rootRef.current = root
  const trackedRef = useRef<Set<string>>(new Set())

  const classify = (list: string[]): void => {
    if (list.length === 0) return
    const r = root
    window.api.kube
      .classify(list)
      .then((res) => {
        if (rootRef.current !== r) return // the project changed while the answer was out
        setKinds((prev) => {
          const next = { ...prev }
          let changed = false
          for (const p of list) {
            const k = res[p]
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
          return changed ? next : prev
        })
      })
      .catch(() => {
        // Keep the previous kinds: the icon falls back to the name-based one, which is always safe
      })
  }

  useEffect(() => {
    setKinds({})
  }, [root])

  useEffect(() => {
    const list = root ? kubeCandidates(paths) : []
    trackedRef.current = new Set(list)
    classify(list)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, paths])

  useEffect(() => {
    if (!root) return
    return onFileChanges((batch) => {
      const changed = batch.changes
        .map((c) => c.path)
        .filter((p) => trackedRef.current.has(p))
      classify([...new Set(changed)])
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root])

  return kinds
}
