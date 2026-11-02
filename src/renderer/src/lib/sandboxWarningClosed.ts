/** The sessions whose sandbox warning line the person closed (Task E fix round 3, SandboxWarningLine.tsx). The line is
 *  drawn above a terminal, which stays mounted for its tab's life, and above a chat's thread, whose pane mounts only
 *  while it shows, so whether it is closed lives here rather than in either: closed stays closed for that session
 *  across a tab switch, a move to another pane and an app restart (a session the Host keeps comes back under its own
 *  id). Same module-singleton shape as hiddenProjects.ts (Set<listener> + emit), kept in localStorage. Only the most
 *  recent CLOSED_KEPT sessions are kept, so the list does not grow for the life of the install: an older session's line
 *  shows again only if that session is still open by then. */

const KEY = 'cm.sandboxWarningClosed'
/** How many closed sessions are remembered. */
export const CLOSED_KEPT = 200
const listeners = new Set<() => void>()
let cache: string[] | null = null

function read(): string[] {
  if (cache) return cache
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    // A non-array (a hand-edited value, or another shape) is as unusable as broken JSON
    cache = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
  } catch {
    cache = [] // corrupt JSON or no storage: this is a display preference, so starting with every line shown beats throwing
  }
  return cache
}

export function isClosed(sessionId: string): boolean {
  return read().includes(sessionId)
}

export function close(sessionId: string): void {
  const cur = read()
  if (cur.includes(sessionId)) return // no write, and therefore no notification
  const next = [...cur, sessionId].slice(-CLOSED_KEPT)
  cache = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Quota exceeded or storage disabled: the line stays closed for the rest of this run, and shows again after a restart
  }
  for (const listener of listeners) listener()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
