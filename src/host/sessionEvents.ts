// The session events the Host records in its public event log (plugin Phase 3, events and notifications design N2,
// N3): a session waiting on a person, stopped at a usage limit, or moved to another account. The same three things the
// desktop notifications say, by the same rules (desktopNotifier.ts): input needed is a turn into `waiting` of the one
// attention state (src/core/sessions/attention.ts), never a read of it per event, so subagents finishing under an open
// prompt do not repeat it; a roll's `reattach` is a re-publish, not a new wait or switch.
//
// **Where the signals come from** is the split Slack in the Host uses (slackSources.ts): every hook event of the
// profile (the rolling's hook tap), the chats and chains this Host holds, and the app's `session-signal` for the chats
// and chains only the app holds. A forward for a session the Host sources itself is dropped, so each is recorded once.
//
// **The session is read at the time of recording** (`sessionById`), falling back to what the app forwarded, then to
// its id and kind. The reads are chained, so two events of one session keep their order. Never throws: a failure is
// logged and the next event goes on.
//
// Imports only core modules and this folder: this bundles into the Host.
import { createAttentionState } from '../core/sessions/attention'
import { createPendingPromptState } from '../core/sessions/pendingPrompt'
import { hookEventPrompt } from '../core/hooks/sessionState'
import { parseSessionSignal, type SignalSession } from '../core/sessions/sessionSignal'
import type { EventDraft } from '../core/orchestration/publicEvents'
import type { HostSession } from '../core/orchestration/command'
import type { ChatEvent } from '../core/chat/types'
import type { EventType } from '../core/publicContract'
import type { Attention, RollStateEvent } from '../core/types'
import type { PtyRegistry } from './registry'
import type { ProcRegistry } from './procRegistry'
import type { HostChats } from './hostChats'
import type { HostRolling } from './rolling'

export interface HostSessionEvents {
  /** Every hook event of the profile (the rolling's hook tap). */
  onHookEvent(sessionId: string, payload: unknown): void
  /** A roll state of a chain this Host holds (the rolling's `onRollEvent`). */
  onRollState(e: RollStateEvent): void
  /** A `session-signal` body from a greeted app. */
  forwarded(raw: unknown): void
  /** Settles once every event noticed so far is recorded. */
  settled(): Promise<void>
  /** How many sessions it keeps anything for (at most SESSION_EVENTS_TRACKED_MAX). For tests and diagnostics. */
  tracked(): number
  dispose(): void
}

/** The most sessions the recorder keeps anything for. A session ends in this Host's registries and is forgotten then,
 *  but some never do (a pty an app started before it reached the Host, a chat status that lands after its proc's
 *  exit), so the least recently heard is forgotten past this many: a Host that runs for weeks keeps a bounded set
 *  (final review m1). A forgotten session that turns to waiting later is told as a fresh turn into it. */
export const SESSION_EVENTS_TRACKED_MAX = 1000

type Prompt = 'permission' | 'question' | null
type Kind = SignalSession['kind']
type ChatSignal = { type: 'status'; status: Attention } | { type: 'request'; request: 'approval' | 'question' | null }

