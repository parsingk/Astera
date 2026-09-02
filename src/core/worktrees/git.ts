import { execFile } from 'node:child_process'
import path from 'node:path'
import type { BranchRef } from '../types'

export interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
}

const DEFAULT_TIMEOUT_MS = 30_000

/** git execution adapter. No shell (avoids quoting problems); a failure does not throw, it returns ok=false.
 *  trim defaults to true — pass false for output where leading whitespace is meaningful, such as porcelain. */
export function git(
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number; trim?: boolean }
): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd: opts?.cwd, timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) =>
        resolve({
          ok: !err,
          stdout: opts?.trim === false ? (stdout ?? '') : (stdout ?? '').trim(),
          stderr: (stderr ?? '').trim()
        })
    )
  })
}

export async function repoRoot(dir: string): Promise<string | null> {
  const r = await git(['rev-parse', '--show-toplevel'], { cwd: dir })
  return r.ok && r.stdout ? path.resolve(r.stdout) : null
}

/** The absolute path of that directory's real git directory. In a linked worktree it returns
 *  <main repo>/.git/worktrees/<name> — that is where index and HEAD live. This keeps a hardcoded
 *  <root>/.git from breaking inside a worktree. */
export async function gitDir(dir: string): Promise<string | null> {
  const r = await git(['rev-parse', '--absolute-git-dir'], { cwd: dir })
  return r.ok && r.stdout ? path.resolve(r.stdout) : null
}

export async function gitUserName(repo: string): Promise<string | null> {
  const r = await git(['config', 'user.name'], { cwd: repo })
  return r.ok && r.stdout ? r.stdout : null
}

const BASE_PROBES = [
  { ref: 'refs/remotes/origin/main', short: 'origin/main' },
  { ref: 'refs/remotes/origin/master', short: 'origin/master' },
  { ref: 'refs/heads/main', short: 'main' },
  { ref: 'refs/heads/master', short: 'master' }
] as const

async function refExists(repo: string, ref: string): Promise<boolean> {
  return (await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repo })).ok
}

/** Base probe: origin/HEAD first (the ref it points at is re-verified), then the fixed order. HEAD is not used. */
export async function detectBaseRef(repo: string): Promise<string | null> {
  const head = await git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { cwd: repo })
  const prefix = 'refs/remotes/'
  if (head.ok && head.stdout.startsWith(prefix) && (await refExists(repo, head.stdout)))
    return head.stdout.slice(prefix.length)
  for (const probe of BASE_PROBES) {
    if (await refExists(repo, probe.ref)) return probe.short
  }
  return null
}

/** Promotes a short name to a full ref with no tag ambiguity, and verifies that it exists */
export async function toFullRef(repo: string, baseRef: string): Promise<string | null> {
  const candidates = baseRef.includes('/')
    ? [`refs/remotes/${baseRef}`, `refs/heads/${baseRef}`]
    : [`refs/heads/${baseRef}`]
  for (const ref of candidates) {
    if (await refExists(repo, ref)) return ref
  }
  return null
}

/** Whether that name is a configured remote. `git remote` lists one per line.
 *  Exported because the PR base normaliser needs the same rule: remote-ness is decided by the
 *  remote list, never by the name's shape. */
export async function remoteExists(repo: string, name: string): Promise<boolean> {
  const r = await git(['remote'], { cwd: repo })
  if (!r.ok) return false
  return r.stdout.split('\n').some((line) => line.trim() === name)
}

const FETCH_TIMEOUT_MS = 10_000

/** For a remote-tracking base, fetches precisely that one branch.
 *  Success is fetched / failed but a local ref exists is stale / a local base is local / with neither, FETCH_FAILED.
 *
 *  Remote-ness is decided by whether the first segment names a configured remote, not by the name's shape.
 *  A local branch can contain a slash too ('parsingk/maple' looks exactly like 'origin/main'), and
 *  splitting on shape alone sent it to `git fetch parsingk refs/heads/maple` — no such remote, so it threw
 *  FETCH_FAILED and took worktree creation down with it. Unreachable while detectBaseRef was the only
 *  source (it yields origin/* or main/master), but the base-branch picker lets the user choose one.
 *  Checking the remote list rather than refs/remotes/<baseRef> keeps the FETCH_FAILED case intact: a
 *  configured-but-unreachable remote still has to report a network problem, not silently fall back. */
