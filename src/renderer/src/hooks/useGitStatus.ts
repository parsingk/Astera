import { useEffect, useMemo, useRef, useState } from 'react'
import { folderCounts, type GitState } from '../../../core/git/status'
import { onFileChanges } from '../lib/fileChanges'

export interface GitStatusMap {
  fileState: Record<string, GitState>
  folderCount: Record<string, number>
  /** The last query could not be answered (git failed or timed out): fileState is the previous answer,
   *  kept to avoid flicker, and may be out of date. The explorer dims the badges and says so. */
  stale: boolean
  refresh: () => void
}

const DEBOUNCE_MS = 250

/** One git.status answer applied to the badges. null is "could not check" — never an empty map, which
 *  is a clean tree: the previous badges stay, marked stale. */
export function nextGitStatus(
  prev: Record<string, GitState>,
  result: Record<string, GitState> | null
): { fileState: Record<string, GitState>; stale: boolean } {
  if (result === null) return { fileState: prev, stale: true }
  // The same badges keep the same map (second pass R2-8): every watcher batch asks again, and a new object drew the
  // explorer again with nothing changed.
  const keys = Object.keys(result)
  const same = keys.length === Object.keys(prev).length && keys.every((k) => prev[k] === result[k])
  return { fileState: same ? prev : result, stale: false }
}

/**
 * git status for the explorer tree.
 *
 * There are four refresh triggers and all of them share one debounce and one re-entry guard:
 *   1. the file watcher (files:changed) — file changes made by the agent or the editor
 *   2. the git watcher (git:changed) — add, commit and branch switches from a session terminal in the app
 *   3. window focus — whatever happened outside the app (an external git client, a terminal, a pull)
 *   4. refresh() — the explorer's refresh button
 *
 * On a failed or timed-out query the map is not cleared, the previous value is kept — this avoids flicker —
 * and `stale` turns on until a query is answered again (nextGitStatus).
 */
export function useGitStatus(root: string | null): GitStatusMap {
  const [fileState, setFileState] = useState<Record<string, GitState>>({})
  const [stale, setStale] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const running = useRef(false)
  const pending = useRef(false)
  const rootRef = useRef(root)
  rootRef.current = root

  const run = async (): Promise<void> => {
    const r = rootRef.current
    if (!r) return
    if (running.current) {
      pending.current = true // while a run is in flight, do not queue up — just set a "once more" flag
      return
    }
    running.current = true
    try {
      const map = await window.api.git.status(r)
      // null means the git query failed or timed out — the previous map is left alone (not cleared, to
      // avoid flicker) and marked stale. The result is also discarded if the root changed during the
      // query — an old root's status must not end up on the new tree.
      if (rootRef.current === r) {
        setFileState((prev) => nextGitStatus(prev, map).fileState)
        setStale(map === null)
      }
    } catch {
      // The call itself failed — the same "could not check" as null: keep the previous map, mark it stale
      if (rootRef.current === r) setStale(true)
    } finally {
      running.current = false
      if (pending.current) {
        pending.current = false
        void run()
      }
    }
  }

  const schedule = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void run(), DEBOUNCE_MS)
  }

  useEffect(() => {
    setStale(false)
    if (!root) {
      setFileState({})
      return
    }
    setFileState({}) // clear the old state immediately when the root changes
    void window.api.git.watch(root)
    void run() // the first query runs without the debounce

    const offFiles = onFileChanges(() => schedule())
    const offGit = window.api.on('git:changed', () => schedule())
    const onFocus = (): void => schedule()
    window.addEventListener('focus', onFocus)

    return () => {
      offFiles()
      offGit()
      window.removeEventListener('focus', onFocus)
      if (timer.current) clearTimeout(timer.current)
      void window.api.git.unwatch()
    }
  }, [root])

  const folderCount = useMemo(
    () => (root ? folderCounts(Object.keys(fileState), root) : {}),
    [fileState, root]
  )

  return { fileState, folderCount, stale, refresh: () => void run() }
}
