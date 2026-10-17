// One GitHub issue read through the user's gh. Pure over an injected GhRunner; the Host's github-issue command and
// the GitHub job source (issueSource.ts) wrap it. A Job made from an issue gets its objective from the job sources'
// one writer (sources/objective.ts).
import { createHash } from 'node:crypto'
import { ghFailureSentence, type GhFailed, type GhRunner } from './gh'

export interface GhIssue {
  number: number
  title: string
  body: string
  state: 'open' | 'closed'
  labels: string[]
  author: string
  /** GitHub's author_association: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE and the like. */
  authorAssociation: string
  url: string
  /** The issues endpoint answers a pull request's number too. */
  isPullRequest: boolean
  /** When GitHub last changed the issue (title, body, labels, ...). */
  updatedAt?: string
}

/** The authors whose issues may become a Job: people the repository already trusts with its code. */
export const ISSUE_JOB_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'] as const


/** Parses `gh api repos/{owner}/{repo}/issues/<n>` output. REST rather than `gh issue view --json`,
 *  which has no author_association. Null when it is not an issue object. */
export function parseIssue(stdout: string): GhIssue | null {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  return issueFrom(raw)
}

/** One issue object as the REST API and its search answer it, or null when it is not one. */
export function issueFrom(raw: unknown): GhIssue | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const user = r.user as Record<string, unknown> | null | undefined
  if (
    typeof r.number !== 'number' ||
    typeof r.title !== 'string' ||
    (r.state !== 'open' && r.state !== 'closed') ||
    typeof user?.login !== 'string' ||
    typeof r.author_association !== 'string' ||
    typeof r.html_url !== 'string'
  )
    return null
  const labels = Array.isArray(r.labels)
    ? r.labels.flatMap((l) => (typeof (l as { name?: unknown } | null)?.name === 'string' ? [l.name as string] : []))
    : []
  return {
    number: r.number,
    title: r.title,
    body: typeof r.body === 'string' ? r.body : '',
    state: r.state,
    labels,
    author: user.login,
    authorAssociation: r.author_association,
    url: r.html_url,
    isPullRequest: r.pull_request !== undefined && r.pull_request !== null,
    ...(typeof r.updated_at === 'string' ? { updatedAt: r.updated_at } : {})
  }
}

/** A Job keeps this of its issue's body (GitHub lifecycle §6): enough to tell a changed body from a label change, and
 *  nothing of the text itself. */
export const issueBodyHash = (body: string): string => createHash('sha256').update(body, 'utf8').digest('hex')

/** Issue `n` of the repository at `cwd`; gh fills `{owner}/{repo}` from that folder's remote. */
export async function readIssue(
  run: GhRunner,
  cwd: string,
  n: number
): Promise<{ ok: true; issue: GhIssue } | GhFailed> {
  const r = await run(['api', 'repos/{owner}/{repo}/issues/' + n], cwd)
  if (!r.ok) return { ok: false, ...ghFailureSentence(r) }
  const issue = parseIssue(r.stdout)
  if (issue === null)
    return { ok: false, kind: 'other', message: 'gh api answered with something that is not an issue' }
  return { ok: true, issue }
}

/** owner/repo from an issue's or pull request's html_url; empty when the URL has no such path. */
export function repoOf(url: string): string {
  const m = url.match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+)/)
  return m ? m[1] : ''
}

// Every terminator a reader of the objective might end a line at, not only \n and \r.
