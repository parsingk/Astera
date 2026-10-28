// Whether a session the Host holds runs in its CLI's sandbox (final fix pass, C3): the command layer asks it of the
// session a call's workload token names, and what that session starts, a session, a Job's coordinator, a worker, then
// starts in the sandbox too (core/orchestration/command.ts sandboxedCaller).
import type { PtyMeta } from '../core/host/protocol'

/** The note's mark: the session manager writes `sandboxed: true` into the note of a sandboxed spawn, terminal or chat
 *  (core/sessions/manager.ts, core/chat/manager.ts), and a roll's successor carries it. */
const sandboxedNote = (meta: PtyMeta | null | undefined): boolean => meta?.restore?.sandboxed === true

/** True when the live pty of the session, or its live chat proc, has a note that says it runs in the sandbox. False for
 *  a session this Host does not hold: a token is live only while the Host holds its owner (gateway/tokens.ts), so a call
 *  that carries one names a session found here. */
export function sessionSandboxedIn(
  a: {
    ptys: { sessionPty(sessionId: string): string | null; metaOf(id: string): PtyMeta | null }
    procs: { liveEntries(): Array<{ id: string; meta: PtyMeta | null }> }
  },
  sessionId: string
): boolean {
  const pty = a.ptys.sessionPty(sessionId)
  if (pty !== null) return sandboxedNote(a.ptys.metaOf(pty))
  return a.procs.liveEntries().some((e) => e.meta?.kind === 'chat' && e.meta.id === sessionId && sandboxedNote(e.meta))
}
