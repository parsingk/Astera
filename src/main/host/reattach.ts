// Taking the Host's terminals back after an app restart (slice 2 design §7).
//
// Everything it needs arrives in the deps — the list, a handle for an existing pty, the three
// adopters — so this reads as the policy it is: which manager gets which entry, and what happens to
// one nobody can claim.
import type { PtyEntry } from '../../core/host/protocol'
import type { PtyLike } from '../../core/sessions/pty'
import type { ProcLike } from '../../core/sessions/proc'

/** What an adopter needs to rebuild its record: the id and kind from the Host's note — so a
 *  manager's own `adopt` can check the kind and keep the original id (design §10) — the live pty,
 *  and the restore payload the manager itself wrote at spawn. */
interface AdoptArgs {
  id: string
  kind: string
  pty: PtyLike
  restore: Record<string, unknown>
}

/** What the chat adopter needs: like AdoptArgs, with a line process instead of a pty, and whether the
 *  Host's replay buffer had to drop lines — the adapter reads that before trusting the replay for
 *  status (chat-sessions design §6.5). */
interface AdoptProcArgs {
  id: string
  kind: 'chat'
  proc: ProcLike
  restore: Record<string, unknown>
  truncated: boolean
}

/** Each adopter reports whether it could rebuild its record from the note — true once the pty is
 *  back under the manager that owns its kind, false when the note could not be read. There is no new
 *  id to report: an adopted record keeps the one the note carries (see the ruling on
 *  `ReattachResult.sessions` below), so a boolean is all a caller here needs. */
export interface ReattachDeps {
  list(): Promise<PtyEntry[]>
  /** A live handle for a pty the Host already has. */
  attach(a: { id: string; pid: number }): PtyLike
  /** Asks the Host to replay this session's scrollback to us. */
  sendAttach(id: string): void
  kill(id: string): void
  /** The Host's line processes. Absent when the app does not ask for them — nothing sends proc-list
   *  to a Host that cannot answer it. */
  listProcs?(): Promise<PtyEntry[]>
  attachProc?(a: { id: string; pid: number }): ProcLike
  /** Asks the Host to replay this process's buffered lines to us. */
  sendAttachProc?(id: string): void
  killProc?(id: string): void
  /** Whether the app already has a **live** record for the thing this note names — the manager the
   *  kind names, holding that id and still running.
   *
   *  A pty spawned between the handshake and the `pty-list` reply is in that reply, and the app has a
   *  working handle for it already; adopting it again puts a second handle on one pty, so every byte
   *  arrives twice and two records write to it. Exited does not count: a reconnect's whole job is
   *  adopting sessions the app marked exited when the socket dropped. */
  heldLive(a: { kind: string; id: string }): boolean
  adopters: {
    session(a: AdoptArgs): boolean
    run(a: AdoptArgs): boolean
    terminal(a: AdoptArgs): boolean
    chat?(a: AdoptProcArgs): boolean
  }
  log(m: string): void
  /** Take back only the pty with this Host id — the entry a `pty-opened` named. Other entries are
   *  left exactly as they are: not adopted, not killed, not counted. Line processes are not listed. */
  only?: string
  /** Take back only the line process with this Host id (a chat roll's `session-rolled.procId`); ptys are
   *  not listed, and every other line process is left exactly as it is. */
  onlyProc?: string
  /** A chat proc this sweep must leave alone for now: neither adopted nor killed, no proc-attach sent,
   *  and reported live (chat takeover P5: the Host is still in its handshake and carry-on). */
  deferProc?(e: PtyEntry): boolean
}

export interface ReattachResult {
  adopted: number
  refused: number
  /** The session ids this sweep leaves the app running — the ones it adopted, plus the ones it found
   *  the app was already running (`heldLive`). The app's own id from before the restart, which an
   *  adopted session keeps (design §10), so this is exactly the same id Task 8's Dispatch matching
   *  already has stored. Runs and terminals have no such consumer, so only sessions are listed. */
  sessions: string[]
  /** The chat session ids this sweep leaves the app running, as `sessions` does for ptys. */
  chats: string[]
  /** Set by the caller when the Host was asked for its line processes and did not answer: `chats` is
   *  then not a fact, and a boot cleanup must not write a chat session off on it (the same rule
   *  SessionsTakenBack's 'unknown' states for ptys). */
  chatsUnknown?: boolean
}

