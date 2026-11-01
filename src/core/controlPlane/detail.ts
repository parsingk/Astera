// What this computer says of a paired Runtime beside its own state (remote governance design §9.3, §10.1).
import { atLeast, parseCliVersion } from '../sessions/versionCompare'
import type { RuntimeDetail } from '../types'
import type { RuntimeProfile } from '../runtimes/registry'
import type { ReportExtension } from './report'
import { compareExtensions, liveExpected } from './compare'

/** Whether the Runtime's Astera is older than this one's, part by part as numbers. A version either side that does not
 *  read is never taken for older: §9.3 advises, and a guess would advise wrongly. */
export function runtimeIsOlder(there: string, here: string): boolean {
  const a = parseCliVersion(there)
  const b = parseCliVersion(here)
  return a !== null && b !== null && !atLeast(a, b)
}

/** The detail of one paired Runtime from what this computer keeps of it: its profile's facts and last snapshot, and this
 *  computer's extensions (`local`) compared with that snapshot over the expected ids that still exist here (§6.1). Pure:
 *  reading the report and keeping it are the caller's. `local` null: this computer's extensions could not be read, so
 *  nothing is compared (an empty list would call every entry there "only there") and the snapshot still shows. */
export function runtimeDetail(a: {
  profile: RuntimeProfile
  local: readonly ReportExtension[] | null
  here: string
  answering: boolean | null
  refusal?: { code: string; message: string }
}): RuntimeDetail {
  const p = a.profile
  const facts = p.facts ?? null
  const snapshot = p.snapshot ?? null
  return {
    runtimeId: p.runtimeId,
    name: p.name,
    fingerprint: p.fingerprint,
    permission: p.permission,
    createdAt: p.createdAt,
    lastSeenAt: p.lastSeenAt,
    facts,
    here: a.here,
    older: facts !== null && runtimeIsOlder(facts.asteraVersion, a.here),
    answering: a.answering,
    snapshot,
    ...(a.refusal && { refusal: a.refusal }),
    ...(a.local === null && { localError: true as const }),
    comparison: a.local === null ? [] : compareExtensions({ local: a.local, report: snapshot?.report ?? null, expected: liveExpected(p.expected, a.local) })
  }
}
