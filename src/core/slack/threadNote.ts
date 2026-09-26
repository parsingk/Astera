// The session thread kept in the session's note (Slack in the Host, spec S5). The note keys are
// `slackThreadTs` and `slackChannel`: whoever owns Slack writes them (plan ruling P9), and this file is
// the only reader, so a restart, a roll or an ownership handover resumes the same root instead of
// posting a second one.

/** The note keys the thread is kept under. */
export const THREAD_NOTE_KEYS = ['slackThreadTs', 'slackChannel'] as const

export interface NotedThread {
  ts: string
  channel: string
}

/** The thread a session's note names (keys slackThreadTs, slackChannel), or null. */
export function notedThreadOf(restore: Record<string, unknown>): NotedThread | null {
  const ts = restore.slackThreadTs
  const channel = restore.slackChannel
  return typeof ts === 'string' && typeof channel === 'string' ? { ts, channel } : null
}

/** The note patch for a thread, or the one that drops it (both keys null). */
export function threadNotePatch(t: NotedThread | null): { slackThreadTs: string | null; slackChannel: string | null } {
  return t ? { slackThreadTs: t.ts, slackChannel: t.channel } : { slackThreadTs: null, slackChannel: null }
}
