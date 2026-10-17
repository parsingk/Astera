// One pull request's state at one moment, read through the user's gh with one GraphQL query (GitHub lifecycle design
// §6.1): its head, base and mergeability, its head commit's check suites, and every check of that commit with whether
// the branch rules require it. One query, so the head and the checks are one snapshot. Pure over an injected GhRunner.
import { ghFailureSentence, type GhFailed, type GhRunner } from './gh'
import type { GitHubCiCheck, GitHubCiConclusion } from './lifecycle'
import { hostnameArgs, type GitHubRepo } from './remote'

export const PR_STATE_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  rateLimit{ limit remaining resetAt }
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      number state isDraft url headRefName headRefOid baseRefName mergeStateStatus reviewDecision
      commits(last:1){ nodes{ commit{ oid
        checkSuites(first:50){ totalCount nodes{ status app{ slug } checkRuns(first:1){ totalCount } } }
        statusCheckRollup{ contexts(first:100){ totalCount nodes{
          __typename
          ... on CheckRun{ databaseId name status conclusion startedAt completedAt detailsUrl isRequired(pullRequestNumber:$number)
            checkSuite{ workflowRun{ databaseId workflow{ name } } } }
          ... on StatusContext{ context state targetUrl createdAt isRequired(pullRequestNumber:$number) }
        } } }
      } } }
    }
  }
}`

export interface PrStateRead {
  number: number
  url: string
  state: 'open' | 'closed' | 'merged'
  isDraft: boolean
  headBranch: string
  /** The PR's head as GitHub has it now. */
  headSha: string
  /** The commit the suites and checks below belong to: the PR's last commit. It equals headSha except in the moment
   *  GitHub is still moving the PR to a new push. */
  commitSha: string
  baseBranch: string
  mergeStateStatus?: string
  reviewDecision?: string
  /** The head commit's check suites that have at least one check run, and whether each is done (design S1). */
  suites: { app: string; completed: boolean }[]
  /** Ordered by name, then externalId, so the same checks read twice compare equal (final review M7). */
  checks: GitHubCiCheck[]
  rateLimit?: { limit: number; remaining: number; resetAt: string }
  /** GitHub could not say for some check whether the branch rules require it (an `isRequired` error): a verdict on
   *  the required checks cannot pass on this read (spec §9). */
  requiredUnknown?: true
  /** More checks or suites than one page holds: unseen ones could be failing, so this read cannot pass (final review
   *  M1). */
  truncated?: true
}

/** The fields an answer may have failed on and still be read: leaves that say nothing about which checks exist or
 *  how they ended. An error anywhere else (the commit, its suites, its rollup) makes the read a failure, never "no
 *  checks" (final review C1). */
const LEAF_ERRORS: ReadonlySet<string> = new Set(['isRequired', 'reviewDecision', 'mergeStateStatus'])

const errorPaths = (root: unknown): unknown[][] => {
  const errors = (root as { errors?: unknown } | null)?.errors
  return Array.isArray(errors) ? errors.map((e) => (Array.isArray((e as { path?: unknown } | null)?.path) ? (e as { path: unknown[] }).path : [])) : []
}

const RUN_STATUS: Record<string, GitHubCiCheck['status']> = {
  QUEUED: 'queued',
  PENDING: 'queued',
  WAITING: 'queued',
  REQUESTED: 'queued',
  IN_PROGRESS: 'in-progress',
  COMPLETED: 'completed'
}

const CONCLUSION: Record<string, GitHubCiConclusion> = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  NEUTRAL: 'neutral',
  CANCELLED: 'cancelled',
  SKIPPED: 'skipped',
  TIMED_OUT: 'timed-out',
  ACTION_REQUIRED: 'action-required',
  STALE: 'stale',
  STARTUP_FAILURE: 'startup-failure'
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)
const nodes = (v: unknown): unknown[] => {
  const n = obj(v)?.nodes
  return Array.isArray(n) ? n : []
}
const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

function checkRunOf(r: Obj): GitHubCiCheck | null {
  if (typeof r.databaseId !== 'number' || typeof r.name !== 'string' || typeof r.status !== 'string') return null
  const check: GitHubCiCheck = {
    externalId: `run:${r.databaseId}`,
    name: r.name,
    status: RUN_STATUS[r.status] ?? 'queued',
    required: r.isRequired === true
  }
  const run = obj(obj(r.checkSuite)?.workflowRun)
  const workflow = text(obj(run?.workflow)?.name)
  if (workflow) check.workflow = workflow
  if (typeof r.conclusion === 'string') check.conclusion = CONCLUSION[r.conclusion] ?? 'unknown'
  const details = text(r.detailsUrl)
  if (details) check.detailsUrl = details
  if (typeof run?.databaseId === 'number') check.ciRunId = run.databaseId
  check.jobId = r.databaseId
  const started = text(r.startedAt)
  if (started) check.startedAt = started
  const completed = text(r.completedAt)
  if (completed) check.completedAt = completed
  return check
}

function statusContextOf(r: Obj): GitHubCiCheck | null {
  if (typeof r.context !== 'string' || typeof r.state !== 'string') return null
  const done = r.state === 'SUCCESS' || r.state === 'FAILURE' || r.state === 'ERROR'
  const check: GitHubCiCheck = {
    externalId: `status:${r.context}`,
    name: r.context,
    status: done ? 'completed' : 'queued',
    required: r.isRequired === true
  }
  // ERROR is a status that could not report; GitHub counts it as failing, and so does this.
  if (done) check.conclusion = r.state === 'SUCCESS' ? 'success' : 'failure'
  const details = text(r.targetUrl)
  if (details) check.detailsUrl = details
  const created = text(r.createdAt)
  if (done && created) check.completedAt = created
  return check
}

function checkOf(raw: unknown): GitHubCiCheck | null {
  const r = obj(raw)
  if (r?.__typename === 'CheckRun') return checkRunOf(r)
  if (r?.__typename === 'StatusContext') return statusContextOf(r)
  return null
}

/** Parses `gh api graphql` with PR_STATE_QUERY. Null when there is no such PR or the answer is not one. An answer that
 *  also carries `errors` (one field GitHub could not resolve) is read for the data it has. */
export function parsePrState(stdout: string): PrStateRead | null {
  let root: unknown
  try {
    root = JSON.parse(stdout)
  } catch {
    return null
  }
  const data = obj(obj(root)?.data)
  const pr = obj(obj(data?.repository)?.pullRequest)
  if (!pr) return null
  const state = pr.state === 'OPEN' ? 'open' : pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : null
  if (
    state === null ||
    typeof pr.number !== 'number' ||
    typeof pr.url !== 'string' ||
    typeof pr.headRefName !== 'string' ||
    typeof pr.headRefOid !== 'string' ||
    typeof pr.baseRefName !== 'string'
  )
    return null
  const commit = obj(obj(nodes(pr.commits)[0])?.commit)
  if (!commit || typeof commit.oid !== 'string') return null
  const suiteNodes = nodes(commit.checkSuites)
  const suites = suiteNodes.flatMap((raw) => {
    const s = obj(raw)
    const runs = obj(s?.checkRuns)?.totalCount
    if (!s || typeof s.status !== 'string' || typeof runs !== 'number' || runs === 0) return []
    return [{ app: text(obj(s.app)?.slug) ?? '', completed: s.status === 'COMPLETED' }]
  })
  const contexts = obj(obj(commit.statusCheckRollup)?.contexts)
  const contextNodes = nodes(contexts)
  const checks = contextNodes
    .flatMap((raw) => {
      const c = checkOf(raw)
      return c ? [c] : []
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.externalId.localeCompare(b.externalId))
  const beyondPage = (total: unknown, seen: number): boolean => typeof total === 'number' && total > seen
  const read: PrStateRead = {
    number: pr.number,
    url: pr.url,
    state,
    isDraft: pr.isDraft === true,
    headBranch: pr.headRefName,
    headSha: pr.headRefOid,
    commitSha: commit.oid,
    baseBranch: pr.baseRefName,
    suites,
    checks
  }
  const mergeState = text(pr.mergeStateStatus)
  if (mergeState) read.mergeStateStatus = mergeState
  const review = text(pr.reviewDecision)
  if (review) read.reviewDecision = review
  const limit = obj(data?.rateLimit)
  if (limit && typeof limit.limit === 'number' && typeof limit.remaining === 'number' && typeof limit.resetAt === 'string')
    read.rateLimit = { limit: limit.limit, remaining: limit.remaining, resetAt: limit.resetAt }
  if (errorPaths(root).some((p) => p.at(-1) === 'isRequired')) read.requiredUnknown = true
  if (beyondPage(obj(commit.checkSuites)?.totalCount, suiteNodes.length) || beyondPage(contexts?.totalCount, contextNodes.length))
    read.truncated = true
  return read
}

/** gh exits 1 whenever the answer carries `errors`, with the data still on stdout (measured, final review C1). Such an
 *  answer is read when every error is on a leaf field (LEAF_ERRORS). */
function usablePartial(stdout: string): boolean {
  let root: unknown
  try {
    root = JSON.parse(stdout)
  } catch {
    return false
  }
  const paths = errorPaths(root)
  return paths.length > 0 && paths.every((p) => LEAF_ERRORS.has(String(p.at(-1))))
}

/** PR `number` of `repo`. The query goes on one line: an argument with line breaks is one more thing a Windows
 *  launcher can split. A missing PR is not-found (ghFailureSentence reads GraphQL's words for it). An answer gh failed
 *  only because a leaf field could not be resolved is read (usablePartial). */
export async function readPrState(
  run: GhRunner,
  cwd: string,
  repo: GitHubRepo,
  number: number
): Promise<{ ok: true; read: PrStateRead } | GhFailed> {
  const r = await run(
    [
      'api',
      'graphql',
      ...hostnameArgs(repo),
      '-f',
      `owner=${repo.owner}`,
      '-f',
      `name=${repo.name}`,
      '-F',
      `number=${number}`,
      '-f',
      `query=${PR_STATE_QUERY.replace(/\s+/g, ' ').trim()}`
    ],
    cwd
  )
  if (!r.ok) {
    const partial = r.spawnError === undefined && usablePartial(r.stdout) ? parsePrState(r.stdout) : null
    return partial ? { ok: true, read: partial } : { ok: false, ...ghFailureSentence(r) }
  }
  const read = parsePrState(r.stdout)
  return read ? { ok: true, read } : { ok: false, kind: 'other', message: 'gh api graphql answered with something that is not a pull request' }
}
