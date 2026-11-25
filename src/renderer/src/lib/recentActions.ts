// The actions a person ran from the command palette lately, most recent first, so the palette can offer them first.
// A convenience for this window only: kept in localStorage like the other cm.* keys, and forgotten rather than
// thrown when storage is off or full.

import type { RegistryId } from './actionRegistry'

const KEY = 'cm.recentActions'
const MAX = 8

export function readRecentActions(known: readonly RegistryId[]): RegistryId[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    // A core action this version does not know (one that was removed) is dropped. A plugin's command (a contribution
    // key, the one id with a colon) is kept whether or not it is listed now: the Host's list may not have arrived, or
    // its plugin may be off for a while; a row is ranked only while it is listed, and a gone one ages out of the eight.
    return parsed
      .filter((id): id is RegistryId => typeof id === 'string' && (known.includes(id as RegistryId) || id.includes(':')))
      .slice(0, MAX)
  } catch {
    return []
  }
}

export function rememberAction(id: RegistryId, known: readonly RegistryId[]): void {
  const next = [id, ...readRecentActions(known).filter((x) => x !== id)].slice(0, MAX)
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Storage off or full: the palette simply has no recent list next time.
  }
}
