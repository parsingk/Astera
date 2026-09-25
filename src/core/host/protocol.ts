// What the app and the Host say to each other (Astera Host slice 1 design §6). Shared so both sides
// compile against one definition rather than two that drift.
//
// Newline-delimited JSON, one object per line. Terminal data is not here yet — slice 2 adds it, and
// JSON string escaping is what will carry it, the same way the app already ships PTY output to the
// renderer.
import type { OrchState } from '../orchestration/state'
import type { RollStateEvent, SessionInfo, WorktreeInfo } from '../types'

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

/** The `orch-call`/`orch-result` pair (host control plane design §5) — one RPC channel for every
 *  orchestration command instead of a message type per command. Announced the same way and for the
 *  same reason as the features above: the protocol number stays 3 (see HOST_PROTOCOL's comment
 *  above), and a Host from before this feature answers an `orch-call` the way it answers any message
 *  it does not know — logged and ignored — rather than being retired for it. */
export const HOST_FEATURE_ORCH = 'orch'

/** Request receipts — `orch-call.request`, the `requests-show` command, and the replay that makes a
 *  retry safe (request receipts design §8). Announced the same way and for the same reason as the
 *  features above: the protocol number stays 3, because bumping it retires a Host that is running
 *  perfectly well and kills its terminals with it.
 *
 *  **Why a feature flag is not optional for this one.** A Host from before it destructures
 *  `{cmd, args, session}` and runs the command *unprotected* while the caller believes otherwise —
 *  the silent drop this whole design is built against. So the CLI splits: a **presented**
 *  `--request-id` against a Host that does not announce this is refused with exit 9 (the caller asked
 *  for protection and is not getting it), while an **auto-minted** id is dropped and the command runs
 *  exactly as it did before receipts existed. We refuse to break a promise we made, and we never
 *  refuse over one we did not. */
export const HOST_FEATURE_REQUESTS = 'requests'

/** The Host spawns orchestration sessions itself: `worker-start`, `worker-stop`, `worker-release`,
 *  `worker-read` and a coordinator's start are carried out in its own pty registry when no app can
 *  (host S2 design §2). Announced only by a Host that was started with all three CLI paths
 *  (`hostCliPaths`), because without them it cannot build a worker's shuttle and does not guess one.
 *
 *  **What an app does with it.** It stops sweeping stale spec files at its own boot, because the Host
 *  sweeps them on its load and a sweep in the app would delete the spec of a worker the Host has
 *  just started; and it answers `pty-opened` by adopting that session. An app that sees no `spawn`
 *  keeps doing both as it always has. Additive, so HOST_PROTOCOL stays 3. */
export const HOST_FEATURE_SPAWN = 'spawn'

/** The Host owns worktrees.json and runs the worktree git itself (host S3 design §3): the app writes
 *  its registry through `worktree-*` orch-calls and mirrors `worktrees-state`. Only a Host that also
 *  announces `spawn` (ruling R5). Additive, so HOST_PROTOCOL stays 3. */
export const HOST_FEATURE_WORKTREES = 'worktrees'

/** The Host drives Jobs (S4+S5, design §4): it places workers, runs checks, reviews and repairs. Only a
 *  Host that also announces `spawn` (ruling R7). Additive, so HOST_PROTOCOL stays 3. */
export const HOST_FEATURE_DISPATCH = 'dispatch'

/** The Host rolls the sessions it owns at their usage limit (S6): the ones it spawned, and the ones
 *  it took over from an app that is gone. Only a Host that also announces `spawn` (R17). Additive, so
 *  HOST_PROTOCOL stays 3. */
export const HOST_FEATURE_ROLLING = 'rolling'

/** The Host and the app exchange their usage-limit block records (S6 D3, D4): the Host pushes `blocks`
 *  on every change of its registry and once, whole, after an app's hello; the app sends `blocks` for
 *  its own changes and, whole, after each handshake. Each side absorbs what it receives and never sends
 *  it back. Announced with `rolling` (the registry is the rolling's). An app sends nothing to a Host
 *  without it. Additive, so HOST_PROTOCOL stays 3. */
export const HOST_FEATURE_BLOCKS = 'blocks'

/** A `blocks` message's body, both directions: records to merge and clears to apply, by account. The
 *  record is core/rolling/retry.ts's BlockRecord, written out here because the renderer's project
 *  compiles this file and not core/rolling; the two are the same shape, so BlockRegistry's
 *  BlocksPayload is assignable to this. The receiver still validates every field (blockWire.ts). */
