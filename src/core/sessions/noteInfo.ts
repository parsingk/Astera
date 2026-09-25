// The SessionInfo a session pty's note describes (S6 Task 12). SessionManager.adopt reads a note by this
// rule when an app takes its sessions back after a restart, and the Host's takeover reads the same note
// by the same rule when it carries an app's sessions on — one reading, so the two never disagree about
// which note is a session and what it says. The chat twin, chatInfoFromNote, does the same for
// ChatSessionManager.adopt and the Host's chat takeover. Imports only core types.
import type { SessionInfo } from '../types'

/** The SessionInfo a pty note describes, or null for a note of another kind or missing fields — the
 *  rule SessionManager.adopt reads by, shared with the Host's takeover. */
export function sessionInfoFromNote(a: { kind: string; id: string; restore: Record<string, unknown> }): SessionInfo | null {
  // Checked before any field, because the kinds' readable shapes overlap: a note of another kind can
  // satisfy the fields below and would come back rebuilt as the wrong thing.
  if (a.kind !== 'session') return null
  const r = a.restore
  const str = (k: string): string | undefined => (typeof r[k] === 'string' ? (r[k] as string) : undefined)
  const accountId = str('accountId')
  const cwd = str('cwd')
  const title = str('title')
  if (!accountId || !cwd || !title) return null
  return {
    id: a.id,
    accountId,
    cwd,
    status: 'running',
    title,
    // Spread rather than assigned, because the note omits what was absent at spawn rather than
    // carrying an undefined — so an absent key must stay absent here too.
    ...(str('resumeSessionId') ? { resumeSessionId: str('resumeSessionId') } : {}),
    // Elements checked, not just the array: the roll coordinators index accounts by these, and one
    // non-string in a list that crossed a process boundary would surface far from here.
    ...(Array.isArray(r.rollAccountIds) && r.rollAccountIds.every((x) => typeof x === 'string')
      ? { rollAccountIds: r.rollAccountIds as string[] }
      : {}),
    ...(str('rollPrompt') ? { rollPrompt: str('rollPrompt') } : {}),
    ...(typeof r.slackNotify === 'boolean' ? { slackNotify: r.slackNotify } : {}),
    ...(typeof r.bypassPermissions === 'boolean' ? { bypassPermissions: r.bypassPermissions } : {})
  }
}

/** The SessionInfo a chat proc's note describes, or null for a note of another kind or missing fields —
 *  the rule ChatSessionManager.adopt reads by, shared with the Host's chat takeover. */
export function chatInfoFromNote(a: { kind: string; id: string; restore: Record<string, unknown> }): SessionInfo | null {
  // Checked first for the same reason sessionInfoFromNote checks it first.
  if (a.kind !== 'chat') return null
  const r = a.restore
  const str = (k: string): string | undefined => (typeof r[k] === 'string' ? (r[k] as string) : undefined)
  const accountId = str('accountId')
  const cwd = str('cwd')
  const title = str('title')
  if (!accountId || !cwd || !title) return null
  const threadId = str('threadId') ?? null
  return {
    id: a.id,
    accountId,
    cwd,
    status: 'running',
    title,
    kind: 'chat',
    // The bypass box the session was started with. It is in the note (spawn writes it), and without
    // it a session taken back after a restart reads as "asks for permission" in every place that
    // shows the flag — a promise the running process is not keeping.
    ...(typeof r.bypassPermissions === 'boolean' ? { bypassPermissions: r.bypassPermissions } : {}),
    // resumeSessionId is the codex-side id the rest of the app keys on (the scheduler's store key,
    // the rollout watcher). `ready` sets both for a thread that is still starting; a note that
    // already names the thread must not have to wait for that to say what it is.
    ...(threadId ? { threadId, resumeSessionId: threadId } : {}),
    ...(typeof r.slackNotify === 'boolean' ? { slackNotify: r.slackNotify } : {}),
    // A chain with a non-string member is dropped whole rather than filtered — a chain is an ordered
    // promise, and half of one is a different promise.
    ...(Array.isArray(r.rollAccountIds) && r.rollAccountIds.every((x) => typeof x === 'string')
      ? { rollAccountIds: [...(r.rollAccountIds as string[])] }
      : {}),
    ...(typeof r.rollPrompt === 'string' ? { rollPrompt: r.rollPrompt } : {})
  }
}
