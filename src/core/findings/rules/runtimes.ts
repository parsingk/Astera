// stale-runtime (lifecycle design §4.7): a paired Remote Runtime this machine has not reached in more than 30 days, or
// has never reached in the more than 30 days since it was paired. The advice is to remove the pairing; nothing here
// removes it (§1).
import type { FindingInputs } from '../compute'
import { DAY_MS, ageDays } from '../history'
import { finding } from '../make'
import type { Finding } from '../types'

/** §4.7: not reached in more than this many days. */
export const STALE_RUNTIME_DAYS = 30

export function staleRuntimeFindings(i: FindingInputs): Finding[] {
  if (i.runtimes === undefined) return []
  const out: Finding[] = []
  for (const r of i.runtimes) {
    const since = r.lastSeenAt ?? r.createdAt
    // More than 30 days, to the millisecond; a time that does not parse is never taken for old
    if (!(i.nowMs - Date.parse(since) > STALE_RUNTIME_DAYS * DAY_MS)) continue
    out.push(
      finding({
        rule: 'stale-runtime',
        subject: { kind: 'runtime', id: r.runtimeId, name: r.name },
        message: {
          key: r.lastSeenAt !== null ? 'findings.reason.staleRuntime' : 'findings.reason.staleRuntimeNever',
          params: { days: ageDays(since, i.nowMs) }
        },
        suggestion: { key: 'findings.do.removePairing' },
        open: { kind: 'runtimes', runtimeId: r.runtimeId }
      })
    )
  }
  return out
}
