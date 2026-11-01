// stale-runtime (lifecycle design §4.7): a paired Remote Runtime this machine has not reached in more than 30 days, or
// has never reached in the more than 30 days since it was paired. The advice is to remove the pairing; nothing here
// removes it (§1). runtime-missing-extension and outdated-runtime (remote governance design §9.2, §9.3): what the
// registry kept of a Runtime against this computer, advice only, never an install or an update.
import type { MessageKey, MessageParams } from '../../i18n'
import type { RuntimeProfile } from '../../runtimes/registry'
import type { ReportExtension } from '../../controlPlane/report'
import { compareExtensions, liveExpected, type ComparisonState } from '../../controlPlane/compare'
import { runtimeIsOlder } from '../../controlPlane/detail'
import type { FindingInputs } from '../compute'
import { DAY_MS, ageDays } from '../history'
import { finding, infoLine } from '../make'
import type { Finding, FindingSubject, InfoLine } from '../types'

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

/** Each comparison state's reason (remote governance design §6.2, §9.2). */
const STATE_KEYS: Record<Exclude<ComparisonState, 'same'>, MessageKey> = {
  missing: 'findings.reason.runtimeExtension.missing',
  different: 'findings.reason.runtimeExtension.different',
  off: 'findings.reason.runtimeExtension.off',
  'secret-missing': 'findings.reason.runtimeExtension.secretMissing'
}

const subjectOf = (r: RuntimeProfile): FindingSubject => ({ kind: 'runtime', id: r.runtimeId, name: r.name })

/** The kept snapshot's list, or null when there is none to judge by: no snapshot yet, or one whose Runtime could not
 *  read its registry (ruling R9-3), which is not "nothing installed". */
const keptList = (r: RuntimeProfile): ReportExtension[] | null => r.snapshot?.report.extensions ?? null

/**
 * runtime-missing-extension (§9.2): one finding per Runtime and expected id whose state in the kept snapshot is missing,
 * different, off or secret missing. Read from the registry alone: the Runtime is never asked, so the finding says the
 * snapshot's time. An expected id this computer no longer has drops out (§6.1).
 */
export function runtimeExtensionFindings(i: FindingInputs): Finding[] {
  if (i.runtimes === undefined || i.localExtensions === undefined) return []
  const out: Finding[] = []
  for (const r of i.runtimes) {
    const expected = liveExpected(r.expected, i.localExtensions)
    if (expected.length === 0 || r.snapshot === undefined || keptList(r) === null) continue
    const at = r.snapshot.readAt
    for (const row of compareExtensions({ local: i.localExtensions, report: r.snapshot.report, expected })) {
      if (row.state === null || row.state === 'same') continue
      // Names only: the secret's value never left either computer (§5.3)
      const thereNames = row.there?.secretNames ?? []
      const params: MessageParams =
        row.state === 'secret-missing'
          ? { extension: row.name, names: (row.here?.secretNames ?? []).filter((n) => !thereNames.includes(n)).join(', '), at }
          : { extension: row.name, at }
      out.push(
        finding({
          rule: 'runtime-missing-extension',
          subject: subjectOf(r),
          part: row.id,
          message: { key: STATE_KEYS[row.state], params },
          suggestion: { key: 'findings.do.fixOnRuntime', params: { runtime: r.name } },
          open: { kind: 'runtimes', runtimeId: r.runtimeId }
        })
      )
    }
  }
  return out
}

/** §9.2: a Runtime expected to hold something, with no list kept to judge it by, says so once rather than raise a guess. */
export function runtimeExtensionInfo(i: FindingInputs): InfoLine[] {
  if (i.runtimes === undefined || i.localExtensions === undefined) return []
  const local = i.localExtensions
  return i.runtimes
    .filter((r) => liveExpected(r.expected, local).length > 0 && keptList(r) === null)
    .map((r) => infoLine(subjectOf(r), { key: 'findings.info.runtimeNotRead' }))
}

/** outdated-runtime (§9.3): a Runtime whose hello said an older Astera than this one. A newer one is shown in its detail,
 *  never flagged. */
export function outdatedRuntimeFindings(i: FindingInputs): Finding[] {
  const here = i.asteraVersion
  if (i.runtimes === undefined || here === undefined) return []
  const out: Finding[] = []
  for (const r of i.runtimes) {
    if (r.facts === undefined || !runtimeIsOlder(r.facts.asteraVersion, here)) continue
    out.push(
      finding({
        rule: 'outdated-runtime',
        subject: subjectOf(r),
        message: { key: 'findings.reason.outdatedRuntime', params: { there: r.facts.asteraVersion, here } },
        suggestion: { key: 'findings.do.updateRuntime', params: { runtime: r.name } },
        open: { kind: 'runtimes', runtimeId: r.runtimeId }
      })
    )
  }
  return out
}
