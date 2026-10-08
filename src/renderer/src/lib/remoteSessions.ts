// A session on a paired Runtime as the renderer holds it (remote runtime design Phase 9b, N13, D1.4). Its tab is
// `sessionTab(key)`, `key` being `<runtimeId>:<sessionId>`; everything it does is a Host command on that Runtime
// (`remoteCall`), and its output arrives on the session bus under the key (main/remote/remoteStreams.ts).
import { SESSION_INPUT_MAX } from '../../../core/remote/sessions'
import type { ConvTurn } from '../../../core/history/convTypes'

// The ref and the roll it follows live in core, where main's acceptance test reaches them too.
export { refOf, followRolls, type RemoteSessionRef, type RemoteSessionRow } from '../../../core/remote/sessions'

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
  // A poll's answer is new objects every time (performance audit R3): a turn that reads the same keeps the held object,
  // and a page that changed nothing keeps the held list, so the thread does not re-draw every poll.
  const fresh = new Map(page.map((t) => [t.id, t]))
  let changed = false
  const kept = held.map((t) => {
    const f = fresh.get(t.id)
    if (f === undefined || f === t || JSON.stringify(f) === JSON.stringify(t)) return t
    changed = true
    return f
  })
  const have = new Set(held.map((t) => t.id))
  const added = page.filter((t) => !have.has(t.id))
  return changed || added.length > 0 ? [...kept, ...added] : held
}

/** `prev` when `next` says the same (performance audit R3): a poll's facts are new objects every time, and setting them
 *  re-rendered the tab every 2 s with nothing new. */
export function sameOrNext<T>(prev: T | null, next: T): T {
  return prev !== null && JSON.stringify(prev) === JSON.stringify(next) ? prev : next
}

/** Runs `tick`, then again `ms` after each one ends, until the returned stop. A tick that throws does not end the
 *  polling (performance audit R3: a rejected read used to stop an open remote chat's updates for good). */
