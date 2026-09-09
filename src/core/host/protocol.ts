// What the app and the Host say to each other (Astera Host slice 1 design §6). Shared so both sides
// compile against one definition rather than two that drift.
//
// Newline-delimited JSON, one object per line. Terminal data is not here yet — slice 2 adds it, and
// JSON string escaping is what will carry it, the same way the app already ships PTY output to the
// renderer.

/** Bumped whenever a message changes shape. A Host and an app that disagree do not talk (design §6).
 *  2 added the pty-* messages: the Host owns the terminals now. */
export const HOST_PROTOCOL = 2

/** What the app needs to rebuild its own record for a session after a restart. The Host stores it
 *  and hands it back untouched — only the manager that wrote it knows how to read it (slice 2
 *  design §4). */
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
  | { t: 'pty-spawn'; id: string; file: string; args: string[]; opts: PtyOpenOptions; meta?: PtyMeta }
  | { t: 'pty-write'; id: string; data: string }
  | { t: 'pty-resize'; id: string; cols: number; rows: number }
  | { t: 'pty-kill'; id: string }
  | { t: 'pty-pause'; id: string }
  | { t: 'pty-resume'; id: string }
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
