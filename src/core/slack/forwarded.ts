// What an app forwards to a Slack-owning Host (Slack in the Host, spec §3.3): the events only the app
// sees, so the Host's notifier can post them. Parsed at the Host's socket, where anything malformed is
// dropped rather than trusted.
import type { ChatEvent } from '../chat/types'
import type { Provider } from '../providers/meta'
import type { RollStateEvent, SessionInfo } from '../types'

/** One forwarded event. A `chat` event carries its account and the transcript path the app knows
 *  (plan ruling P11); a `rolled` keeps the roll's `dest` when the app had one. */
export type SlackForwardedEvent =
  | { kind: 'chat'; sessionId: string; accountId: string; event: ChatEvent; provider: Provider; transcriptPath: string | null }
  | { kind: 'roll-state'; event: RollStateEvent }
  | { kind: 'rolled'; oldSessionId: string; info: SessionInfo; dest?: string }

/** The chat events the notifier reads. Never an exit: the Host sources every exit itself (P6). */
const FORWARDED_CHAT: ReadonlySet<string> = new Set(['ready', 'status', 'request', 'error'])
export const isForwardedChatEvent = (e: ChatEvent): boolean => FORWARDED_CHAT.has(e.type)
const str = (v: unknown): v is string => typeof v === 'string' && v !== ''
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Reads a forwarded event off the wire, or null for anything else. */
export function parseSlackForwarded(v: unknown): SlackForwardedEvent | null {
  if (!obj(v)) return null
  if (v.kind === 'chat') {
    const e = v.event
    if (!str(v.sessionId) || !str(v.accountId) || !obj(e) || typeof e.type !== 'string' || !FORWARDED_CHAT.has(e.type)) return null
    if (v.provider !== 'claude' && v.provider !== 'codex') return null
    if (v.transcriptPath !== null && !str(v.transcriptPath)) return null
    if (e.type === 'status' && !str(e.status)) return null
    if (e.type === 'request' && e.request !== null && !obj(e.request)) return null
    if (e.type === 'error' && typeof e.message !== 'string') return null
    if (e.type === 'ready' && (!str(e.threadId) || (e.rolloutPath !== null && !str(e.rolloutPath)))) return null
    return { kind: 'chat', sessionId: v.sessionId, accountId: v.accountId, event: e as unknown as ChatEvent, provider: v.provider, transcriptPath: v.transcriptPath }
  }
  if (v.kind === 'roll-state') {
    const e = v.event
    if (!obj(e) || !str(e.sessionId) || !str(e.state)) return null
    return { kind: 'roll-state', event: e as unknown as RollStateEvent }
  }
  if (v.kind === 'rolled') {
    const i = v.info
    if (!str(v.oldSessionId) || !obj(i) || !str(i.id) || !str(i.accountId) || !str(i.cwd) || typeof i.title !== 'string') return null
    return { kind: 'rolled', oldSessionId: v.oldSessionId, info: i as unknown as SessionInfo, ...(str(v.dest) ? { dest: v.dest } : {}) }
  }
  return null
}

/** The notifier inputs a forwarded event came from. */
export interface ForwardedHearer {
  onChatEvent(sessionId: string, event: ChatEvent, at: { provider: Provider; transcriptPath: () => string | null }): void
  onRolled(oldSessionId: string, info: SessionInfo): void
  onRollState(event: RollStateEvent): void
}

/** Tells a forwarded event to a notifier as if it had heard it itself: an app that held forwards while the
 *  Host was away, and then took Slack, tells them to its own notifier (final review M2). */
export function hearForwarded(n: ForwardedHearer, ev: SlackForwardedEvent): void {
  if (ev.kind === 'chat') {
    const p = ev.transcriptPath
    return n.onChatEvent(ev.sessionId, ev.event, { provider: ev.provider, transcriptPath: () => p })
  }
  if (ev.kind === 'rolled') return n.onRolled(ev.oldSessionId, ev.info)
  n.onRollState(ev.event)
}
