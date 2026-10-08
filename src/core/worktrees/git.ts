import { execFile, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { BranchRef, RepoProbe } from '../types'
import { killProcessTree } from '../run/kill'
import { cancelledError } from './cancel'
import { defaultCwdProbe, type Probe } from '../sessions/pathProbe'
import { windowsExecutable } from '../sessions/windowsExecutable'

export interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
  /** Set only on a failure that git itself reported: it ran and exited with this non-zero code. Absent
   *  when git answered ok, and absent when it did not answer at all (killed at its deadline, output
   *  over the limit, or never started), so a caller can tell "git said no" from "git said nothing". */
  exitCode?: number
  /** Set only when the call was stopped by its AbortSignal (see git's `signal`). */
  cancelled?: true
  /** Set only when git ran past its deadline and was killed (no exitCode then: git did not answer). */
  timedOut?: true
  /** Set only when git could not be started at all: the spawn's own error code (ENOENT when git is
   *  not on PATH — or when the cwd does not exist, which Node reports the same way). No exitCode then. */
  errorCode?: string
}

const DEFAULT_TIMEOUT_MS = 30_000

/** Output ceiling for one git call. Node's execFile default is 1 MiB, and a big repository passes that
 *  easily (`status --untracked-files=all`, `for-each-ref` over thousands of branches, a diff range after
 *  a large pull) — execFile then fails the call outright, and the callers used to read that failure as
 *  "nothing there". 64 MiB is far past any realistic listing while still bounding a runaway. */
export const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024

/** Deadline for a git call that **changes** the repository (merge, worktree remove, branch delete …).
 *  Killing such a call part-way can leave the repository half-done — a merge with MERGE_HEAD and a
 *  conflicted index, a worktree folder half deleted — which is worse than waiting. So writes get a long
 *  ceiling that only catches a truly hung process, never a slow one; a UI reason is never a reason to
 *  cut one short. */
export const GIT_WRITE_TIMEOUT_MS = 10 * 60 * 1000

/** A failure of the spawn itself, before git ever ran. On Windows, under heavy parallel spawning,
 *  CreateProcess is refused now and then with EPERM (or EBUSY) and works a moment later — the whole
 *  test suite hit it about one run in ten, in whichever test happened to spawn git at that moment.
 *  Nothing was started, so trying once more is safe for every command, writes included. Anything git
 *  itself reports (a non-zero exit) has an exit code and is never retried. */
const SPAWN_TRANSIENT = new Set(['EPERM', 'EBUSY'])
const RETRY_DELAY_MS = 50

function isTransientSpawnFailure(err: unknown): boolean {
  const e = err as { code?: unknown; killed?: unknown } | null
  return !!e && typeof e.code === 'string' && SPAWN_TRANSIENT.has(e.code) && e.killed !== true
}

/** How long an aborted call waits for git itself to exit after the kill. The kill is asynchronous
 *  (taskkill on Windows), and a caller that rolls back right after a cancel should not race a git that
 *  still holds a lock — but a git that will not die is no reason to hang the caller either. */
const ABORT_EXIT_WAIT_MS = 5_000

/** Kills a git child and, on Windows, everything it started (a fetch's remote helper, a hook's shell).
 *  Never throws: the process may be gone already. */
function killGitTree(child: ChildProcess): void {
  killProcessTree(child)
}

/** git execution adapter. No shell (avoids quoting problems); a failure does not throw, it returns ok=false —
 *  including when node's execFile throws synchronously instead of calling back, which it does for some
 *  spawn failures on Windows. A transient spawn failure is retried once (see SPAWN_TRANSIENT).
 *  trim defaults to true — pass false for output where leading whitespace is meaningful, such as porcelain.
 *
 *  `signal`: aborting it kills git (its whole process tree on Windows) and answers ok=false with
 *  `cancelled` set, as soon as git itself has exited — not when its output pipes close, which a
 *  grandchild still holding them can put off for as long as it lives. An already-aborted signal starts
 *  nothing. Callers that pass no signal see no change.
 *
 *  The deadline (`timeoutMs`) ends a call the same way — tree killed, answered at git's exit — with
 *  `timedOut` set and no exitCode. Node's own execFile timeout killed git alone and then waited for
 *  the pipes, so a hook or helper git had started kept both the process and the caller alive. */
