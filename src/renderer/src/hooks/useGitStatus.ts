import { useEffect, useMemo, useRef, useState } from 'react'
import { folderCounts, type GitState } from '../../../core/git/status'

export interface GitStatusMap {
  fileState: Record<string, GitState>
  folderCount: Record<string, number>
  refresh: () => void
}

const DEBOUNCE_MS = 250

/**
 * git status for the explorer tree.
 *
 * There are four refresh triggers and all of them share one debounce and one re-entry guard:
 *   1. the file watcher (files:changed) — file changes made by the agent or the editor
 *   2. the git watcher (git:changed) — add, commit and branch switches from a session terminal in the app
 *   3. window focus — whatever happened outside the app (an external git client, a terminal, a pull)
 *   4. refresh() — the explorer's refresh button
 *
 * On a failed or timed-out query the map is not cleared, the previous value is kept — this avoids flicker.
 */
export function useGitStatus(root: string | null): GitStatusMap {
  const [fileState, setFileState] = useState<Record<string, GitState>>({})
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
      // avoid flicker). The result is also discarded if the root changed during the query — an old root's
      // status must not end up on the new tree.
      if (map !== null && rootRef.current === r) setFileState(map)
    } catch {
      /* Fail quietly — keep the previous map */
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
    if (!root) {
      setFileState({})
      return
    }
    setFileState({}) // clear the old state immediately when the root changes
    void window.api.git.watch(root)
    void run() // the first query runs without the debounce

    const offFiles = window.api.on('files:changed', () => schedule())
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

  return { fileState, folderCount, refresh: () => void run() }
}