export interface BlocksBody {
  records: Record<string, { at: number | null; weekly: boolean; since: number }>
  cleared: Array<{ accountId: string; at: number }>
}

/** The Host keeps a journal of the roll events that happen while no app is attached (S6 limits D5), in
 *  `<profile>/host/roll-journal.json`, and answers the app-only orch-call `roll-journal { ack? }` with
 *  the entries after `ack`, pruning the acknowledged ones. Announced with `rolling`. An app sends
 *  nothing to a Host without it. Additive, so HOST_PROTOCOL stays 3. */
export const HOST_FEATURE_ROLL_JOURNAL = 'roll-journal'

/** One entry of the roll journal (D5). `seq` rises across the Host's restarts; `at` is ISO. A `rolled`
 *  entry names the new session in `sessionId` and the one it rolled from in `oldSessionId`, which is how
 *  a reader folds a chain onto its live id. A `state` entry carries the roll state and its fields. */
export interface RollJournalEntry {
  seq: number
  at: string
  kind: 'rolled' | 'state'
  sessionId: string
  oldSessionId?: string
  state?: 'waiting' | 'switching' | 'nudged' | 'stalled'
  accountLabel?: string
  nextRetryAt?: string
  scope?: 'session' | 'weekly'
}

/** worktrees.json as the Host holds it, stamped with where it stands in this Host's changes. The
 *  `worktrees-state` push carries it, and so does the body of **every** `worktree-*` orch-call reply
 *  (`worktree-add`, `worktree-remove`, `worktree-root`, `worktree-list`), so a receiver can order a
 *  push against a reply as well as against another push (review of Tasks 4-5, I1).
 *
 *  **The contract.**
 *  - The Host keeps **one counter per Host life**, bumped on every change to its registry, and puts
 *    its current value on each push and each reply. It restarts with the Host, so a value means
 *    nothing across Hosts.
 *  - The receiver keeps the last `seq` it applied, **per connection**. It resets it whenever it
 *    refills from `worktree-list`, which it does on every new handshake, and takes that fill's `seq`.
 *    A replaced or restarted Host is therefore never judged by the old Host's numbers.
 *  - A push or a reply whose `seq` is lower than the last one applied is ignored: it is an older file
 *    than the one the receiver already holds. */
export interface WorktreesSnapshot {
  seq: number
  file: { root?: string; items: WorktreeInfo[] }
}

/** What an app hands the Host in `hello.yields`: "you do this, not me" (§7.2). S3: worktrees. S4 adds dispatch. */
export const HOST_YIELD_WORKTREES = 'worktrees'
/** `hello.yields` value: this app does not dispatch while its Host announces `dispatch`. */
export const HOST_YIELD_DISPATCH = 'dispatch'
/** `hello.yields` value: this app does not roll a session whose note says `rolledBy: 'host'` while its
 *  Host announces `rolling`, and it leaves the Host's chains alone for every pty it holds. */
export const HOST_YIELD_ROLLING = 'rolling'

/** The `orch-act` a Host sends an attached app before it removes a worktree folder (S3, the ruling
 *  on plan risk 3). Args `[path]`. The app answers the tag of anything **it runs itself, not
 *  through this Host,** in or below `path` (a fallback session it started while the Host was not
 *  answering), or null. The Host cannot see those, and this in-use check (with the Host's own, R8) is
 *  what keeps a removal from touching a folder a live process is using, on every OS this runs on. Not
 *  an `OrchServerDeps` name: the app answers it beside `answerOrchAct`. An app that does not answer, or
 *  answers anything but a string or null, costs the removal: the Host keeps the folder. */