export async function reattachSessions(deps: ReattachDeps): Promise<ReattachResult> {
  let adopted = 0
  let refused = 0
  const sessions: string[] = []
  // A chat roll's push names one line process; the pty list is not this sweep's at all.
  for (const e of deps.onlyProc !== undefined ? [] : await deps.list()) {
    // Not this sweep's: a `pty-opened` names one session the Host started, and every other entry is
    // one the app took back already, or one the next full sweep decides about. Killing a note-less
    // entry from here would be a verdict this sweep was never asked to give.
    if (deps.only !== undefined && e.id !== deps.only) continue
    // An exited pty is history the Host is still holding for its buffer. There is nothing to adopt
    // and nothing to kill, and it is not a refusal — nobody failed to read anything.
    if (!e.alive) continue
    if (!e.meta) {
      deps.log(`pty ${e.id} has no note saying what it is — killing it rather than leaving it ownerless`)
      deps.kill(e.id)
      refused += 1
      continue
    }
    // Already ours and running — nothing to take back, and nothing wrong with it either, so it is
    // neither adopted nor refused. It is still reported as a live session below: the boot cleanup reads
    // that list to tell a live orchestration worker from one it should write off, and a worker the app
    // is already running is as live as one it just took back.
    if (deps.heldLive({ kind: e.meta.kind, id: e.meta.id })) {
      deps.log(`pty ${e.id} is already ours and running — left as it is`)
      if (e.meta.kind === 'session') sessions.push(e.meta.id)
      continue
    }
    try {
      const pty = deps.attach({ id: e.id, pid: e.pid })
      const kind = e.meta.kind
      // A pty never carries a chat note — chat sessions are line processes, listed separately (Task 5
      // adds that sweep). One that does is a note this build cannot read, refused like any other.
      const adopter = kind === 'chat' ? undefined : deps.adopters[kind]
      const ok = adopter?.({ id: e.meta.id, kind, pty, restore: e.meta.restore }) ?? false
      if (!ok) {
        deps.log(`pty ${e.id} carries a ${e.meta.kind} note this build cannot read — killing it`)
        deps.kill(e.id)
        refused += 1
        continue
      }
      // Only after somebody owns it: the replay arrives as ordinary output, and it needs a listener.
      deps.sendAttach(e.id)
      adopted += 1
      if (e.meta.kind === 'session') sessions.push(e.meta.id)
    } catch (err) {
      // A note this build can partly read is not one it can trust: the real adopters dereference
      // `restore` unchecked, so a malformed one throws instead of returning false. Contained here the
      // same way an unreadable note is, as a refusal — one bad entry must not cost every entry after
      // it in the list its turn.
      deps.log(`pty ${e.id} could not be taken back: ${String(err)}`)
      deps.kill(e.id)
      refused += 1
    }
  }
  const chats: string[] = []
  // A pty-opened is about a pty, never a line process, so a sweep limited to one skips them all.
  if (deps.only === undefined && deps.listProcs && deps.attachProc && deps.sendAttachProc && deps.killProc) {
    for (const e of await deps.listProcs()) {
      // Not this sweep's, as with `only` for ptys: every other entry is left exactly as it is.
      if (deps.onlyProc !== undefined && e.id !== deps.onlyProc) continue
      if (!e.alive) continue
      if (!e.meta) {
        deps.log(`proc ${e.id} has no note saying what it is — killing it rather than leaving it ownerless`)
        deps.killProc(e.id)
        refused += 1
        continue
      }
      if (e.meta.kind !== 'chat') {
        deps.log(`proc ${e.id} carries a ${e.meta.kind} note, which is not a line process — killing it`)
        deps.killProc(e.id)
        refused += 1
        continue
      }
      // P5: the Host owns this proc's handshake and carry-on until its note drops `hostStarting`. A
      // proc-attach now would make this app the writer mid-handshake, and a refusal would kill it. Live,
      // though: the boot cleanup must not write it off.
      if (deps.deferProc?.(e)) {
        deps.log(`proc ${e.id}: the Host is still starting it — left for its push`)
        chats.push(e.meta.id)
        continue
      }
      if (deps.heldLive({ kind: 'chat', id: e.meta.id })) {
        deps.log(`proc ${e.id} is already ours and running — left as it is`)
        chats.push(e.meta.id)
        continue
      }
      try {
        const proc = deps.attachProc({ id: e.id, pid: e.pid })
        const ok = deps.adopters.chat?.({ id: e.meta.id, kind: 'chat', proc, restore: e.meta.restore, truncated: e.truncated === true }) ?? false
        if (!ok) {
          deps.log(`proc ${e.id} carries a chat note this build cannot read — killing it`)
          deps.killProc(e.id)
          refused += 1
          continue
        }
        // Only after somebody owns it, as with a pty: the replay arrives as ordinary lines.
        deps.sendAttachProc(e.id)
        adopted += 1
        chats.push(e.meta.id)
      } catch (err) {
        deps.log(`proc ${e.id} could not be taken back: ${String(err)}`)
        deps.killProc(e.id)
        refused += 1
      }
    }
  }
  return { adopted, refused, sessions, chats }
}
