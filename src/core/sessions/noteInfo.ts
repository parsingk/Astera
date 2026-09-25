// The SessionInfo a session pty's note describes (S6 Task 12). SessionManager.adopt reads a note by this
// rule when an app takes its sessions back after a restart, and the Host's takeover reads the same note
// by the same rule when it carries an app's sessions on — one reading, so the two never disagree about
// which note is a session and what it says. Imports only core types.
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