export function git(
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number; trim?: boolean; signal?: AbortSignal }
): Promise<GitResult> {
  const signal = opts?.signal
  const cancelledResult = (): GitResult => ({ ok: false, stdout: '', stderr: 'cancelled', cancelled: true })
  type Raw = { err: unknown; stdout: string; stderr: string; cancelled?: true; timedOut?: true }
  const once = (): Promise<Raw> =>
    new Promise((resolve) => {
      if (signal?.aborted) {
        resolve({ err: new Error('cancelled'), stdout: '', stderr: '', cancelled: true })
        return
      }
      let child: ChildProcess | null = null
      let settled = false
      let deadline: ReturnType<typeof setTimeout> | null = null
      /** Cancel and timeout end a call the same way: the tree is killed and the answer goes out once
       *  git itself has exited (or after ABORT_EXIT_WAIT_MS), not when its pipes close. */
      const stop = (why: 'cancelled' | 'timedOut'): void => {
        if (settled || !child) return
        const c = child
        if (deadline) clearTimeout(deadline)
        signal?.removeEventListener('abort', onAbort)
        killGitTree(c)
        const finish = (): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(
            why === 'cancelled'
              ? { err: new Error('cancelled'), stdout: '', stderr: '', cancelled: true }
              : { err: new Error('timed out'), stdout: '', stderr: 'timed out', timedOut: true }
          )
        }
        const timer = setTimeout(finish, ABORT_EXIT_WAIT_MS)
        if (c.exitCode !== null || c.signalCode !== null) finish()
        else c.once('exit', finish)
      }
      const onAbort = (): void => stop('cancelled')
      try {
        // By PATH on win32, not by name: libuv looks a bare name up in the child's cwd first, and the
        // cwd here is a repository (windowsExecutable.ts, security review 2026-09-28)
        child = execFile(
          windowsExecutable('git'),
          args,
          { cwd: opts?.cwd, windowsHide: true, maxBuffer: GIT_MAX_BUFFER_BYTES },
          (err, stdout, stderr) => {
            signal?.removeEventListener('abort', onAbort)
            if (deadline) clearTimeout(deadline)
            if (settled) return
            settled = true
            resolve({ err, stdout: stdout ?? '', stderr: stderr ?? '' })
          }
        )
        if (!settled) {
          signal?.addEventListener('abort', onAbort, { once: true })
          deadline = setTimeout(() => stop('timedOut'), opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS)
        }
      } catch (err) {
        settled = true
        resolve({ err, stdout: '', stderr: err instanceof Error ? err.message : String(err) })
      }
    })
  const shape = (r: Raw): GitResult => {
    if (r.cancelled) return cancelledResult()
    if (r.timedOut) return { ok: false, stdout: '', stderr: 'timed out', timedOut: true }
    const out: GitResult = {
      ok: !r.err,
      stdout: opts?.trim === false ? r.stdout : r.stdout.trim(),
      stderr: r.stderr.trim()
    }
    const e = r.err as { code?: unknown; killed?: unknown } | null
    if (e && typeof e.code === 'number' && e.killed !== true) out.exitCode = e.code
    else if (e && typeof e.code === 'string') out.errorCode = e.code
    return out
  }
  return once().then(async (first) => {
    if (first.cancelled || first.timedOut || !isTransientSpawnFailure(first.err)) return shape(first)
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
    return shape(await once())
  })
}

export async function repoRoot(dir: string): Promise<string | null> {
  const r = await git(['rev-parse', '--show-toplevel'], { cwd: dir })
  return r.ok && r.stdout ? path.resolve(r.stdout) : null
}

/** Deadline for the new-session dialog's repository check. The dialog holds Start while it runs, and on
 *  a UNC share or `\\wsl$` path git can sit for the full 30 s default — a dead button with nothing to
 *  say. Five seconds is far past any local answer; past it, the answer is "unknown", not "no". */
export const REPO_PROBE_TIMEOUT_MS = 5_000

