// Who acted, on a journal row (Host journal J4). Written by whoever writes the row, never derived from
// the row's content: a row from before v3, or one this build cannot read, reads as unknown (null).
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
