import { classifyGhFailure, gh, type GhResult } from '../core/github/gh'
import { git, type GitResult } from '../core/worktrees/git'
import { normalizeBaseForGh } from '../core/worktrees/push'
import { fillFromCommits, type CommitSummary } from '../core/github/fill'

export interface PrCreateRequest {
  worktreePath: string
  repoPath: string
  branch: string
  /** As stored — may be remote-qualified. Normalised before it reaches gh. */
  base: string
  title: string
  body: string
  draft: boolean
  needsPush: boolean
}

/** Mirrors GhFailureKind, plus the two failures unique to this command's own stages: 'rejected'
 *  for a refused push, 'exists' for a race with another client creating the same PR first. A
 *  superset rather than a copy — 'other' must keep meaning "we could not classify this", not
 *  "we classified it and threw the answer away". */
export type PrCreateFailureKind =
  | 'rejected'
  | 'exists'
  | 'rate-limit'
  | 'auth'
  | 'network'
  | 'not-found'
  | 'no-remote'
  | 'truncated'
  | 'other'

export type PrCreateResult =
  | { ok: true; url: string }
  | {
      ok: false
      stage: 'push' | 'create'
      kind: PrCreateFailureKind
      detail: string
      /** Whether the branch reached the remote. A create-stage failure leaves it pushed, and
       *  saying so is what stops someone undoing a push that was fine. */
      pushed: boolean
    }

export interface PrCreateDeps {
  runGit?: (args: string[], cwd: string) => Promise<GitResult>
  runGh?: (args: string[], cwd: string) => Promise<GhResult>
  normalizeBase?: (repo: string, base: string) => Promise<string>
}

/** Pushes when asked, then creates the pull request. Two steps behind one submit, in that order,
 *  and never a force push — a rejection is the person's call to make, not the app's. */
export async function createPullRequest(
  req: PrCreateRequest,
  deps: PrCreateDeps = {}
): Promise<PrCreateResult> {
  const runGit = deps.runGit ?? ((a: string[], cwd: string) => git(a, { cwd }))
  const runGh = deps.runGh ?? ((a: string[], cwd: string) => gh(a, { cwd }))
  const normalize = deps.normalizeBase ?? normalizeBaseForGh

  if (req.needsPush) {
    const pushed = await runGit(['push', '-u', 'origin', req.branch], req.worktreePath)
    if (!pushed.ok)
      return { ok: false, stage: 'push', kind: 'rejected', detail: pushed.stderr, pushed: false }
  }

  const base = await normalize(req.repoPath, req.base)
  const args = ['pr', 'create', '--base', base, '--title', req.title, '--body', req.body]
  if (req.draft) args.push('--draft')

  const created = await runGh(args, req.worktreePath)
  if (created.ok) return { ok: true, url: created.stdout.trim() }

  // gh says "already exists" on stderr with the URL; that is a different next step (open it)
  // from every other failure, so it gets its own kind rather than hiding in 'other'.
  const kind: PrCreateFailureKind = /already exists/i.test(created.stderr)
    ? 'exists'
    : classifyGhFailure(created.stderr, created.spawnError)
  return { ok: false, stage: 'create', kind, detail: created.stderr, pushed: req.needsPush }
}

/** The commits this branch adds over its base, newest first — the order gh --fill uses. */
export async function readCommits(
  worktreePath: string,
  base: string,
  runGit: (args: string[], cwd: string) => Promise<GitResult> = (a, cwd) => git(a, { cwd })
): Promise<CommitSummary[]> {
  // %x00 separates subject from body, %x01 separates commits — neither occurs in a message.
  const r = await runGit(
    ['log', '--format=%s%x00%b%x01', `${base}..HEAD`],
    worktreePath
  )
  if (!r.ok) return []
  return r.stdout
    .split('\u0001')
    .map((c) => c.trim())
    .filter((c) => c !== '')
    .map((c) => {
      const [subject, body = ''] = c.split('\u0000')
      return { subject: subject.trim(), body: body.trim() }
    })
}

export { fillFromCommits }
