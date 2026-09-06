// Runs an agent's script with the helpers as its whole world.
//
// `vm` is not a security boundary. A determined script can climb out of a vm context, and this code
// does not pretend otherwise. The threat model here is a mistaken script written by the user's own
// agent, against the user's own dev server, inside the user's own app — what `vm` does give is a
// clean global scope (no `require`, no `process`, no `fetch`), so a script that reaches for one of
// them gets `undefined` and a clear error rather than the app's Node environment.
import vm from 'node:vm'
import { Interrupted, SCRIPT_TIMEOUT_MS, shapeError, type LogSink, type RunResult } from './script'

/** Shared between the runner and the helpers: the helper that is running right now. Each helper
 *  sets it before its first `await`; when the script fails, this is the `at` the agent reads. */
export interface RunContext {
  at: string
}

export interface RunnerOptions {
  timeoutMs?: number
  /** Stop from the tab (stage 3), and the runner's own cleanup. */
  signal?: AbortSignal
}

/** A value thrown from inside a vm context is an instance of a different Error class than the
 *  host's, so `instanceof Error` fails and shapeError would call String(err) instead of err.message.
 *  We detect foreign-realm errors using Object.prototype.toString and rebuild them as genuine host
 *  Errors, copying only the message string across the boundary. Interrupted objects (created
 *  host-side) pass through unchanged. */
function normalizeError(err: unknown): unknown {
  if (err instanceof Interrupted) return err
  if (Object.prototype.toString.call(err) === '[object Error]') {
    const message = typeof (err as any).message === 'string' ? (err as any).message : String(err)
    return new Error(message)
  }
  return err
}

export async function runScript(
  script: string,
  helpers: Record<string, unknown>,
  log: LogSink,
  ctx: RunContext,
  opts: RunnerOptions = {}
): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? SCRIPT_TIMEOUT_MS
  // A fresh object, so the script's own globals do not leak into the helpers object the caller keeps
  const sandbox: Record<string, unknown> = { ...helpers, log: (v: unknown) => log.log(v), console: undefined }
  const context = vm.createContext(sandbox, { name: 'agent-browser' })

  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const interrupted = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Interrupted('timeout', `script did not finish within ${timeoutMs} ms`)), timeoutMs)
    if (opts.signal) {
      onAbort = () => reject(new Interrupted(ctx.at, 'stopped'))
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }
  })

  try {
    // Compiled first so a syntax error is reported like any other failure; run as an async body so
    // the script may `await` and `return`.
    const wrapped = new vm.Script(`(async () => {\n${script}\n})()`, { filename: 'agent-script.js' })
    const running = Promise.resolve(wrapped.runInContext(context)) as Promise<unknown>
    await Promise.race([running, interrupted])
    return { log: log.lines }
  } catch (err) {
    return { log: log.lines, error: shapeError(normalizeError(err), ctx.at) }
  } finally {
    if (timer) clearTimeout(timer)
    if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort)
  }
}
