// Who acted, on a journal row (Host journal J4). Written by whoever writes the row, never derived from
// the row's content: a row from before v3, or one this build cannot read, reads as unknown (null).
import { APP_CALLER, HOST_CALLER } from '../host/driver'
import type { OrchState } from '../orchestration/state'

export type JournalSurface = 'desktop' | 'cli' | 'agent' | 'host'

/** Who acted, on every journal row written since v3 (Host journal J4). */
export interface JournalActor {
  surface: JournalSurface
  sessionId?: string
}

const SURFACES: ReadonlySet<string> = new Set<JournalSurface>(['desktop', 'cli', 'agent', 'host'])

export function isJournalActor(v: unknown): v is JournalActor {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  if (typeof o.surface !== 'string' || !SURFACES.has(o.surface)) return false
  return o.sessionId === undefined || typeof o.sessionId === 'string'
}

/** `actor_json` as read: null for a v2 row, or for a value this build cannot read (P4). */
export function actorFromJson(text: string | null | undefined): JournalActor | null {
  if (text === null || text === undefined) return null
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (!isJournalActor(v)) return null
  return v.sessionId === undefined ? { surface: v.surface } : { surface: v.surface, sessionId: v.sessionId }
}

/** The Host itself: its load cleanup, its timers, its own dispatch and the prompts it types (P5). */
export const HOST_ACTOR: JournalActor = { surface: 'host' }
/** The app: its buttons, its `state-put` and every row it sends through `journal-append` (P5). */
export const DESKTOP_ACTOR: JournalActor = { surface: 'desktop' }

/** Who made a call (P5), judged on the state the call found, before it committed: a worker's report
 *  that closes its own Dispatch is still the agent's. A caller whose hello said `role: 'app'` is the
 *  desktop; a session naming an open Dispatch or a Run's coordinator is an agent; anything else is the
 *  CLI, with its session when it has one.
 *
 *  **The reserved caller ids name nobody here** (final review M1). Any shell or agent can send
 *  HOST_CALLER or APP_CALLER, so they count only when the Host itself or the app's own connection sets
 *  them: the Host's own commands carry HOST_ACTOR without being judged here, and the app is known by its
 *  role. Anyone else claiming one is the CLI. */
export function actorOf(a: { sessionId: string; role?: 'app' | 'cli'; state: OrchState | null }): JournalActor {
  if (a.role === 'app') return DESKTOP_ACTOR
  if (a.sessionId === '') return { surface: 'cli' }
  if (a.sessionId === HOST_CALLER || a.sessionId === APP_CALLER) return { surface: 'cli', sessionId: a.sessionId }
  const st = a.state
  const isAgent =
    st !== null &&
    (st.dispatches.some((d) => !d.endedAt && d.sessionId === a.sessionId) ||
      st.runs.some((r) => r.coordinatorSessionId === a.sessionId))
  return { surface: isAgent ? 'agent' : 'cli', sessionId: a.sessionId }
}

/** The key suffix of a Host commit's repeatable rows (P1): the Host's life and its commit version, so
 *  the same version after a restart is a new row and the same commit recorded twice is not. The load's
 *  cleanup passes `'load'`. */
export function commitStamp(hostStartedAt: string, version: number | 'load'): string {
  return `${hostStartedAt}#${version}`
}