export function pollEvery(tick: () => Promise<void>, ms: number): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const run = async (): Promise<void> => {
    try {
      await tick()
    } catch {
      /* the next tick asks again */
    }
    if (!stopped) timer = setTimeout(() => void run(), ms)
  }
  void run()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
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
  private readonly onDelivery?: (ok: boolean) => void

  /** `onDelivery`: each send's outcome, so input the Runtime did not take is said (review I1): delivered when it
   *  resolves to a 2xx `{ status }`, or to anything without one; not when it throws or answers otherwise. */
  constructor(
    private readonly send: (data: string) => Promise<unknown>,
    o: { delayMs?: number; onDelivery?: (ok: boolean) => void } = {}
  ) {
    this.delayMs = o.delayMs ?? 16
    this.onDelivery = o.onDelivery
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
        const ok = await this.send(chunk).then(
          (r) => {
            const status = (r as { status?: unknown } | null)?.status
            return typeof status !== 'number' || (status >= 200 && status < 300)
          },
          () => false
        )
        if (!this.disposed) this.onDelivery?.(ok)
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

/** Codes after which subscribing again cannot help: core/remote/link.ts FINAL, a Runtime that cannot stream, and one
 *  that is no longer paired here (review M1: removed in Settings, its tab must not say "reconnecting" forever). */
const FINAL_GONE = new Set([
  'RUNTIME_IDENTITY_CHANGED',
  'RUNTIME_AUTH_FAILED',
  'RUNTIME_PROTOCOL_MISMATCH',
  'RUNTIME_CAPABILITY_MISSING',
  'RUNTIME_NOT_FOUND'
])

/** What a remote terminal tab does when its stream is given up: a session already ended stays ended (its pty may be
 *  gone after a reconnect), a final code is shown as such, anything else is tried again while the tab is open. */
export function goneOutcome(code: string, o: { ended: boolean }): 'ended' | 'final' | 'retry' {
  if (o.ended) return 'ended'
  return FINAL_GONE.has(code) ? 'final' : 'retry'
}

/** A tab's status from a `sessions-facts` reply: anything but an answer is `unknown`, so a Runtime that cannot be
 *  reached does not leave the tab showing its last status as current (review I1). */
export function factsStatus(r: { status: number; body: unknown }): RemoteFacts['status'] {
  const status = (r.body as { status?: unknown } | null)?.status
  return r.status === 200 && (status === 'working' || status === 'waiting' || status === 'idle' || status === 'unknown') ? status : 'unknown'
}

type Call = (runtimeId: string, cmd: string, args: Record<string, unknown>) => Promise<{ status: number; body: unknown }>

/** One session's `sessions-facts`, shared by everything that shows it (review M5: a visible remote chat and the tab
 *  watch read it on their own clocks): a read in flight is joined, and an answer younger than `freshMs` is reused. */
export function createFactsReader(
  call: Call,
  o: { now?: () => number; freshMs?: number } = {}
): (runtimeId: string, sessionId: string) => Promise<{ status: number; body: unknown }> {
  const now = o.now ?? Date.now
  const freshMs = o.freshMs ?? 1_000
  const kept = new Map<string, { at: number; reply: Promise<{ status: number; body: unknown }> }>()
  return (runtimeId, sessionId) => {
    const key = `${runtimeId}:${sessionId}`
    const k = kept.get(key)
    if (k && now() - k.at < freshMs) return k.reply
    const reply = call(runtimeId, 'sessions-facts', { id: sessionId })
    const entry = { at: now(), reply }
    kept.set(key, entry)
    // A failed read is not kept: the next one asks again. Old answers go once they are stale.
    void reply.then(
      (r) => {
        if (r.status !== 200 && kept.get(key) === entry) kept.delete(key)
      },
      () => {
        if (kept.get(key) === entry) kept.delete(key)
      }
    )
    for (const [k2, e] of kept) if (now() - e.at >= freshMs && k2 !== key) kept.delete(k2)
    return reply
  }
}

/** The app's facts reader, over the orchestration router. */
export const readFacts = createFactsReader((runtimeId, cmd, args) => remoteCall(runtimeId, cmd, args))

/** Forgets the notification baseline of tabs that are closed (review M3): a session opened again starts a new one. */
export function pruneBaseline(last: Map<string, unknown>, openKeys: string[]): void {
  const open = new Set(openKeys)
  for (const k of [...last.keys()]) if (!open.has(k)) last.delete(k)
}

/** What a tab does when its session was rolled into `toKey` (review M4): it becomes the new session's tab, or, when the
 *  person already opened that session in a tab of its own, it goes, so the tree never holds the same session twice. */
export function followAction(openKeys: string[], _fromKey: string, toKey: string): 'replace' | 'drop' {
  return openKeys.includes(toKey) ? 'drop' : 'replace'
}

/** What a remote chat tab lets the person do (review M7): its facts decide once they arrive, its row before. A card is
 *  answered from the tab, or shown as a note to a read-only pairing; the composer is shut while a card waits, for a
 *  read-only pairing and once the chat ended. */
export function remoteChatState(o: { facts: RemoteFacts | null; sessionAlive: boolean; readOnly: boolean }): {
  alive: boolean
  request: { id: string; [k: string]: unknown } | null
  composerDisabled: boolean
  card: 'answer' | 'note' | null
  canStop: boolean
  status: RemoteFacts['status']
} {
  const alive = o.facts?.alive ?? o.sessionAlive
  const request = o.facts?.requests?.[0] ?? null
  return {
    alive,
    request,
    composerDisabled: o.readOnly || !alive || request !== null,
    card: request === null ? null : o.readOnly ? 'note' : 'answer',
    canStop: !o.readOnly && alive,
    status: o.facts?.status ?? 'unknown'
  }
}

/** A remote chat card's answer, as the Runtime's `sessions-answer`; a refusal is thrown with its message, which the
 *  card shows (review M7). */
export function createRemoteAnswer(call: Call, runtimeId: string, sessionId: string): (request: string, answer: unknown) => Promise<void> {
  return async (request, answer) => {
    const r = await call(runtimeId, 'sessions-answer', { id: sessionId, request, answer })
    if (r.status !== 200) throw new Error(String((r.body as { error?: unknown } | null)?.error ?? r.status))
  }
}

/** Whether a new session can be started from here at all: with an agent CLI on this machine, or a paired Runtime to
 *  start it on (a controller needs no CLI of its own). The dialog says the rest. */
export function canStartSession(o: { cliInstalled: boolean; pairedRuntimes: number }): boolean {
  return o.cliInstalled || o.pairedRuntimes > 0
}