/**
 * `repoRoot` for a person waiting on it: `repo` with the root, `none` when git answered that this is not
 * a repository, and `unknown` when git did not answer in time (or could not be asked). The caller must
 * not read `unknown` as `none` — the folder may well be a repository on a slow share.
 *
 * Answers at the deadline even when git itself will not die (git's own kill waits for the exit), and
 * never rejects.
 *
 * **The folder is probed before git is spawned there** (`probe`, the budgeted session-folder probe of
 * sessions/pathProbe.ts). On Windows, spawning with its cwd on a dead share looks into that folder
 * synchronously on the calling thread, the Electron main thread here, and can hold it for the 20 to
 * 60 s the SMB redirector takes, before any deadline can fire. A probe that times out answers
 * `unknown`/`timeout` and one that finds nothing answers `no-folder`, both without spawning.
 */
export async function probeRepoRoot(
  dir: string,
  run: typeof git = git,
  timeoutMs: number = REPO_PROBE_TIMEOUT_MS,
  folderExists: (dir: string) => Promise<boolean> = (d) =>
    fs.stat(d).then(
      (st) => st.isDirectory(),
      () => false
    ),
  probe: Probe = defaultCwdProbe
): Promise<RepoProbe> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<RepoProbe>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'unknown', reason: 'timeout' }), timeoutMs)
  })
  const asked = (async (): Promise<RepoProbe> => {
    const at = await probe(dir)
    if (at === 'timeout') return { kind: 'unknown', reason: 'timeout' }
    if (at === 'absent') return { kind: 'unknown', reason: 'no-folder' }
    const r = await run(['rev-parse', '--show-toplevel'], { cwd: dir, timeoutMs })
    if (r.ok && r.stdout) return { kind: 'repo', root: path.resolve(r.stdout) }
    // git ran and said no.
    if (r.exitCode !== undefined) return { kind: 'none' }
    if (r.timedOut) return { kind: 'unknown', reason: 'timeout' }
    // git never started. Node says ENOENT both for a git that is not on PATH and for a cwd that does
    // not exist, so the folder is looked at to tell the two apart — the hint says different things.
    if (r.errorCode === 'ENOENT')
      return (await folderExists(dir))
        ? { kind: 'unknown', reason: 'no-git' }
        : { kind: 'unknown', reason: 'no-folder' }
    return { kind: 'unknown', reason: 'error' }
  })().catch((): RepoProbe => ({ kind: 'unknown', reason: 'error' }))
  try {
    return await Promise.race([asked, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
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
 *  configured-but-unreachable remote still has to report a network problem, not silently fall back.
 *
 *  `signal` kills a fetch in flight; the call then throws WORKTREE_CANCELLED instead of answering. */
export async function fetchBaseRef(
  repo: string,
  baseRef: string,
  opts: { signal?: AbortSignal } = {}
): Promise<'fetched' | 'stale' | 'local'> {
  const m = /^([^/]+)\/(.+)$/.exec(baseRef)
  if (!m) return 'local'
  const [, remote, branch] = m
  if (!(await remoteExists(repo, remote))) return 'local'
  const r = await git(
    ['fetch', '--no-tags', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
    { cwd: repo, timeoutMs: FETCH_TIMEOUT_MS, signal: opts.signal }
  )
  if (r.cancelled) throw cancelledError()
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
 * A failure (git error, timeout, output limit) returns **null** — "could not check" — never []. An empty
 * list is a real answer (a repository with no commits yet has no branches), and handing the picker []
 * for a failure made a repository with thousands of branches look like one with none. It still does not
 * throw: the picker is an aid, and not being able to list branches is no reason to block starting a
 * session (the caller falls back to detectBaseRef and says the list is unavailable).
 */
export async function listBranches(repo: string): Promise<BranchRef[] | null> {
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
  if (!r.ok) return null
  if (r.stdout === '') return []
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
  /** Set when git has the worktree locked (`git worktree lock`); a plain remove refuses it. */
  locked?: true
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
    } else if ((line === 'locked' || line.startsWith('locked ')) && current) {
      current.locked = true
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
