import type { RunStatus } from './config'

/** How long a run has been going, or took. A running run reads `mm:ss` (`h:mm:ss` past an hour) —
 *  it is redrawn once a second, so tenths would only flicker. A finished run shows its total, and
 *  under a minute that total carries tenths (`4.2s`): a test suite's time is read at that precision.
 *  `now` is the caller's clock (BottomPanel ticks one for the whole panel); a finished run ignores it. */
export function formatRunDuration(run: Pick<RunStatus, 'startedAt' | 'exitedAt'>, now: number): string {
  const ms = Math.max(0, (run.exitedAt ?? now) - run.startedAt)
  const finished = run.exitedAt !== undefined
  if (finished && ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
