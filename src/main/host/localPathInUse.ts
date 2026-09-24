// Whether this app runs something itself, not through the Host, in or below a path — the app's
// answer to the Host's `orch-act` before it removes a worktree folder (protocol.ts,
// HOST_ACT_PATH_IN_USE's doc comment: host S3, the ruling on plan risk 3). What it covers is a local
// fallback pty this app started on its own node-pty while the Host was not answering — a session, a
// terminal, a run or a chat session. A Host-backed one never counts: the Host already sees it, from
// the very same ptys, in its own isPathInUse (src/host/worktrees.ts).
import { isPathWithin } from '../../core/files/tree'

export interface LocalUseEntry {
  /** Where this session, terminal, run or chat session runs. */
  cwd: string
  /** What to answer the Host with — logged there, never parsed (e.g. `SESSION:<title>`, `TERMINAL:<id>`). */
  tag: string
}

/** The tag of the first entry at or below `path`, compared the same way the Host compares
 *  (`isPathWithin`, so the two agree on what "in or below" means), or null for none.
 *
 *  **No `outlivesApp` filter here** (fix round 1, I4). It used to, but production never reached that
 *  branch — every entry `appPathInUse` hands in is already local, because each manager's own
 *  `runningAppOwned()` is the actual exclusion of a Host-backed pty, and each is tested where it lives
 *  (SessionManager, TerminalManager, RunManager, ChatSessionManager). A second, unreachable copy of
 *  that filter here would only be dead code with a test that could never fail for the right reason. */
export function localPathInUse(entries: readonly LocalUseEntry[], path: string): string | null {
  for (const e of entries) if (isPathWithin(path, e.cwd)) return e.tag
  return null
}

/** The managers `appPathInUse` reads — the shape `core.sessions`/`core.terminal`/`core.run`/`core.chat`
 *  already have (a `Pick` of each, not a copy of their types, so this cannot drift from them). */
export interface AppOwnedManagers {
  sessions: { runningAppOwned(): Array<{ cwd: string; title: string }> }
  terminal: { runningAppOwned(): Array<{ id: string; projectPath: string }> }
  run: { runningAppOwned(): Array<{ cwd: string; configName: string }> }
  chat: { runningAppOwned(): Array<{ cwd: string; title: string }> }
}

/** HOST_ACT_PATH_IN_USE's whole answer (fix round 1, I1): every kind of pty this app can run locally,
 *  not only sessions and terminals — a run is a pty too (RunManager keeps its own `outlivesApp`), and
 *  a chat session is the fourth kind ChatSessionManager already splits the same way. Extracted out of
 *  `ipc.ts` (fix round 1, I4) so the aggregation itself — which manager feeds which tag — is testable
 *  without booting the app; the wiring at the call site is now only "read the four managers, call
 *  this, answer the act". */
export function appPathInUse(m: AppOwnedManagers, path: string): string | null {
  return localPathInUse(
    [
      ...m.sessions.runningAppOwned().map((s) => ({ cwd: s.cwd, tag: `SESSION:${s.title}` })),
      ...m.terminal.runningAppOwned().map((t) => ({ cwd: t.projectPath, tag: `TERMINAL:${t.id}` })),
      ...m.run.runningAppOwned().map((r) => ({ cwd: r.cwd, tag: `RUN:${r.configName}` })),
      ...m.chat.runningAppOwned().map((c) => ({ cwd: c.cwd, tag: `SESSION:${c.title}` }))
    ],
    path
  )
}
