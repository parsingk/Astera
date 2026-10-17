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
        checkSuites(first:50){ nodes{ status app{ slug } checkRuns(first:1){ totalCount } } }
        statusCheckRollup{ contexts(first:100){ nodes{
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
  checks: GitHubCiCheck[]
  rateLimit?: { limit: number; remaining: number; resetAt: string }
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
  const suites = nodes(commit.checkSuites).flatMap((raw) => {
    const s = obj(raw)
    const runs = obj(s?.checkRuns)?.totalCount
    if (!s || typeof s.status !== 'string' || typeof runs !== 'number' || runs === 0) return []
    return [{ app: text(obj(s.app)?.slug) ?? '', completed: s.status === 'COMPLETED' }]
  })
  const checks = nodes(obj(commit.statusCheckRollup)?.contexts).flatMap((raw) => {
    const c = checkOf(raw)
    return c ? [c] : []
  })
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
  return read
}

/** PR `number` of `repo`. The query goes on one line: an argument with line breaks is one more thing a Windows
 *  launcher can split. A missing PR is not-found (ghFailureSentence reads GraphQL's words for it). */
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
  if (!r.ok) return { ok: false, ...ghFailureSentence(r) }
  const read = parsePrState(r.stdout)
  return read ? { ok: true, read } : { ok: false, kind: 'other', message: 'gh api graphql answered with something that is not a pull request' }
}
