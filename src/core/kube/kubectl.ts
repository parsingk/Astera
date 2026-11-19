import { execFile, type ChildProcess } from 'node:child_process'
import { killProcessTree } from '../run/kill'
import { windowsExecutable } from '../sessions/windowsExecutable'

export interface KubectlResult {
  ok: boolean
  /** Untrimmed: YAML and JSON output is meaningful as printed. */
  stdout: string
  stderr: string
  /** Set only when kubectl ran and exited non-zero (`kubectl diff` exits 1 when there are differences). */
  exitCode?: number
  /** Set only when kubectl ran past its deadline and was killed: it did not answer. */
  timedOut?: true
  /** Set only when the call was stopped by its AbortSignal. */
  cancelled?: true
  /** Set only when kubectl could not be started (ENOENT when the binary is missing) or its output passed the limit. */
  errorCode?: string
}

/** Room for an exec auth plugin to fetch its first token. */
export const KUBECTL_TIMEOUT_MS = 120_000
export const KUBECTL_MAX_BUFFER_BYTES = 64 * 1024 * 1024

/** A spawn refused by Windows under load (EPERM/EBUSY); nothing started, so one retry is safe. */
const SPAWN_TRANSIENT = new Set(['EPERM', 'EBUSY'])
const RETRY_DELAY_MS = 50
/** After the kill, how long to wait for kubectl itself to exit before answering anyway. */
const KILL_EXIT_WAIT_MS = 5_000

function isTransientSpawnFailure(err: unknown): boolean {
  const e = err as { code?: unknown; killed?: unknown } | null
  return !!e && typeof e.code === 'string' && SPAWN_TRANSIENT.has(e.code) && e.killed !== true
}

/** The kubectl to run: the settings override, else kubectl found on PATH (never in the child's cwd). */
export function kubectlBin(override: string | null): string {
  return override ? override : windowsExecutable('kubectl')
}

/** Runs kubectl with no shell. Never throws: a failure is ok=false. The deadline and the signal kill the
 *  whole process tree (an exec auth plugin is a child that can hang) and answer once kubectl itself has
 *  exited, not when the output pipes close, which a grandchild can hold open for as long as it lives. */
export function runKubectl(
  args: string[],
  opts: { bin: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal; input?: string }
): Promise<KubectlResult> {
  const signal = opts.signal
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
      const stop = (why: 'cancelled' | 'timedOut'): void => {
        if (settled || !child) return
        const c = child
        if (deadline) clearTimeout(deadline)
        signal?.removeEventListener('abort', onAbort)
        killProcessTree(c)
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
        const timer = setTimeout(finish, KILL_EXIT_WAIT_MS)
        if (c.exitCode !== null || c.signalCode !== null) finish()
        else c.once('exit', finish)
      }
      const onAbort = (): void => stop('cancelled')
      try {
        child = execFile(
          opts.bin,
          args,
          { env: opts.env, windowsHide: true, maxBuffer: KUBECTL_MAX_BUFFER_BYTES },
          (err, stdout, stderr) => {
            signal?.removeEventListener('abort', onAbort)
            if (deadline) clearTimeout(deadline)
            if (settled) return
            settled = true
            resolve({ err, stdout: stdout ?? '', stderr: stderr ?? '' })
          }
        )
        // `-f -` reads the objects from stdin until it closes (spec 4.6.1); a retried spawn writes them again.
        if (opts.input !== undefined) child.stdin?.end(opts.input)
        if (!settled) {
          signal?.addEventListener('abort', onAbort, { once: true })
          deadline = setTimeout(() => stop('timedOut'), opts.timeoutMs ?? KUBECTL_TIMEOUT_MS)
        }
      } catch (err) {
        settled = true
        resolve({ err, stdout: '', stderr: err instanceof Error ? err.message : String(err) })
      }
    })
  const shape = (r: Raw): KubectlResult => {
    if (r.cancelled) return { ok: false, stdout: '', stderr: 'cancelled', cancelled: true }
    if (r.timedOut) return { ok: false, stdout: '', stderr: 'timed out', timedOut: true }
    const out: KubectlResult = { ok: !r.err, stdout: r.stdout, stderr: r.stderr.trim() }
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
