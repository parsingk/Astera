// Where the app's worktree writes go once a Host announces it owns worktrees.json, and where the
// Host's own pushes come back in (host S3 ruling R1, R3). Local-mode behaviour — a plain file read
// and write through WorktreeRegistry — never moves: this only decides, on every status change,
// whether the registry's writes are redirected to the Host or run against the file here as they
// always have.
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
  registry: Pick<WorktreeRegistry, 'writeThrough' | 'accept' | 'load'>
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
   *  one rule a push and a write reply are both judged by (protocol.ts's contract). */
  const takeIfNewer = (seq: number, file: unknown): void => {
    if (lastSeq !== null && seq < lastSeq) return
    lastSeq = seq
    a.registry.accept(file)
  }

  const write = (cmd: string, args: Record<string, unknown>): Promise<RegistryFile> =>
    a.call({ cmd, args, sessionId: '' }).then((r) => {
      const body = r.body as SnapshotBody
      if (r.status >= 400) throw new Error(body?.error ?? String(r.status))
      // The reply carries the same snapshot a push would, applied by the same rule, so this
      // connection's mirror holds its own write before the push for it ever arrives.
      if (typeof body?.seq === 'number' && body.file !== undefined) takeIfNewer(body.seq, body.file)
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
        // A refill, not a push: it resets the counter to this fill's value regardless of what a
        // previous Host life's numbers were (protocol.ts's contract).
        if (typeof body?.seq === 'number') lastSeq = body.seq
        a.registry.accept(body?.file)
      } catch (err) {
        a.log(`worktree-list failed: ${err instanceof Error ? err.message : String(err)} — the next push or handshake fills it instead`)
      }
      return
    }
    if (!want && mode === 'host') {
      mode = 'local'
      lastSeq = null // a different Host life would mean nothing by the old numbers
      a.registry.writeThrough(null)
      await a.registry.load()
    }
  }

  const pushed = (m: HostMessage): void => {
    if (mode !== 'host') return
    if (m.t !== 'worktrees-state') return
    takeIfNewer(m.seq, m.file)
  }

  return { status, pushed }
}
