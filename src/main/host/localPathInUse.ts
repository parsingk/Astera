// Whether this app runs something itself, not through the Host, in or below a path — the app's
// answer to the Host's `orch-act` before it removes a worktree folder (protocol.ts,
// HOST_ACT_PATH_IN_USE's doc comment: host S3, the ruling on plan risk 3). What it covers is a local
// fallback pty this app started on its own node-pty while the Host was not answering — a session or a
// terminal. A Host-backed one never counts: the Host already sees it, from the very same ptys, in its
// own isPathInUse (src/host/worktrees.ts) — counting it here too would only ever refuse a removal the
// Host was already refusing on its own.
import { isPathWithin } from '../../core/files/tree'

export interface LocalUseEntry {
  /** Where this session or terminal runs. */
  cwd: string
  /** What to answer the Host with — logged there, never parsed (e.g. `SESSION:<title>`, `TERMINAL:<id>`). */
  tag: string
  /** True for a pty the Host runs and this app merely shows (`PtyLike.outlivesApp`) — never counted. */
  outlivesApp: boolean
}

/** The tag of the first local entry at or below `path`, compared the same way the Host compares
 *  (`isPathWithin`, so the two agree on what "in or below" means), or null for none. */
export function localPathInUse(entries: readonly LocalUseEntry[], path: string): string | null {
  for (const e of entries) {
    if (e.outlivesApp) continue
    if (isPathWithin(path, e.cwd)) return e.tag
  }
  return null
}