export async function fetchBaseRef(repo: string, baseRef: string): Promise<'fetched' | 'stale' | 'local'> {
  const m = /^([^/]+)\/(.+)$/.exec(baseRef)
  if (!m) return 'local'
  const [, remote, branch] = m
  if (!(await remoteExists(repo, remote))) return 'local'
  const r = await git(
    ['fetch', '--no-tags', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
    { cwd: repo, timeoutMs: FETCH_TIMEOUT_MS }
  )
  if (r.ok) return 'fetched'
  if (await refExists(repo, `refs/remotes/${baseRef}`)) return 'stale'
  throw new Error(`FETCH_FAILED: could not refresh ${baseRef} from the remote — check the network (${r.stderr})`)
}

export async function localBranchExists(repo: string, branch: string): Promise<boolean> {
  return (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo })).ok
}

export async function isCleanWorktree(
  worktreePath: string
): Promise<{ clean: boolean; changedCount: number }> {
  const r = await git(['status', '--porcelain', '--untracked-files=all'], { cwd: worktreePath })
  if (!r.ok) throw new Error(`GIT_REMOVE_FAILED: status check failed (${r.stderr})`)
  const lines = r.stdout === '' ? [] : r.stdout.split('\n')
  return { clean: lines.length === 0, changedCount: lines.length }
}

/**
 * Local and remote-tracking branches in one pass, newest commit first.
 *
 * for-each-ref does the sorting, so no ordering happens here — alphabetical would bury the branch the user
 * actually wants under stale ones. It also takes both ref namespaces in a single call, which keeps this to
 * two git invocations total (the second one resolves HEAD).
 *
 * refs/remotes/<remote>/HEAD is dropped: it is a symref pointing at the default branch, not a branch of its
 * own, and offering it would let someone create a worktree based on the literal name 'origin/HEAD'.
 *
 * A failure returns [] rather than throwing — the picker is an aid, and not being able to list branches is
 * no reason to block starting a session (the caller falls back to detectBaseRef).
 */
export async function listBranches(repo: string): Promise<BranchRef[]> {
  const r = await git(
    [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname)\t%(committerdate:iso8601)',
      'refs/heads',
      'refs/remotes'
    ],
    { cwd: repo }
  )
  if (!r.ok || r.stdout === '') return []
  // Empty on a detached HEAD, which is why no branch comes back marked current there
  const head = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: repo })
  const current = head.ok ? head.stdout : null

  const rows: BranchRef[] = []
  for (const line of r.stdout.split('\n')) {
    const [refname, date] = line.split('\t')
    if (!refname) continue
    const remote = refname.startsWith('refs/remotes/')
    const name = remote
      ? refname.slice('refs/remotes/'.length)
      : refname.slice('refs/heads/'.length)
    if (remote && name.endsWith('/HEAD')) continue
    rows.push({ name, remote, current: !remote && name === current, updatedAt: (date ?? '').trim() })
  }
  return rows
}

export interface GitWorktreeRow {
  path: string
  branch: string | null // short name with refs/heads/ stripped, null when detached
}

export async function listGitWorktrees(repo: string): Promise<GitWorktreeRow[]> {
  const r = await git(['worktree', 'list', '--porcelain'], { cwd: repo })
  if (!r.ok) throw new Error(`GIT_REMOVE_FAILED: worktree listing failed (${r.stderr})`)
  const rows: GitWorktreeRow[] = []
  let current: GitWorktreeRow | null = null
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) rows.push(current)
      current = { path: line.slice('worktree '.length), branch: null }
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    }
  }
  if (current) rows.push(current)
  return rows
}

export async function gitVersionAtLeast(major: number, minor: number): Promise<boolean> {
  const r = await git(['--version'])
  const m = /(\d+)\.(\d+)/.exec(r.stdout)
  if (!r.ok || !m) return false
  const [, mj, mn] = m
  return Number(mj) > major || (Number(mj) === major && Number(mn) >= minor)
}
