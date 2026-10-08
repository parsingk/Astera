// The pure half of the Jobs view on a remote Runtime (remote runtime design Phase 6): what its two selectors offer, and
// what an unreachable Runtime says. A Runtime that cannot be reached shows what it last showed and says its Jobs may
// still be running: a network loss never fails a Job (§1.2), so the screen must not say so either.
import type { RuntimeView } from '../../../core/types'

/** The runtime selector's value for this computer's own Host. */
export const LOCAL = 'local'

type T = (key: never, params?: Record<string, string | number>) => string
const tt = (t: T) => t as (k: string, p?: Record<string, string | number>) => string

export const isRemoteRuntime = (runtimeId: string): boolean => runtimeId !== LOCAL

export function runtimeOptions(paired: Array<{ runtimeId: string; name: string }>, t: T): Array<{ value: string; label: string }> {
  return [{ value: LOCAL, label: tt(t)('jobs.runtime.local') }, ...paired.map((r) => ({ value: r.runtimeId, label: r.name }))]
}

export function projectOptions(projects: Array<{ id: string; name: string | null; path: string | null }>, t: T): Array<{ value: string; label: string }> {
  return projects.map((p) => ({ value: p.id, label: p.id === 'unregistered' ? tt(t)('jobs.runtime.unregistered') : (p.name ?? p.path ?? p.id) }))
}

/** The line over an unreachable Runtime's Jobs, or null while it answers. */
export function offlineNote(view: RuntimeView | undefined, name: string, lastSeenAt: string | null, t: T, when: (iso: string) => string): string | null {
  if (!view?.offline) return null
  const head = tt(t)('jobs.runtime.offline', { name })
  return lastSeenAt ? `${head} ${tt(t)('jobs.runtime.lastSeen', { at: when(lastSeenAt) })}` : head
}
