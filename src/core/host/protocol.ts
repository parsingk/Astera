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
 *  which is exactly the wrong behaviour the version guard exists to make impossible.
 *
 *  **Still 3 with the proc-* family.** Those messages are additive and the app sends them only to a
 *  Host that announced the feature in its `hello` (`features: ['proc']`, HOST_FEATURE_PROC below;
 *  `hostSpeaksProcs` in main/host/outdated.ts is the check). A capability, not an age: an outdated
 *  Host is exactly the one the automatic replacement must still reach, and it cannot answer a
 *  proc-list. A bump would put the new app on a new pipe name and leave the old Host's terminals
 *  invisible to it, which is the one thing the guard must never cause (chat-sessions design §6.5). */
export const HOST_PROTOCOL = 3

/** The proc-* family (line processes). Announced in `hello.features` by a Host that has it; a Host
 *  from before it sends no `features` at all. */
export const HOST_FEATURE_PROC = 'proc'

/** The heartbeat — `ping` answered with `pong`
 *  (docs/2026-09-22-host-unresponsive-recovery-design.md F2). Announced the same way and for the same
 *  reason as the feature above: a Host from before it treats a ping as an unknown message, logs it
 *  and says nothing, and an app that pinged one anyway would read that silence as a Host that has
 *  stopped answering — and end a Host that is running perfectly well. */
export const HOST_FEATURE_PING = 'ping'

/** What the app needs to rebuild its own record for a session after a restart. The Host stores it
 *  and hands it back untouched — only the manager that wrote it knows how to read it (slice 2
 *  design §4).
 *
 *  Written at spawn and **patched afterwards** through `pty-note`, key by key: some of what the app
 *  would want back is not known yet at spawn (a codex session's rollout file) or changes later (a
 *  session's title). The Host merges the keys it is given into `restore` without reading any of
 *  them. */
export interface PtyMeta {
  kind: 'session' | 'run' | 'terminal' | 'chat'
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

/** What a line process is spawned with. No size: it has no terminal. */
export interface ProcOpenOptions {
  cwd: string
  env: Record<string, string | undefined>
}

export interface PtyEntry {
  id: string
  pid: number
  meta: PtyMeta | null
  alive: boolean
  /** Line processes only: the replay buffer has dropped lines since the process started, so a replay
   *  is not the whole story. Absent for ptys (a scrollback is always a tail) and when nothing was dropped. */
  truncated?: boolean
}

export type ClientMessage =
  | { t: 'hello'; protocol: number; app: string }
  /** Leave. Sent when the app finds a Host on another protocol; in slice 1 the Host holds nothing,
   *  so leaving costs nothing. This message's meaning is revisited in slice 2. */
  | { t: 'retire' }
  /** The heartbeat. Sent only to a Host whose `hello` named HOST_FEATURE_PING, and answered with a
   *  `pong` carrying the same `seq`. What it asks is not "are you there" — the socket answers that —
   *  but "is your event loop still turning", which is the one thing a stuck pty spawn takes away. */
  | { t: 'ping'; seq: number }
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
  /** A stdio child that speaks lines — a chat session's `codex app-server` or `claude` (chat-sessions
   *  design §6.5). `args` is always an array: nothing here goes through a shell. */
  | { t: 'proc-spawn'; id: string; file: string; args: string[]; opts: ProcOpenOptions; meta?: PtyMeta }
  /** One line to the process's stdin; the Host appends the newline. */
  | { t: 'proc-write'; id: string; line: string }
  | { t: 'proc-kill'; id: string }
  /** Same contract as pty-note, for a line process. */
  | { t: 'proc-note'; id: string; patch: Record<string, unknown> }
  | { t: 'proc-list' }
  /** Replays the buffered lines to the client that asked, as one proc-attached. */
  | { t: 'proc-attach'; id: string }

export type HostMessage =
  | {
      t: 'hello'
      protocol: number
      host: string
      pid: number
      startedAt: string
      /** What this Host can do beyond protocol 3's original set. Optional because older Hosts do not
       *  send it — absent means none. Additive on purpose: the protocol stays 3 (see HOST_PROTOCOL's
       *  comment). */
      features?: string[]
    }
  | { t: 'protocol-mismatch'; protocol: number }
  | { t: 'pong'; seq: number }
  | { t: 'pty-spawned'; id: string; pid: number }
  | { t: 'pty-failed'; id: string; error: string }
  | { t: 'pty-data'; id: string; data: string }
  | { t: 'pty-exit'; id: string; exitCode: number }
  | { t: 'pty-listed'; entries: PtyEntry[] }
  | { t: 'proc-spawned'; id: string; pid: number }
  | { t: 'proc-failed'; id: string; error: string }
  /** One stdout line, live. `seq` counts from 1 per process and is never reused; a client that has
   *  seen a seq drops the line — the replay below repeats seqs on purpose. */
  | { t: 'proc-line'; id: string; seq: number; line: string }
  /** The answer to proc-attach: every buffered line, oldest first, with the seq each was sent with.
   *  One message, so the receiver knows where the replay ends; empty for an unknown or ended id. */
  | { t: 'proc-attached'; id: string; lines: Array<{ seq: number; line: string }> }
  /** `stderrTail` is absent from an older Host — the app treats that as "nobody collected it", not as
   *  "the process said nothing". Added to this message rather than as a new one so the protocol version
   *  does not have to move: bumping it retires a Host that is running perfectly well (design S4). */
  | { t: 'proc-exit'; id: string; exitCode: number; stderrTail?: string }
  | { t: 'proc-listed'; entries: PtyEntry[] }
