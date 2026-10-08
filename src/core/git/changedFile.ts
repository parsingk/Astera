// A changed file as `runs-changed-files` answers it (remote runtime design Phase 10). Node-free: the renderer reads it.
// node: import 없음 — 렌더러가 import한다.

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
}

/** `runs-changed-files`'s answer. `git` is null with `unavailable` when there is no git list. */
export interface ChangedFilesReply {
  runId: string
  taskId?: string
  reported: string[]
  git: { files: ChangedFile[]; base: string; head: string | null } | null
  unavailable?: 'not-recorded' | 'git-failed'
}
