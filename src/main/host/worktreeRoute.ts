// Where the app's worktree writes go once a Host announces it owns worktrees.json, and where the
// Host's own pushes come back in (host S3 ruling R1, R3). Local-mode behaviour — a plain file read
// and write through WorktreeRegistry — never moves: this only decides, on every status change,
// whether the registry's writes are redirected to the Host or run against the file here as they
// always have. More than one process can hold the file this way (the Host and this app, D3), which is
// exactly why every switch back to local re-reads rather than trusting what memory already has.
//
// **The seq contract (protocol.ts's WorktreesSnapshot).** The Host keeps one counter per its life,
// bumped on every change, and carries it on every `worktrees-state` push and on the body of every
// `worktree-*` reply. This route keeps the last one it applied, resets that at every refill
// (`worktree-list`, run on every local→host switch — a connected→disconnected→connected sequence
// always passes back through local first, which is what makes every new handshake refill) and
// ignores anything older than the last one applied. A write reply's snapshot is applied the same way
// a push is — by the same seq check — so this connection's mirror holds its own write before the
// Host's push for it ever arrives.
import type { RegistryFile, WorktreeRegistry, WorktreeWriter } from '../../core/worktrees/registry'
import type { HostMessage } from '../../core/host/protocol'
import { hostSpeaksWorktrees } from './outdated'

type Call = (m: { cmd: string; args: Record<string, unknown>; sessionId: string }) => Promise<{ status: number; body: unknown }>

/** What a `worktree-*` reply's body holds — protocol.ts's WorktreesSnapshot, read defensively because
 *  it arrives over the wire. `error` is what a refusal (status >= 400) carries instead. */
interface SnapshotBody {
  seq?: number
  file?: unknown
  error?: string
}

export function createWorktreeRoute(a: {
  registry: Pick<WorktreeRegistry, 'writeThrough' | 'accept' | 'refresh'>
  call: Call
  log(m: string): void
}): {
  /** Every status change. To the Host when connected, answering and announcing worktrees; else local. */
  status(s: { connected: boolean; unresponsive?: boolean; features: readonly string[] }): Promise<void>
  /** Every Host message; takes `worktrees-state`. */
  pushed(m: HostMessage): void
} {
  let mode: 'host' | 'local' = 'local'
  // The last seq this connection applied. Null before the first refill of this Host life: nothing is
  // older than that, so the first push or write reply after one is always taken.
  let lastSeq: number | null = null

  /** Applies a snapshot's file if its seq is not older than the last one this connection took — the
   *  one rule a push and a write reply are both judged by (protocol.ts's contract). Advances `lastSeq`
   *  only when `accept` actually took the file (fix round 1, M3): a malformed one must not move the
   *  counter past a good file a later, in-order message could still apply. */
  const takeIfNewer = (seq: number, file: unknown): void => {
    if (lastSeq !== null && seq < lastSeq) return
    if (a.registry.accept(file)) lastSeq = seq
  }

  const write = (cmd: string, args: Record<string, unknown>): Promise<RegistryFile> =>
    a.call({ cmd, args, sessionId: '' }).then((r) => {
      const body = r.body as SnapshotBody
      if (r.status >= 400) throw new Error(body?.error ?? String(r.status))
      // The reply carries the same snapshot a push would, applied by the same rule, so this
      // connection's mirror holds its own write before the push for it ever arrives. Guarded on
      // `mode` (fix round 1, M3): a write already in flight to the Host when the route falls back to
      // local must not have its reply overwrite whatever `refresh()` just re-read from disk.
      if (mode === 'host' && typeof body?.seq === 'number' && body.file !== undefined) takeIfNewer(body.seq, body.file)
      return body?.file as RegistryFile
    })

  const writer: WorktreeWriter = {
    add: (info) => write('worktree-add', { info }),
    removeEntry: (id) => write('worktree-remove', { id }),
    setRoot: (root) => write('worktree-root', { root })
  }

  const status = async (s: { connected: boolean; unresponsive?: boolean; features: readonly string[] }): Promise<void> => {
    const want = hostSpeaksWorktrees(s) && s.unresponsive !== true
    if (want && mode === 'local') {
      mode = 'host'
      a.registry.writeThrough(writer)
      try {
        const r = await a.call({ cmd: 'worktree-list', args: {}, sessionId: '' })
        const body = r.body as SnapshotBody
        if (r.status >= 400) {
          a.log(`worktree-list refused (${r.status}): ${body?.error ?? ''} — the next push or handshake fills it instead`)
          return
        }
        // Guarded on `mode` (fix round 1, M6/M3 pattern): a `status(off)` racing ahead of this same
        // reply — the list is still in flight when the Host goes unresponsive or disconnects — must
        // not have this fill overwrite what `refresh()` already re-read from disk on the way back to
        // local. Only relevant while still host does the seq check make sense at all: `lastSeq` means
        // nothing once the route has left and reset it.
        if (mode === 'host') {
          // Judged by the same rule a push is (fix round 1, I2), not applied outright: the list
          // request and a push can both be in flight at once, and the reply's `await` continuation
          // only resumes in a microtask, after every line already in the socket's buffer — including
          // a newer push — has run. `lastSeq` is null on every local→host switch (reset below on the
          // way back to local), so with nothing racing this still takes the fill unconditionally,
          // exactly as a refill should; it only refuses to roll back a push that got there first.
          if (typeof body?.seq === 'number') takeIfNewer(body.seq, body.file)
          else a.registry.accept(body?.file)
        }
      } catch (err) {
        a.log(`worktree-list failed: ${err instanceof Error ? err.message : String(err)} — the next push or handshake fills it instead`)
      }
      return
    }
    if (!want && mode === 'host') {
      mode = 'local'
      lastSeq = null // a different Host life would mean nothing by the old numbers
      a.registry.writeThrough(null)
      // refresh(), not load() (fix round 1, I3): load() heals a damaged file by wiping it, which is
      // right once at process start and wrong in the middle of the app's life (WorktreeRegistry's own
      // doc comment on refresh(), and the Host's `fresh()` repeats the same rule, Task 1 N1) — a rule
      // the codebase already holds itself to, and one this route's brief did not know to ask for.
      // refresh() is queued behind any local write already waiting its turn and refuses a damaged
      // file as `RepairNeeded` instead of wiping it; caught and logged rather than left to reject
      // `status()` itself, which the caller (ipc.ts) would otherwise have to know to expect.
      try {
        await a.registry.refresh()
      } catch (err) {
        a.log(`worktrees.json could not be re-read after returning to local: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  const pushed = (m: HostMessage): void => {
    if (mode !== 'host') return
    if (m.t !== 'worktrees-state') return
    takeIfNewer(m.seq, m.file)
  }

  return { status, pushed }
}
