// The history guard's view of the sessions the Host rolls (S6 Task 14 fix round 1, I1). No coordinator
// here holds their chains, so neither findLiveByClaudeSession nor findLiveByCodexSession knows them, and
// a session a Host roll created while this app was attached was adopted before its native id existed.
// So the guard asks the Host's own pty notes when its local indexes miss, and a forwarded codex rekey
// seeds the thread id it carried over. Pure (and one injectable ask) so it is tested apart from ipc.ts.
import type { PtyEntry } from '../../core/host/protocol'
import type { SessionInfo } from '../../core/types'

/** The session id of the live session pty whose note carries this native id: `nativeSessionId` (Task
 *  13, both providers), or for a codex account `resumeSessionId` — a codex thread survives a resume, so
 *  the thread a session was resumed on is still its own. A claude resume forks a new session id, so its
 *  `resumeSessionId` names a conversation that session no longer writes. */
export function hostSessionByNative(
  entries: readonly PtyEntry[],
  native: string,
  isCodexAccount: (accountId: string) => boolean
): string | null {
  for (const e of entries) {
    if (!e.alive || e.meta?.kind !== 'session') continue
    const r = e.meta.restore
    if (r.nativeSessionId === native) return e.meta.id
    if (r.resumeSessionId === native && typeof r.accountId === 'string' && isCodexAccount(r.accountId)) return e.meta.id
  }
  return null
}

/** Asks the Host (its `pty-list`, bounded by that call's own deadline) only when it rolls. Any failure —
 *  no list, no answer, a throw — is null: the guard then behaves as it did before, rather than blocking
 *  a resume on a Host that is not there. */
export async function findHostHeldNative(
  d: {
    hostRolls: boolean
    list: (() => Promise<PtyEntry[] | null>) | null
    isCodexAccount: (accountId: string) => boolean
  },
  native: string
): Promise<string | null> {
  if (!d.hostRolls || !d.list) return null
  try {
    const entries = await d.list()
    return entries ? hostSessionByNative(entries, native, d.isCodexAccount) : null
  } catch {
    return null
  }
}

/** I1b: the native id a forwarded Host rekey already names — a codex roll's respawn resumes the same
 *  thread (`info.resumeSessionId`). A claude roll's new session id is not known until its statusline
 *  lands, and a blank-slate codex roll starts a thread nobody has named yet. */
export function nativeOfForwardedRekey(
  channel: 'session:rolled' | 'session:rollState',
  payload: unknown,
  codex: boolean
): { sessionId: string; native: string } | null {
  if (channel !== 'session:rolled' || !codex) return null
  const info = (payload as { info?: SessionInfo }).info
  return info && typeof info.resumeSessionId === 'string' && info.resumeSessionId !== ''
    ? { sessionId: info.id, native: info.resumeSessionId }
    : null
}
