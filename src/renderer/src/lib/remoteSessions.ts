// A session on a paired Runtime as the renderer holds it (remote runtime design Phase 9b, N13, D1.4). Its tab is
// `sessionTab(key)`, `key` being `<runtimeId>:<sessionId>`; everything it does is a Host command on that Runtime
// (`remoteCall`), and its output arrives on the session bus under the key (main/remote/remoteStreams.ts).
import { remoteSessionKey } from '../../../core/panes/tabId'
import { SESSION_INPUT_MAX } from '../../../core/remote/sessions'
import type { ConvTurn } from '../../../core/history/convTypes'

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

/** `sessions-facts` (host/sessionFacts.ts). A fact the Host cannot source is `unknown`, never idle. */
export interface RemoteFacts {
  id: string
  alive: boolean
  status: 'working' | 'waiting' | 'idle' | 'unknown'
  prompt: 'permission' | 'question' | null | 'unknown'
  usage: unknown
  model: string | null
  requests?: Array<{ id: string; [k: string]: unknown }>
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

/** Whether a session's new facts call for a notification: it began waiting, or it asks something it did not ask
 *  before. The first read of a session is a baseline, and `unknown` never notifies. */
export function factsTransition(prev: RemoteFacts | null, next: RemoteFacts): 'waiting' | null {
  if (prev === null || next.status !== 'waiting') return null
  if (prev.status !== 'waiting') return 'waiting'
  const before = new Set((prev.requests ?? []).map((r) => r.id))
  return (next.requests ?? []).some((r) => !before.has(r.id)) ? 'waiting' : null
}

/** One conversation from its pages: an older page goes before what is held, and a newer read replaces the turns it
 *  repeats (the last turn grows while it streams) and adds the rest after. */
export function mergeTurns(held: ConvTurn[], page: ConvTurn[], side: 'older' | 'newer'): ConvTurn[] {
  if (side === 'older') {
    const have = new Set(held.map((t) => t.id))
    return [...page.filter((t) => !have.has(t.id)), ...held]
  }
  const fresh = new Map(page.map((t) => [t.id, t]))
  const kept = held.map((t) => fresh.get(t.id) ?? t)
  const have = new Set(held.map((t) => t.id))
  return [...kept, ...page.filter((t) => !have.has(t.id))]
}

/** A remote terminal's keys, batched for the link: keys typed within `delayMs` go as one `sessions-input`, sends go
 *  one at a time and in order, and a paste larger than one input carries is split. A send that fails is dropped (the
 *  link has already tried again); what was typed after it still goes. */
export class InputCoalescer {
  private queue = ''
  private timer: ReturnType<typeof setTimeout> | null = null
  private sending = false
  private disposed = false
  private readonly delayMs: number

  constructor(
    private readonly send: (data: string) => Promise<unknown>,
    o: { delayMs?: number } = {}
  ) {
    this.delayMs = o.delayMs ?? 16
  }

  push(data: string): void {
    if (this.disposed || data === '') return
    this.queue += data
    if (this.timer === null && !this.sending) this.timer = setTimeout(() => void this.drain(), this.delayMs)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.queue = ''
  }

  private async drain(): Promise<void> {
    this.timer = null
    this.sending = true
    try {
      while (!this.disposed && this.queue !== '') {
        const chunk = this.queue.slice(0, SESSION_INPUT_MAX)
        this.queue = this.queue.slice(chunk.length)
        await this.send(chunk).catch(() => undefined)
      }
    } finally {
      this.sending = false
    }
  }
}

/** A Host command on the Runtime, through main's orchestration router (Phase 7). */
export function remoteCall(runtimeId: string, cmd: string, args: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  return window.api.orch.command('', cmd, args, runtimeId)
}

/** The new remote session form as `sessions-create` takes it (core/orchestration/command.ts): the account is `account`,
 *  and an empty title or prompt is left out rather than refused there. No roll, worktree or schedule: those are this
 *  machine's options (Phase 9b Task 8). */
export function createSessionArgs(f: {
  kind: 'terminal' | 'chat'
  accountId: string
  cwd: string
  title: string
  prompt: string
}): Record<string, string> {
  const title = f.title.trim()
  const prompt = f.prompt.trim()
  return { kind: f.kind, account: f.accountId, cwd: f.cwd, ...(title ? { title } : {}), ...(prompt ? { prompt } : {}) }
}
