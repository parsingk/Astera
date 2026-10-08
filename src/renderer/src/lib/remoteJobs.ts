// The pure half of the Jobs view on a remote Runtime (remote runtime design Phase 6): what its two selectors offer, and
// what an unreachable Runtime says. A Runtime that cannot be reached shows what it last showed and says its Jobs may
// still be running: a network loss never fails a Job (§1.2), so the screen must not say so either.
import type { OrchSnapshot, RuntimeView } from '../../../core/types'
import { findRun } from '../../../core/orchestration/snapshot'

/** The runtime selector's value for this computer's own Host. */
export const LOCAL = 'local'

type T = (key: never, params?: Record<string, string | number>) => string
const tt = (t: T) => t as (k: string, p?: Record<string, string | number>) => string

export const isRemoteRuntime = (runtimeId: string): boolean => runtimeId !== LOCAL

/** A Runtime that did not answer the last time this app asked it is marked in the choice (review minor). */
export function runtimeOptions(paired: Array<{ runtimeId: string; name: string; offline?: boolean | null }>, t: T): Array<{ value: string; label: string }> {
  return [
    { value: LOCAL, label: tt(t)('jobs.runtime.local') },
    ...paired.map((r) => ({ value: r.runtimeId, label: r.offline === true ? tt(t)('jobs.runtime.optionOffline', { name: r.name }) : r.name }))
  ]
}

/** Whether the remote list may be asked: the view is open, a paired Runtime is chosen, and the project is that
 *  Runtime's own. In the commit that switches Runtimes the project is still the last one's (review minor). */
export function remotePollReady(a: { open: boolean; runtimeId: string; project: string | null; projectFor: string | null }): boolean {
  return a.open && isRemoteRuntime(a.runtimeId) && a.project !== null && a.projectFor === a.runtimeId
}

/** What a remote detail is asked again on: its own row and whether the Runtime answers, not every poll's new
 *  snapshot (review minor: each poll asked the Runtime's whole state and timeline again). */
export function remoteDetailKey(snapshot: OrchSnapshot | null, runId: string): string {
  if (snapshot === null) return 'none'
  return JSON.stringify([findRun(snapshot, runId) ?? null, snapshot.runtime?.offline ?? false])
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

/** The folder a new Job on a paired Runtime is made in: its project's own path there. null for "Unregistered folders"
 *  (no folder to make one in) or a project it does not list (Phase 7). Never a path on this computer. */
export function remoteNewJobFolder(projects: Array<{ id: string; path: string | null }> | null, projectKey: string | null): string | null {
  return projects?.find((p) => p.id === projectKey && p.id !== 'unregistered')?.path ?? null
}

/** Why control is off on a paired Runtime: a read-only pairing, or a level this app does not know (the Runtime
 *  reads that as read only too, controllerGate). null when the pairing is full-control (Phase 7). */
export function controlReason(permission: string | undefined, t: T): string | null {
  return permission === 'full-control' ? null : tt(t)('jobs.runtime.readOnlyReason')
}
