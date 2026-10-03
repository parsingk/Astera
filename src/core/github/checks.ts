// A pull request's CI checks, the failed log of one Actions run, and its rerun, read through the
// user's gh. Pure over an injected GhRunner; the Host's github-ci and github-ci-rerun commands wrap them.
import { cutTail } from '../orchestration/taskOutput'
import { ghFailureSentence, type GhFailed, type GhRunner } from './gh'

const CHECK_FIELDS = 'name,state,bucket,link,workflow,startedAt,completedAt'

export function prChecksArgs(n: number): string[] {
  return ['pr', 'checks', String(n), '--json', CHECK_FIELDS]
}

export interface CiCheck {
  name: string
  /** Empty for a commit status, which belongs to no workflow. */
  workflow: string
  /** gh's raw state, e.g. SUCCESS, FAILURE, IN_PROGRESS, QUEUED. */
  state: string
  /** gh's fold of state: pass, fail, pending, skipping or cancel. */
  bucket: string
  link: string
  /** The Actions run behind the check; null for a commit status or any other link. */
  runId: number | null
  startedAt: string | null
  completedAt: string | null
}

/** The last characters of a failed run's log kept for a reader. */
export const FAILED_LOG_MAX = 8000

/** gh's exit codes that still come with the full answer on stdout: 1 some check failed, 8 some pending. */
const CHECKS_RESULT_EXIT_CODES = new Set([0, 1, 8])

export function runIdOf(link: string): number | null {
  const m = link.match(/\/actions\/runs\/(\d+)/)
  return m ? Number(m[1]) : null
}

/** gh writes a time that never happened as Go's zero time, not as an empty value. */
function timeOrNull(v: unknown): string | null {
  return typeof v === 'string' && v !== '' && !v.startsWith('0001-01-01') ? v : null
}

/** Parses `gh pr checks --json` output. Null when it is not a JSON array; a malformed row is skipped. */
export function parsePrChecks(stdout: string): CiCheck[] | null {
  let rows: unknown
  try {
    rows = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(rows)) return null
  const checks: CiCheck[] = []
  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    if (
      typeof r.name !== 'string' ||
      typeof r.state !== 'string' ||
      typeof r.bucket !== 'string' ||
      typeof r.link !== 'string'
    )
      continue
    checks.push({
      name: r.name,
      workflow: typeof r.workflow === 'string' ? r.workflow : '',
      state: r.state,
      bucket: r.bucket,
      link: r.link,
      runId: runIdOf(r.link),
      startedAt: timeOrNull(r.startedAt),
      completedAt: timeOrNull(r.completedAt)
    })
  }
  return checks
}

/** The checks of PR `n` in the repository at `cwd`. A failing or pending check is a result, not a
 *  failure: gh exits 1 or 8 for those and still prints the JSON. */
export async function readPrChecks(
  run: GhRunner,
  cwd: string,
  n: number
): Promise<{ ok: true; checks: CiCheck[] } | GhFailed> {
  const r = await run(prChecksArgs(n), cwd)
  if (r.spawnError === undefined && (r.ok || CHECKS_RESULT_EXIT_CODES.has(r.exitCode ?? -1))) {
    const checks = parsePrChecks(r.stdout)
    if (checks !== null) return { ok: true, checks }
    if (/no checks reported/i.test(r.stderr)) return { ok: true, checks: [] }
    if (r.ok) return { ok: false, kind: 'other', message: 'gh pr checks answered with something that is not JSON' }
  }
  return { ok: false, ...ghFailureSentence(r) }
}

/** The tail of the failed jobs' log of Actions run `runId`, cut to whole lines. */
export async function failedLogTail(
  run: GhRunner,
  cwd: string,
  runId: number
): Promise<{ ok: true; text: string; cut: boolean } | GhFailed> {
  const r = await run(['run', 'view', String(runId), '--log-failed'], cwd)
  if (!r.ok) return { ok: false, ...ghFailureSentence(r) }
  return { ok: true, text: cutTail(r.stdout, FAILED_LOG_MAX), cut: r.stdout.length > FAILED_LOG_MAX }
}

/** Reruns the failed jobs of Actions run `runId`. */
export async function rerunFailed(run: GhRunner, cwd: string, runId: number): Promise<{ ok: true } | GhFailed> {
  const r = await run(['run', 'rerun', String(runId), '--failed'], cwd)
  return r.ok ? { ok: true } : { ok: false, ...ghFailureSentence(r) }
}
