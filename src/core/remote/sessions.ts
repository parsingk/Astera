// What a controller and a Runtime agree on for a remote session's commands (remote runtime design Phase 9). Shared by
// the Host's checks (host/remoteSessions.ts) and the app's input batching (renderer lib/remoteSessions.ts); and the app's
// ref to a session there with the roll it follows (Phase 9b).
// node: import 없음 — 렌더러가 import한다.
import { remoteSessionKey } from '../panes/tabId'

/** The most one `sessions-input` carries: a paste, never a file. */
export const SESSION_INPUT_MAX = 64 * 1024
/** The longest message a declined approval carries back to the CLI. */
export const ANSWER_MESSAGE_MAX = 4096

/** A row of the Runtime's `sessions-list`, as its Host answers it (core/orchestration/command.ts HostSession). */
export interface RemoteSessionRow {
  id: string
  kind: 'terminal' | 'chat'
  title: string | null
  accountId: string | null
  cwd: string | null
  alive: boolean
  state: string
  ptyId?: string
  procId?: string
  provider?: 'claude' | 'codex'
  rolledFrom?: string
  sources?: { status: string; prompt: string; usage: string; conversation: string }
}

export interface RemoteSessionRef {
  runtimeId: string
  sessionId: string
  key: string
  kind: 'terminal' | 'chat'
  title: string | null
  accountId: string | null
  /** The Runtime's path, shown as text and never handed to a local path helper (D8.1). */
  cwd: string | null
  alive: boolean
  ptyId?: string
  procId?: string
  provider?: 'claude' | 'codex'
  sources?: RemoteSessionRow['sources']
}

export function refOf(runtimeId: string, row: RemoteSessionRow): RemoteSessionRef {
  return {
    runtimeId,
    sessionId: row.id,
    key: remoteSessionKey(runtimeId, row.id),
    kind: row.kind,
    title: row.title,
    accountId: row.accountId,
    cwd: row.cwd,
    alive: row.alive,
    ...(row.ptyId ? { ptyId: row.ptyId } : {}),
    ...(row.procId ? { procId: row.procId } : {}),
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.sources ? { sources: row.sources } : {})
  }
}

/** The open sessions (of one Runtime) that a roll replaced, each with the session that now stands in for it: the end
 *  of the `rolledFrom` chain, so a tab that missed several rolls while disconnected lands on the current one. A roll
 *  into a session that is already open is left alone. */
export function followRolls(open: RemoteSessionRef[], rows: RemoteSessionRow[]): Array<{ from: string; to: RemoteSessionRef }> {
  if (open.length === 0) return []
  const runtimeId = open[0].runtimeId
  const openIds = new Set(open.map((r) => r.sessionId))
  const next = new Map<string, RemoteSessionRow>()
  for (const r of rows) if (r.rolledFrom) next.set(r.rolledFrom, r)
  const out: Array<{ from: string; to: RemoteSessionRef }> = []
  for (const ref of open) {
    let to = next.get(ref.sessionId)
    if (!to) continue
    const seen = new Set([ref.sessionId])
    for (let n = next.get(to.id); n && !seen.has(n.id); n = next.get(n.id)) {
      seen.add(to.id)
      to = n
    }
    if (openIds.has(to.id)) continue
    out.push({ from: ref.key, to: refOf(runtimeId, to) })
  }
  return out
}
