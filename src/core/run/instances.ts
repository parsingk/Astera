// The decisions around run instances, as pure functions. RunManager keys runs by runId and does
// not read configurations; the renderer cannot be rendered under vitest's environment: 'node'.
// So the rules both of them need — what ▶ does, which seat a run takes, how rows are labelled —
// live here, where a test reaches them directly.
import type { RunConfig } from './types'
import type { RunStatus } from './config'

const isLive = (r: RunStatus): boolean => r.status !== 'exited'

const latestOf = (runs: RunStatus[]): RunStatus =>
  runs.reduce((a, b) => (b.startedAt >= a.startedAt ? b : a))

/** What ▶ does for `config` given the project's current runs. Restart when a run of it is live and the
 *  switch is off; start otherwise. A stopping run counts as live — a second press during the stopping
 *  window must join that restart, not start a second replacement (RunManager.restart dedupes on the
 *  runId this names). With several live runs — the switch was on, two were started, it was turned off —
 *  the most recently started is the one restarted. A live validation run (RunStatus.validation) is not
 *  a candidate — it is the orchestrator's, and ▶ starts the user's own run beside it. */
export function decideStart(
  runs: RunStatus[],
  config: RunConfig
): { action: 'start' } | { action: 'restart'; runId: string } {
  if (config.allowMultipleInstances) return { action: 'start' }
  // A validation run is the orchestrator's, not the user's — never the one ▶ restarts
  const live = runs.filter((r) => r.configId === config.id && isLive(r) && r.validation !== true)
  if (live.length === 0) return { action: 'start' }
  return { action: 'restart', runId: latestOf(live).runId }
}

/** The seat a new run of `configId` takes in `runs` (one project's list). The earliest finished run of
 *  the same configuration gives up its seat — and is named in `replaces` so the caller drops its
 *  record — so running the tests ten times leaves one row. Otherwise the seat after the highest.
 *  A live run always keeps its seat. */
export function placeNewRun(runs: RunStatus[], configId: string): { seq: number; replaces?: string } {
  const finished = runs
    .filter((r) => r.configId === configId && r.status === 'exited')
    .sort((a, b) => a.seq - b.seq)
  if (finished.length > 0) return { seq: finished[0].seq, replaces: finished[0].runId }
  return { seq: runs.reduce((m, r) => Math.max(m, r.seq), 0) + 1 }
}

/** Row labels in seat order. A configuration that appears once keeps its plain name; repeats are
 *  numbered from the second — "dev", "dev (2)". Grouped by configId, since a configuration can be
 *  renamed between two of its runs. */
export function labelRuns(runs: RunStatus[]): { runId: string; label: string }[] {
  const total = new Map<string, number>()
  for (const r of runs) total.set(r.configId, (total.get(r.configId) ?? 0) + 1)
  const seen = new Map<string, number>()
  return [...runs]
    .sort((a, b) => a.seq - b.seq)
    .map((r) => {
      const nth = (seen.get(r.configId) ?? 0) + 1
      seen.set(r.configId, nth)
      const repeated = (total.get(r.configId) ?? 0) > 1 && nth > 1
      return { runId: r.runId, label: repeated ? `${r.configName} (${nth})` : r.configName }
    })
}

/** The toolbar's two buttons for the selected configuration. ▶ is enabled whenever something is
 *  selected (what it does is decideStart's call). ⏹ targets the most recently started *running* run of
 *  the selection — a stopping one cannot be stopped again, and with the switch on there may be several,
 *  of which the toolbar takes one; the rest have their own ⏹ in the list. */
export function toolbarState(
  runs: RunStatus[],
  selectedConfigId: string | null
): { canRun: boolean; stopTarget?: string } {
  if (!selectedConfigId) return { canRun: false }
  const running = runs.filter((r) => r.configId === selectedConfigId && r.status === 'running')
  if (running.length === 0) return { canRun: true }
  return { canRun: true, stopTarget: latestOf(running).runId }
}

/** The renderer's merge of a run:status event into its list. By runId — and a run arriving on a seat
 *  another run of the same project holds evicts that holder. That is how a restart or placeNewRun's
 *  takeover reaches the screen: main has already dropped the old record, the new run reports on the
 *  same seq, and the seat is unique within a project. No separate "removed" event is needed. */
export function upsertRun(runs: RunStatus[], incoming: RunStatus): RunStatus[] {
  const kept = runs.filter(
    (r) => r.runId !== incoming.runId && !(r.projectPath === incoming.projectPath && r.seq === incoming.seq)
  )
  return [...kept, incoming].sort((a, b) => a.seq - b.seq)
}