export function createHostSessionEvents(d: {
  record(drafts: EventDraft[]): void
  sessionById(id: string): Promise<HostSession | null>
  registry: Pick<PtyRegistry, 'onExit' | 'metaOf' | 'sessionPty'>
  procs: Pick<ProcRegistry, 'onExit' | 'list'>
  chats: Pick<HostChats, 'subscribe' | 'has'> | null
  rolling: Pick<HostRolling, 'has'> | null
  log(message: string): void
}): HostSessionEvents {
  /** A log line never throws. */
  const log = (m: string): void => {
    try {
      d.log(m)
    } catch {
      /* nowhere to say it */
    }
  }
  const attention = createAttentionState()
  /** What each session would be waiting on, were it to turn to waiting now. */
  const asking = new Map<string, Prompt>()
  /** The call each terminal session waits on, by the app's own rules (pendingPrompt.ts): the latest PreToolUse wins, and a
   *  turn end from before the latest prompt is the previous turn's. A waiting on an AskUserQuestion is a question. */
  const pending = createPendingPromptState()
  const kinds = new Map<string, Kind>()
  /** The chat as an app forwarded it, for a chat the Host has no row for. A forwarded roll carries its own. */
  const told = new Map<string, SignalSession>()
  /** The sessions any of these maps holds, least recently heard first. */
  const order = new Map<string, true>()
  let queue: Promise<void> = Promise.resolve()
  let disposed = false

  /** The session as the Host's row has it, else as the app told it, else its id and the kind its signal implies. */
  const sessionOf = async (id: string, fallback: SignalSession | undefined, kind: Kind | undefined): Promise<SignalSession> => {
    let found: HostSession | null = null
    try {
      found = await d.sessionById(id)
    } catch (err) {
      log(`session ${id} could not be read: ${String(err)}`)
    }
    const known = found ?? fallback ?? null
    return {
      id,
      kind: known?.kind ?? kind ?? 'terminal',
      ...(known?.title ? { title: known.title } : {}),
      ...(known?.provider ? { provider: known.provider } : {}),
      ...(known?.cwd ? { cwd: known.cwd } : {})
    }
  }

  /** Queued behind the events before it; what the session is known by is taken now, before anything can forget it. */
  const record = (sessionId: string, type: EventType, rest: Record<string, unknown>, fallback = told.get(sessionId), kind = kinds.get(sessionId)): void => {
    queue = queue.then(async () => {
      const session = await sessionOf(sessionId, fallback, kind)
      try {
        d.record([{ type, sessionId, payload: { session, ...rest } }])
      } catch (err) {
        log(`${type} of ${sessionId} could not be recorded: ${String(err)}`)
      }
    })
  }

  attention.subscribe((sessionId, value) => {
    if (value === 'waiting') record(sessionId, 'session.input_needed', { prompt: asking.get(sessionId) ?? null })
  })

  const ended = (sessionId: string): void => {
    attention.forget(sessionId)
    asking.delete(sessionId)
    pending.forget(sessionId)
    kinds.delete(sessionId)
    told.delete(sessionId)
    order.delete(sessionId)
  }

  /** The session was just heard from: it is the most recent, and the least recent past the bound is forgotten. */
  const touch = (sessionId: string): void => {
    order.delete(sessionId)
    order.set(sessionId, true)
    for (const oldest of order.keys()) {
      if (order.size <= SESSION_EVENTS_TRACKED_MAX) break
      ended(oldest)
    }
  }

  const onChat = (sessionId: string, e: ChatSignal): void => {
    touch(sessionId)
    kinds.set(sessionId, 'chat')
    // A chat's adapter emits its request before the status it puts the session in (adapterCore.ts flush), so the
    // prompt is known when the status turns to waiting.
    if (e.type === 'request') asking.set(sessionId, e.request === null ? null : e.request === 'approval' ? 'permission' : 'question')
    else attention.set(sessionId, e.status)
  }

  /** A roll keeps nothing: it records or not by itself, with the session an app forwarded it with, if any. */
  const onRoll = (e: RollStateEvent, from?: SignalSession): void => {
    if (e.reattach) return
    const rest =
      e.state === 'waiting'
        ? // A limit judged from usage alone (manual) resumes nothing, so no retry time goes out with it.
          { type: 'session.limit_waiting' as const, payload: { ...(e.scope ? { scope: e.scope } : {}), ...(e.nextRetryAt && !e.manual ? { nextRetryAt: e.nextRetryAt } : {}) } }
        : e.state === 'switching' && e.accountLabel
          ? { type: 'session.account_switched' as const, payload: { accountLabel: e.accountLabel } }
          : null
    if (rest !== null) record(e.sessionId, rest.type, rest.payload, from ?? told.get(e.sessionId), from?.kind ?? kinds.get(e.sessionId))
  }

  const guard = (what: string, fn: () => void): void => {
    if (disposed) return
    try {
      fn()
    } catch (err) {
      log(`${what} failed: ${String(err)}`)
    }
  }

  const offs: Array<() => void> = [
    d.chats?.subscribe((sessionId, e: ChatEvent) =>
      guard('a chat event', () => {
        if (e.type === 'status') onChat(sessionId, { type: 'status', status: e.status })
        else if (e.type === 'request') onChat(sessionId, { type: 'request', request: e.request === null ? null : e.request.kind })
      })
    ) ?? (() => {}),
    d.registry.onExit((ptyId) =>
      guard('an exit', () => {
        const m = d.registry.metaOf(ptyId)
        // A respawn that keeps the id opens the new pty first (rolling.ts's rule): that exit is not its end.
        if (m?.kind === 'session' && d.registry.sessionPty(m.id) === null) ended(m.id)
      })
    ),
    d.procs.onExit((procId) =>
      guard('a chat exit', () => {
        const all = d.procs.list()
        const m = all.find((e) => e.id === procId)?.meta
        if (m?.kind === 'chat' && !all.some((e) => e.alive && e.meta?.kind === 'chat' && e.meta.id === m.id)) ended(m.id)
      })
    )
  ]

  return {
    onHookEvent: (sessionId, payload) =>
      guard('a hook event', () => {
        if (typeof payload !== 'object' || payload === null) return
        touch(sessionId)
        kinds.set(sessionId, 'terminal')
        pending.onHookEvent(sessionId, payload)
        // Set before attention hears the event: its subscriber, which records, runs inside onHookEvent.
        asking.set(sessionId, pending.get(sessionId)?.tool === 'AskUserQuestion' ? 'question' : hookEventPrompt(payload))
        attention.onHookEvent(sessionId, payload)
      }),
    onRollState: (e) => guard('a roll state', () => onRoll(e)),
    forwarded: (raw) =>
      guard('a forwarded signal', () => {
        const s = parseSessionSignal(raw)
        if (s === null) return log(`a malformed session signal was dropped: ${String(JSON.stringify(raw)).slice(0, 200)}`)
        if (s.kind === 'chat') {
          if (d.chats?.has(s.session.id)) return
          // Kept first: a first signal that is already the waiting records inside onChat, and is named by it.
          told.set(s.session.id, s.session)
          onChat(s.session.id, s.event)
        } else {
          if (d.rolling?.has(s.session.id)) return
          onRoll(s.event, s.session)
        }
      }),
    settled: () => queue,
    tracked: () => order.size,
    dispose() {
      disposed = true
      for (const off of offs) off()
    }
  }
}
