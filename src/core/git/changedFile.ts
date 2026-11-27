// A changed file as `runs-changed-files` answers it (remote runtime design Phase 10). Node-free: the renderer reads it.
// node: import 없음 — 렌더러가 import한다.
import type { FileAttribution } from '../review/attribution'

export interface ChangedFile {
  /** Stable for the same change in the same range: what `runs-diff` takes. */
  id: string
  /** The repo's own path, relative with forward slashes: the owning machine's, shown as text. */
  path: string
  /** A rename's source. */
  oldPath?: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  additions?: number
  deletions?: number
  /** git counts no lines in it, and its diff says only that it differs. */
  binary?: true
  /** In a Run's list: the Task whose own worktree it changed (a parallel Run's Tasks are merged straight into the
   *  project). Absent for the Run's root and in a Task's own list. */
  taskId?: string
}

/** At most this many files in one list; `total` in the reply says how many there were. A Run that committed a build
 *  folder would otherwise send tens of thousands of rows across the link and into one screen. */
export const CHANGES_MAX_FILES = 2_000

/** `runs-changed-files`'s answer. `git` is null with `unavailable` when there is no git list. */
export interface ChangedFilesReply {
  runId: string
  taskId?: string
  reported: string[]
  /** `live`: some part was read from a folder's working tree, uncommitted edits included. `total`: how many files
   *  changed, more than `files` holds when the list was cut. */
  git: { files: ChangedFile[]; live: boolean; total: number } | null
  unavailable?: 'not-recorded' | 'git-failed'
  /** The attempt read, echoed when one was named (Phase 3 Part 4): a Host that did not know the argument leaves it out. */
  dispatchId?: string
  /** The range each part was read over; head null is the working tree. */
  ranges?: Array<{ taskId?: string; base: string; head: string | null }>
  /** Who changed each file, by its id, when asked for (core/review/attribution.ts). */
  attribution?: Record<string, FileAttribution>
}
