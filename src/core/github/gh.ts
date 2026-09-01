import { execFile } from 'node:child_process'
import type { GhFailureKind, GhProbe } from './types'

export interface GhResult {
  ok: boolean
  stdout: string
  stderr: string
  /** Set when the process could not be spawned at all — 'ENOENT' means gh is not installed. */
  spawnError?: string
}

const DEFAULT_TIMEOUT_MS = 30_000

/** gh execution adapter — the same shape as git() in ../worktrees/git.ts: no shell (avoids
 *  quoting problems), and a failure does not throw, it returns ok=false. */
export function gh(args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<GhResult> {
  return new Promise((resolve) => {
    execFile(
      'gh',
      args,
      { cwd: opts?.cwd, timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) =>
        resolve({
          ok: !err,
          stdout: (stdout ?? '').trim(),
          stderr: (stderr ?? '').trim(),
          ...(err && (err as NodeJS.ErrnoException).code === 'ENOENT' ? { spawnError: 'ENOENT' } : {})
        })
    )
  })
}

/** Sorts a gh failure into the buckets the coordinator and the settings card act on.
 *  Tested against real gh stderr strings — keep new samples in gh.test.ts when one is met
 *  in the wild that lands in the wrong bucket. */
export function classifyGhFailure(stderr: string): GhFailureKind {
  const s = stderr.toLowerCase()
  if (s.includes('rate limit')) return 'rate-limit'
  if (s.includes('http 401') || s.includes('bad credentials') || s.includes('gh auth login') || s.includes('not logged in'))
    return 'auth'
  if (s.includes('http 404') || s.includes('could not resolve to a repository')) return 'not-found'
  if (
    s.includes('no such host') ||
    s.includes('dial tcp') ||
    s.includes('connection refused') ||
    s.includes('timeout exceeded') ||
    s.includes('request canceled')
  )
    return 'network'
  return 'other'
}

/** `gh auth status` reader. The runner is injectable so tests never need a real gh; production
 *  callers pass nothing. gh historically writes this output to stderr, so both streams are read. */
export async function probeGh(runner: typeof gh = gh): Promise<GhProbe> {
  const r = await runner(['auth', 'status'])
  if (r.spawnError === 'ENOENT') return { kind: 'not-installed' }
  const out = `${r.stdout}\n${r.stderr}`
  if (r.ok) {
    // Two phrasings across gh versions: "Logged in to <host> account <login> (keyring)"
    // and "Logged in to <host> as <login> (oauth_token)".
    const m = out.match(/Logged in to \S+ (?:account|as) (\S+)/)
    return { kind: 'connected', ...(m ? { account: m[1] } : {}) }
  }
  if (/not logged in|gh auth login/i.test(out)) return { kind: 'not-authenticated' }
  return { kind: 'error' }
}
