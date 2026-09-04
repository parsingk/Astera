// The two decisions the toolbar's configuration menu makes, as pure functions — the component that
// draws the menu cannot be rendered under vitest's environment: 'node', so they live here.
//
// Both read the project's runs. That is deliberate and is what Recent means here: the configurations
// whose runs the panel still holds. A remembered list would carry entries with no run to describe,
// and every row in this menu describes one.
import type { RunStatus } from './config'

/** The Recent group: the configurations the project's runs name, newest started first, each once
 *  however many runs it has, capped at `limit`. */
export function recentConfigIds(runs: readonly RunStatus[], limit: number): string[] {
  const newest = new Map<string, number>()
  for (const r of runs) {
    const seen = newest.get(r.configId)
    if (seen === undefined || r.startedAt > seen) newest.set(r.configId, r.startedAt)
  }
  return [...newest]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([configId]) => configId)
}

export type RowStatus =
  | { kind: 'running'; count: number }
  | { kind: 'exited'; run: RunStatus }

/** One row's right-hand status, and the pill's dot and count.
 *
 *  A live run wins over a finished one: a configuration with a server up and an old failure reads
 *  "1 running", not the failure. 'stopping' counts as live — it is still the user's process, and the
 *  same rule decideStart applies. `null` when the configuration has no runs at all. */
export function configRowStatus(runs: readonly RunStatus[], configId: string): RowStatus | null {
  const mine = runs.filter((r) => r.configId === configId)
  if (mine.length === 0) return null
  const live = mine.filter((r) => r.status !== 'exited')
  if (live.length > 0) return { kind: 'running', count: live.length }
  const newest = mine.reduce((a, b) => (b.startedAt >= a.startedAt ? b : a))
  return { kind: 'exited', run: newest }
}
