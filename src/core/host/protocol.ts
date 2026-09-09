// What the app and the Host say to each other (Astera Host slice 1 design §6). Shared so both sides
// compile against one definition rather than two that drift.
//
// Newline-delimited JSON, one object per line. Terminal data is not here yet — slice 2 adds it, and
// JSON string escaping is what will carry it, the same way the app already ships PTY output to the
// renderer.

/** Bumped whenever a message changes shape. A Host and an app that disagree do not talk (design §6).
 *  2 added the pty-* messages: the Host owns the terminals now. 3 added pty-note — an older Host
 *  answers a message it does not know by logging it and carrying on, so an app that kept talking to
 *  one would have every note update silently dropped and would adopt its sessions from stale notes,
 *  which is exactly the wrong behaviour the version guard exists to make impossible. */
export const HOST_PROTOCOL = 3

/** What the app needs to rebuild its own record for a session after a restart. The Host stores it
 *  and hands it back untouched — only the manager that wrote it knows how to read it (slice 2
 *  design §4).
 *
 *  Written at spawn and **patched afterwards** through `pty-note`, key by key: some of what the app
 *  would want back is not known yet at spawn (a codex session's rollout file) or changes later (a
 *  session's title). The Host merges the keys it is given into `restore` without reading any of
 *  them. */
export interface PtyMeta {
  kind: 'session' | 'run' | 'terminal'
  /** The app's own id for this thing, not the Host's id for the pty. */
  id: string
  restore: Record<string, unknown>
}

/** The same four fields PtySpawnOptions has always had; repeated here so the protocol does not
 *  depend on the sessions module. */
export interface PtyOpenOptions {
  cwd: string
  cols: number
  rows: number
  env: Record<string, string | undefined>
}

export interface PtyEntry {
  id: string
  pid: number
  meta: PtyMeta | null
  alive: boolean
}

export type ClientMessage =
  | { t: 'hello'; protocol: number; app: string }
  /** Leave. Sent when the app finds a Host on another protocol; in slice 1 the Host holds nothing,
   *  so leaving costs nothing. This message's meaning is revisited in slice 2. */
  | { t: 'retire' }
  /** node-pty's two argument forms are not interchangeable on win32: a string is a verbatim command
   *  line that skips argv quoting, while an array goes through it. The protocol carries whichever
   *  one the caller had rather than converting between them (see PtyFactory in core/sessions/pty.ts,
   *  and shellSpawn in core/run/shell.ts for the win32 case that produces a string). */
  | { t: 'pty-spawn'; id: string; file: string; args: string[] | string; opts: PtyOpenOptions; meta?: PtyMeta }
  | { t: 'pty-write'; id: string; data: string }
  | { t: 'pty-resize'; id: string; cols: number; rows: number }
  | { t: 'pty-kill'; id: string }
  | { t: 'pty-pause'; id: string }
  | { t: 'pty-resume'; id: string }
  /** Merge these keys into the note this pty was spawned with. A patch and not a whole note: the two
   *  senders each know one field — the session's title, a codex session's rollout file — and either
   *  one sending a whole `restore` would erase what the other wrote. */
  | { t: 'pty-note'; id: string; patch: Record<string, unknown> }
  | { t: 'pty-list' }
  | { t: 'pty-attach'; id: string }

export type HostMessage =
  | { t: 'hello'; protocol: number; host: string; pid: number; startedAt: string }
  | { t: 'protocol-mismatch'; protocol: number }
  | { t: 'pty-spawned'; id: string; pid: number }
  | { t: 'pty-failed'; id: string; error: string }
  | { t: 'pty-data'; id: string; data: string }
  | { t: 'pty-exit'; id: string; exitCode: number }
  | { t: 'pty-listed'; entries: PtyEntry[] }
