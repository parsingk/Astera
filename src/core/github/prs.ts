import { ghFailureSentence, type GhFailed, type GhRunner } from './gh'
import type { PrChecks, PrInfo, PrState } from './types'
import { ghRepoArg, type GitHubRepo } from './remote'

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

/** A pull request's head commit and state, in `repo` or in the repository at `cwd` (GitHub lifecycle G4): what a CI run
 *  must have run on to be rerun through a Run. An answer that is not one is a failed read. */
export async function prHead(
  run: GhRunner,
  cwd: string,
  n: number,
  repo?: GitHubRepo
): Promise<{ ok: true; headSha: string; state: string } | GhFailed> {
  const r = await run(['pr', 'view', String(n), '--json', 'headRefOid,state', ...(repo ? ['--repo', ghRepoArg(repo)] : [])], cwd)
  if (!r.ok) return { ok: false, ...ghFailureSentence(r) }
  let v: unknown
  try {
    v = JSON.parse(r.stdout)
  } catch {
    v = null
  }
  const o = v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  if (typeof o.headRefOid !== 'string' || typeof o.state !== 'string')
    return { ok: false, kind: 'other', message: `gh pr view ${n} answered with something that is not a pull request` }
  return { ok: true, headSha: o.headRefOid, state: o.state }
}

/** One pull request by its number in `repo` (GitHub lifecycle G3c2): the PR a Run is bound to, read as the list reads a
 *  row. `gh pr view` answers one object; output that is not one PR is a failed read, never "no PR". */
export async function prByNumber(
  run: GhRunner,
  cwd: string,
  repo: GitHubRepo,
  n: number
): Promise<{ ok: true; pr: PrInfo | null; base?: string } | GhFailed> {
  // The base too: runs reconverge binds the base the pull request has now (G6 final review M1)
  const fields = `${PR_LIST_ARGS[PR_LIST_ARGS.length - 1]},baseRefName`
  const r = await run(['pr', 'view', String(n), '--repo', ghRepoArg(repo), '--json', fields], cwd)
  if (!r.ok) return { ok: false, ...ghFailureSentence(r) }
  let one: unknown
  try {
    one = JSON.parse(r.stdout)
  } catch {
    return { ok: false, kind: 'other', message: 'gh pr view answered with something that is not JSON' }
  }
  const rows = parsePrList(JSON.stringify([one]))
  const pr = rows ? Object.values(rows)[0] : undefined
  const base = typeof one === 'object' && one !== null && typeof (one as { baseRefName?: unknown }).baseRefName === 'string' ? (one as { baseRefName: string }).baseRefName : undefined
  return pr ? { ok: true, pr, ...(base !== undefined ? { base } : {}) } : { ok: false, kind: 'other', message: `gh pr view ${n} answered with something that is not a pull request` }
}

/** The PR of one head branch, by the same fold as the coordinator's list: an open PR wins, else the
 *  newest. Five rows is enough to find an open one behind a few closed retries of the same branch. */
export async function prForBranch(
  run: GhRunner,
  cwd: string,
  branch: string
): Promise<{ ok: true; pr: PrInfo | null } | GhFailed> {
  const fields = PR_LIST_ARGS[PR_LIST_ARGS.length - 1]
  const r = await run(['pr', 'list', '--head', branch, '--state', 'all', '--limit', '5', '--json', fields], cwd)
  if (!r.ok) return { ok: false, ...ghFailureSentence(r) }
  const byBranch = parsePrList(r.stdout)
  if (byBranch === null)
    return { ok: false, kind: 'other', message: 'gh pr list answered with something that is not JSON' }
  return { ok: true, pr: byBranch[branch] ?? null }
}
