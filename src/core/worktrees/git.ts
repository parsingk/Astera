import { execFile } from 'node:child_process'
import path from 'node:path'

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

const FETCH_TIMEOUT_MS = 10_000

/** For a remote-tracking base, fetches precisely that one branch.
 *  Success is fetched / failed but a local ref exists is stale / a local base is local / with neither, FETCH_FAILED. */
export async function fetchBaseRef(repo: string, baseRef: string): Promise<'fetched' | 'stale' | 'local'> {
  const m = /^([^/]+)\/(.+)$/.exec(baseRef)
  if (!m) return 'local'
  const [, remote, branch] = m
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
