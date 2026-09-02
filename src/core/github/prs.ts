import type { PrChecks, PrInfo, PrState } from './types'

/** The PR window per repository. Branches older than the newest 200 PRs are not found — accepted
 *  in the design doc §3.3; Astera-created worktree branches are recent. */
export const PR_LIST_LIMIT = 200

/** The exact argv the coordinator runs (with cwd = the repository). Exported so tests and the
 *  coordinator cannot drift apart. */
export const PR_LIST_ARGS = [
  'pr',
  'list',
  '--state',
  'all',
  '--limit',
  String(PR_LIST_LIMIT),
  '--json',
  'number,title,state,isDraft,url,headRefName,statusCheckRollup'
]

/** One statusCheckRollup element — a CheckRun (Actions) or a StatusContext (commit status). */
interface RollupItem {
  __typename?: string
  status?: string // CheckRun: QUEUED | IN_PROGRESS | COMPLETED
  conclusion?: string | null // CheckRun, set when COMPLETED
  state?: string // StatusContext: SUCCESS | FAILURE | ERROR | PENDING | EXPECTED
}

const FAILING_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])

/** Folds a rollup to one value: any failure wins, then any pending, then passing; no checks → null. */
function foldChecks(rollup: unknown): PrChecks {
  if (!Array.isArray(rollup) || rollup.length === 0) return null
  let pending = false
  for (const raw of rollup as RollupItem[]) {
    if (raw === null || typeof raw !== 'object') continue
    if (typeof raw.state === 'string') {
      // StatusContext
      if (raw.state === 'FAILURE' || raw.state === 'ERROR') return 'failing'
      if (raw.state === 'PENDING' || raw.state === 'EXPECTED') pending = true
      continue
    }
    // CheckRun
    if (raw.status !== 'COMPLETED') {
      pending = true
      continue
    }
    if (typeof raw.conclusion === 'string' && FAILING_CONCLUSIONS.has(raw.conclusion)) return 'failing'
  }
  return pending ? 'pending' : 'passing'
}

function readState(v: unknown): PrState | null {
  if (v === 'OPEN') return 'open'
  if (v === 'MERGED') return 'merged'
  if (v === 'CLOSED') return 'closed'
  return null
}

/** Parses `gh pr list --json` output into a head-branch → PR map. One PR per branch: an open PR
 *  wins; otherwise the first listed (gh returns newest first). Returns null when the output is
 *  not JSON at all — the caller treats that as a failed fetch, never as an empty repo. */
export function parsePrList(stdout: string): Record<string, PrInfo> | null {
  let rows: unknown
  try {
    rows = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(rows)) return null
  const byBranch: Record<string, PrInfo> = {}
  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const state = readState(r.state)
    if (
      typeof r.number !== 'number' ||
      typeof r.title !== 'string' ||
      typeof r.url !== 'string' ||
      typeof r.headRefName !== 'string' ||
      state === null
    )
      continue // one malformed row must not sink the repo
    const existing = byBranch[r.headRefName]
    if (existing && (existing.state === 'open' || state !== 'open')) continue
    byBranch[r.headRefName] = {
      number: r.number,
      title: r.title,
      state,
      isDraft: r.isDraft === true,
      url: r.url,
      checks: foldChecks(r.statusCheckRollup)
    }
  }
  return byBranch
}
