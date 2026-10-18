// What CI's verdict on the pushed head makes of a lifecycle round's `github:ci` check (GitHub lifecycle G3b1, design
// §4.6, §4.7): a pass, or a code failure carrying its evidence in the fields the Task's checks already show (summary,
// diagnostics, the log excerpt as the output tail, the details link). A cause outside the code is not the repair
// loop's (§4.6: a rerun or a person, G3b2 and G4), so it makes no result here. Pure.
import type { CheckResult } from '../orchestration/types'
import { GITHUB_CI_CHECK, type CiFailureClass, type CiVerdict, type GitHubCiFailure } from './lifecycle'

/** The classes a repair can answer (§4.6): the code, its tests, build, lint, types, its workflow configuration, and an
 *  unknown cause, which gets one diagnose-first repair (L8). */
const REPAIRABLE: ReadonlySet<CiFailureClass> = new Set(['code', 'test', 'build', 'lint', 'typecheck', 'configuration', 'unknown'])

export function ciCheckResult(a: { verdict: CiVerdict; failure?: GitHubCiFailure; prUrl: string; since: string; now: string }): CheckResult | null {
  const base = { configId: GITHUB_CI_CHECK, name: 'GitHub CI', startedAt: a.since, endedAt: a.now }
  if (a.verdict === 'passed') return { ...base, status: 'passed', externalUrl: a.prUrl }
  if (a.verdict !== 'failed') return null
  const f = a.failure
  if (!f) return { ...base, status: 'failed', summary: 'GitHub CI failed', externalUrl: a.prUrl }
  if (!REPAIRABLE.has(f.class)) return null
  return {
    ...base,
    status: 'failed',
    summary: f.summary,
    ...(f.diagnostics.length > 0
      ? {
          diagnostics: f.diagnostics.map((x) => ({
            ...(x.path ? { file: x.path } : {}),
            ...(x.line !== undefined ? { line: x.line } : {}),
            message: x.message,
            severity: x.warning ? ('warning' as const) : ('error' as const)
          }))
        }
      : {}),
    ...(f.diagnosticsTotal !== undefined ? { diagnosticsTotal: f.diagnosticsTotal } : {}),
    ...(f.logExcerpt ? { outputTail: f.logExcerpt } : {}),
    externalUrl: f.url ?? a.prUrl
  }
}
