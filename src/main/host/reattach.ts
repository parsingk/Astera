// Taking the Host's terminals back after an app restart (slice 2 design §7).
//
// Everything it needs arrives in the deps — the list, a handle for an existing pty, the three
// adopters — so this reads as the policy it is: which manager gets which entry, and what happens to
// one nobody can claim.
import type { PtyEntry } from '../../core/host/protocol'
import type { PtyLike } from '../../core/sessions/pty'

/** What an adopter needs to rebuild its record: the id and kind from the Host's note — so a
 *  manager's own `adopt` can check the kind and keep the original id (design §10) — the live pty,
 *  and the restore payload the manager itself wrote at spawn. */
interface AdoptArgs {
  id: string
  kind: string
  pty: PtyLike
  restore: Record<string, unknown>
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
  adopters: {
    session(a: AdoptArgs): boolean
    run(a: AdoptArgs): boolean
    terminal(a: AdoptArgs): boolean
  }
  log(m: string): void
}

export interface ReattachResult {
  adopted: number
  refused: number
  /** The ids of the entries adopted as sessions — the app's own id from before the restart, which an
   *  adopted session keeps (design §10), so this is exactly the same id Task 8's Dispatch matching
   *  already has stored. Runs and terminals have no such consumer, so only sessions are listed. */
  sessions: string[]
}

export async function reattachSessions(deps: ReattachDeps): Promise<ReattachResult> {
  let adopted = 0
  let refused = 0
  const sessions: string[] = []
  for (const e of await deps.list()) {
    // An exited pty is history the Host is still holding for its buffer. There is nothing to adopt
    // and nothing to kill, and it is not a refusal — nobody failed to read anything.
    if (!e.alive) continue
    if (!e.meta) {
      deps.log(`pty ${e.id} has no note saying what it is — killing it rather than leaving it ownerless`)
      deps.kill(e.id)
      refused += 1
      continue
    }
    try {
      const pty = deps.attach({ id: e.id, pid: e.pid })
      const ok = deps.adopters[e.meta.kind]?.({ id: e.meta.id, kind: e.meta.kind, pty, restore: e.meta.restore }) ?? false
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
  return { adopted, refused, sessions }
}