export const HOST_ACT_PATH_IN_USE = 'worktreePathInUse'

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
  /** `app` is a version string on both sides — `main/host/client.ts` sends the app's version and
   *  `core/host/connect.ts` sends the CLI's, and the two can be the identical string — so it cannot
   *  say *what* is connecting. `role` does.
   *
   *  **Absent means `'cli'`, and that default is the careful one.** The Host sends `orch-act` only to
   *  a client that called itself the app; an older app that sends no role is therefore refused with
   *  APP_REQUIRED rather than handed an `orch-act` it has never heard of and cannot answer, which
   *  would leave the caller waiting for a reply that is never coming. Additive, so HOST_PROTOCOL
   *  stays 3 — bumping it retires a running Host and takes its terminals with it.
   *
   *  **`yields` names the duties this app hands to the Host** (host S3 ruling R4, §7.2): with
   *  HOST_YIELD_WORKTREES in it, the Host forks, merges and removes Job worktrees itself while this
   *  app is attached. Absent means none, which is what an S2 app sends: the Host then keeps sending
   *  that work to it, because such an app writes worktrees.json whole and would erase an entry the
   *  Host made behind it. An older Host ignores the field, so a new app in front of one keeps S2's
   *  behaviour. Additive, so HOST_PROTOCOL stays 3. */
  | { t: 'hello'; protocol: number; app: string; role?: 'app' | 'cli'; yields?: string[] }
  /** Leave. Sent when the app finds a Host on another protocol; in slice 1 the Host holds nothing,
   *  so leaving costs nothing. This message's meaning is revisited in slice 2.
   *
   *  **`reason` decides whether the Host may refuse (host control plane design §12).** `'user'` is
   *  `astera host stop` asking on a person's behalf, and is refused while a session or a Job is live.
   *  The default, `'protocol'`, is what the app already sends on finding a Host it cannot talk to
   *  (`main/host/client.ts`'s protocol-mismatch handling, and `retireOlderHosts`) — that Host's
   *  sessions are already unreachable to the app that is asking, so refusing would strand it there
   *  forever instead of letting a Host it can talk to take the address. */
  | { t: 'retire'; reason?: 'user' | 'protocol' }
  /** The heartbeat. Sent only to a Host whose `hello` named HOST_FEATURE_PING, and answered with a
   *  `pong` carrying the same `seq`. What it asks is not "are you there" — the socket answers that —
   *  but "is your event loop still turning", which is the one thing a stuck pty spawn takes away. */
  | { t: 'ping'; seq: number }
  /** One RPC call, routed by `cmd` (host control plane design §5). `call` is the caller's own
   *  correlation id — one socket can have several `orch-call`s outstanding at once, so the reply
   *  names which one it answers. `args`/`session` are today's HTTP body and `x-astera-session`
   *  header, carried unchanged. Answered only for a socket that has said hello — the Host's
   *  `greetedSockets` guard (design §9) — the same rule every other reply already follows. */
  /** `request` is the caller's own id for the *request*, as opposed to `call`, which is its id for
   *  this attempt on this socket (request receipts design §8). It rides the envelope rather than
   *  `args` because it is not an argument to any command: no `case` in `handleCommand` reads it, and
   *  the Host decides from it alone whether this call is a first attempt or a retry of one it has
   *  already answered. Additive, so HOST_PROTOCOL stays 3 — a Host from before it destructures
   *  `{cmd, args, session}` and runs the command unprotected, which is why the CLI must not send a
   *  *presented* id to a Host that has not announced the feature. */
  | { t: 'orch-call'; call: string; cmd: string; args: Record<string, unknown>; session?: string; request?: string }
  /** The app's answer to one `orch-act` (design §5), carrying back the `call` the Host asked with.
   *  `ok: false` is the action's own failure and `error` is what the command layer puts in its reply,
   *  so a refusal reads to the caller exactly as it did when the action ran inside the app. */
  | { t: 'orch-acted'; call: string; ok: boolean; value?: unknown; error?: string }
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
  /** The app's block records (HOST_FEATURE_BLOCKS): one change, or its whole registry after a
   *  handshake. Taken only from a greeted app; the Host absorbs it and does not broadcast it back. */
  | ({ t: 'blocks' } & BlocksBody)

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
  /** Answered instead of leaving, to a `{ t: 'retire', reason: 'user' }` while something is holding
   *  the Host (design §12) — `astera host stop` reports these counts and exits CONFLICT rather than
   *  quietly doing nothing. Additive: a Host old enough not to send it never refuses at all, which is
   *  the same "silently does less" an older Host already does for any message it does not know. */
  | {
      t: 'retire-refused'
      sessions: number
      /** **Runs with work in flight, and the word is `runs` because that is what is counted**
       *  (ruling F57/e). It said `jobs` while counting Runs, so one Job with two concurrent Runs
       *  reported 2 — and `astera host status` has a `jobs` of its own meaning a third thing (how
       *  many Jobs the file holds). One unit, one word. */
      runs: number
    }
  | { t: 'pong'; seq: number }
  /** Answers one `orch-call`, carrying its `call` back so the asker can match the reply to the
   *  request that made it. `status`/`body` are today's HTTP status and body, unchanged.
   *
   *  **`replayed` says this answer came out of a receipt rather than out of a run of the command**
   *  (request receipts design §8). Present only when the `request` this call carried had already
   *  taken effect on this Host: the command was not run a second time, and the CLI puts the same
   *  word at the top level of the envelope it prints.
   *
   *  **`observed` is the other kind of answer to a repeated id, and it is deliberately not the same
   *  word** (design §7). A command that committed and then waited is replayed by *observing*: the
   *  commit is not repeated, but the command does run again and the body is what is true now — for
   *  `check --ack <id> --wait` that is a fresh poll, which can open a new delivery the caller has
   *  never seen. Calling that `replayed` would publish a sentence ("the command was not run a second
   *  time") that is false for it, and a caller that skips a body it believes it has already handled
   *  would drop that batch and its delivery id. So an older reader, which knows only `replayed`, sees
   *  no marker at all here and treats the answer as the first answer it is.
   *
   *  Both are absent rather than `false` when they do not apply, so no older Host has to learn to
   *  send them and a reader can test for them with `?.`. */
  | { t: 'orch-result'; call: string; status: number; body: unknown; replayed?: true; observed?: true }
  /** Asks the app to do one thing the Host cannot do itself — spawn a session, touch a worktree
   *  (design §5). Sent only to a client whose `hello` said `role: 'app'`, and answered with
   *  `orch-acted` carrying the same `call`. */
  | { t: 'orch-act'; call: string; act: string; args: unknown }
  /** The whole orchestration state, pushed after every commit so the app can swap its mirror and
   *  derive its snapshot the way it does today (design §5). The whole state and not a patch because
   *  deriving a snapshot needs all of it anyway. */
  | {
      t: 'orch-state'
      state: OrchState
      /** How many commits this Host has made, counting this one. **The app quotes it back on
       *  `state-put`, and a Host that has moved on refuses the write** (ruling F56) — without it a
       *  whole-state write silently overwrites a commit made during the app's own await, which is
       *  how a click could erase a worker's finished report.
       *
       *  Optional because it is additive and the protocol stays 3: a Host from before this sends
       *  none, and an app that holds no version sends none, which the Host reads as "do not check"
       *  rather than as a mismatch. */
      version?: number
    }
  | { t: 'pty-spawned'; id: string; pid: number }
  | { t: 'pty-failed'; id: string; error: string }
  | { t: 'pty-data'; id: string; data: string }
  | { t: 'pty-exit'; id: string; exitCode: number }
  | { t: 'pty-listed'; entries: PtyEntry[] }
  /** A pty the Host opened **itself** — a worker or coordinator it spawned for a CLI call — broadcast
   *  to every greeted client so an attached app can adopt it the way it adopts sessions after a
   *  restart. Never sent in reply to a `pty-spawn`: the client that asked already has `pty-spawned`,
   *  and the session is its own. An older app ignores it, and adopts the session at its next boot. */
  | { t: 'pty-opened'; entry: PtyEntry }
  /** A merge the Host runs in a repository the app may be watching (host S3 ruling R7, §3.3):
   *  `begin` right before `git merge` into `cwd`, `end` in the `finally` after it. `op` is the Host's
   *  own id and pairs the two. The app registers it as its own git operation, so its Work Unit screen
   *  does not record the HEAD move as a change from outside, and ends every open one when the socket
   *  drops. An older app ignores it (subscribers filter on `m.t`, §7.1). */
  | { t: 'git-op'; op: string; phase: 'begin' | 'end'; kind: 'job-merge'; cwd: string }
  /** The whole worktrees.json as the Host just wrote it, pushed after every Host write so the app's
   *  registry mirror learns an entry it did not make (host S3 ruling R1). An older app ignores it.
   *  `seq` follows WorktreesSnapshot's contract (Task 1 re-review N2, review of Tasks 4-5 I1): one
   *  counter per Host life, shared with the `worktree-*` replies, reset by the receiver at each
   *  handshake's `worktree-list` fill, and a lower value than the last applied is ignored. */
  | ({ t: 'worktrees-state' } & WorktreesSnapshot)
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
  /** A Host chain's banner state (S6 §3.4). An app forwards it to its renderer, scheduler, Slack and
   *  desktop notices, and keeps the last lasting one per session. Additive. */
  | { t: 'roll-state'; event: RollStateEvent }
  /** A Host roll re-keyed a session (S6 §3.4). `ptyId` is the new session's pty, for the app to adopt
   *  before it forwards the rekey. `dest` is the codex copy the respawn appends to. Additive. */
  | { t: 'session-rolled'; oldSessionId: string; info: SessionInfo; ptyId: string | null; dest?: string }
  /** The Host's block records (HOST_FEATURE_BLOCKS): one change of its registry, broadcast, or the whole
   *  registry, sent once to an app right after its hello. The app absorbs it. Additive. */
  | ({ t: 'blocks' } & BlocksBody)
