// What an app forwards to the Host so it can record the session events of the sessions only the app sees (plugin
// Phase 3, events and notifications design N3): the status and open request of a chat whose adapter is the app's, and
// the roll states of a chain the app holds, each with the session as the app knows it, since the Host may have no row
// for it. Parsed at the Host's socket, where anything malformed is dropped rather than trusted. Only what the session
// events need crosses: a request is its kind, never its content.
import type { Attention, RollStateEvent } from '../types'

export interface SignalSession {
  id: string
  kind: 'terminal' | 'chat'
  title?: string
  provider?: 'claude' | 'codex'
  cwd?: string
}

export type SessionSignal =
  | {
      kind: 'chat'
      session: SignalSession
      event: { type: 'status'; status: Attention } | { type: 'request'; request: 'approval' | 'question' | null }
    }
  | { kind: 'roll-state'; session: SignalSession; event: RollStateEvent }

const str = (v: unknown): v is string => typeof v === 'string' && v !== ''
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const STATUSES: ReadonlySet<unknown> = new Set(['idle', 'working', 'waiting'])
const ROLL_STATES: ReadonlySet<unknown> = new Set(['switching', 'trust', 'waiting', 'nudged', 'stalled', 'adopted', 'none'])

function sessionOf(v: unknown): SignalSession | null {
  if (!obj(v) || !str(v.id) || (v.kind !== 'terminal' && v.kind !== 'chat')) return null
  for (const k of ['title', 'cwd'] as const) if (v[k] !== undefined && typeof v[k] !== 'string') return null
  if (v.provider !== undefined && v.provider !== 'claude' && v.provider !== 'codex') return null
  return {
    id: v.id,
    kind: v.kind,
    ...(typeof v.title === 'string' ? { title: v.title } : {}),
    ...(v.provider === 'claude' || v.provider === 'codex' ? { provider: v.provider } : {}),
    ...(typeof v.cwd === 'string' ? { cwd: v.cwd } : {})
  }
}

/** A forwarded signal off the wire, or null for anything else. */
export function parseSessionSignal(v: unknown): SessionSignal | null {
  if (!obj(v)) return null
  const session = sessionOf(v.session)
  if (session === null || !obj(v.event)) return null
  const e = v.event
  if (v.kind === 'chat') {
    // A chat's signal names a chat: the Host would otherwise record a chat's waiting as a terminal's (final review m5).
    if (session.kind !== 'chat') return null
    if (e.type === 'status' && STATUSES.has(e.status)) return { kind: 'chat', session, event: { type: 'status', status: e.status as Attention } }
    if (e.type === 'request' && (e.request === null || e.request === 'approval' || e.request === 'question'))
      return { kind: 'chat', session, event: { type: 'request', request: e.request } }
    return null
  }
  if (v.kind === 'roll-state') {
    if (e.sessionId !== session.id || !ROLL_STATES.has(e.state)) return null
    if (e.accountLabel !== undefined && typeof e.accountLabel !== 'string') return null
    if (e.nextRetryAt !== undefined && typeof e.nextRetryAt !== 'string') return null
    if (e.scope !== undefined && e.scope !== 'session' && e.scope !== 'weekly') return null
    if (e.reattach !== undefined && typeof e.reattach !== 'boolean') return null
    if (e.manual !== undefined && typeof e.manual !== 'boolean') return null
    return { kind: 'roll-state', session, event: e as unknown as RollStateEvent }
  }
  return null
}
