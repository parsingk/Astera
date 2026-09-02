import { execFile } from 'node:child_process'
import type { GhFailureKind, GhProbe } from './types'

export interface GhResult {
  ok: boolean
  stdout: string
  stderr: string
  /** Set when the process could not be spawned, or its output could not be captured in full.
   *  'ENOENT' means gh is not installed; MAX_BUFFER_ERROR_CODE means stdout overflowed
   *  maxBuffer and was truncated — a real (partial) result, not a plain spawn failure. */
  spawnError?: string
}

const DEFAULT_TIMEOUT_MS = 30_000
/** `gh pr list --json ...,statusCheckRollup --limit 200` is the heaviest query this feature
 *  makes. A measured statusCheckRollup element runs ~265 bytes, so the 1 MiB Node default
 *  overflows at roughly 19 checks per PR on average — routine for matrix CI (e.g. 3 OS x 3
 *  versions plus lint/build/e2e). Do not "simplify" this back to the default. */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024
const MAX_BUFFER_ERROR_CODE = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'

/** gh execution adapter — the same shape as git() in ../worktrees/git.ts: no shell (avoids
 *  quoting problems), and a failure does not throw, it returns ok=false. Unlike git(), this
 *  call's heaviest output (see MAX_BUFFER_BYTES above) can exceed Node's 1 MiB default, so the
 *  buffer is sized explicitly rather than inherited. */
export function gh(args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<GhResult> {
  return new Promise((resolve) => {
    execFile(
      'gh',
      args,
      {
        cwd: opts?.cwd,
        timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: MAX_BUFFER_BYTES
      },
      (err, stdout, stderr) => {
        const code = err ? (err as NodeJS.ErrnoException).code : undefined
        resolve({
          ok: !err,
          stdout: (stdout ?? '').trim(),
          stderr: (stderr ?? '').trim(),
          ...(code === 'ENOENT' || code === MAX_BUFFER_ERROR_CODE ? { spawnError: code } : {})
        })
      }
    )
  })
}

/** Sorts a gh failure into the buckets the coordinator and the settings card act on.
 *  Tested against real gh stderr strings — keep new samples in gh.test.ts when one is met
 *  in the wild that lands in the wrong bucket.
 *
 *  `spawnError` is checked first: a maxBuffer overflow leaves stderr empty (see gh.ts's
 *  MAX_BUFFER_BYTES comment), so stderr text alone cannot tell a truncated read apart from any
 *  other silently-retried 'other' failure — it has to be read off the result's spawnError. */
export function classifyGhFailure(stderr: string, spawnError?: string): GhFailureKind {
  if (spawnError === MAX_BUFFER_ERROR_CODE) return 'truncated'
  const s = stderr.toLowerCase()
  if (s.includes('rate limit')) return 'rate-limit'
  if (s.includes('http 401') || s.includes('bad credentials') || s.includes('gh auth login') || s.includes('not logged in'))
    return 'auth'
  if (s.includes('http 404') || s.includes('could not resolve to a repository')) return 'not-found'
  if (s.includes('no git remotes found')) return 'no-remote'
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
