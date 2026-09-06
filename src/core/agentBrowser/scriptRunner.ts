// Runs an agent's script with the helpers as its whole world.
//
// `vm` is not a security boundary. A determined script can climb out of a vm context, and this code
// does not pretend otherwise. The threat model here is a mistaken script written by the user's own
// agent, against the user's own dev server, inside the user's own app — what `vm` does give is a
// clean global scope (no `require`, no `process`, no `fetch`), so a script that reaches for one of
// them gets `undefined` and a clear error rather than the app's Node environment.
//
// Be specific about where the way out is, because it is not exotic: **the helpers are host
// functions**. Every one of them is placed in the contextified global as-is, so
// `help.constructor('return process')()` returns the live host `process` — `help.constructor` is the
// host realm's `Function`, and the body it compiles runs with the host's globals in scope. Nothing
// below closes that, and nothing below tries to: marshalling every helper across the boundary would
// buy nothing from an author who already has a shell on this machine. It is written down so the
// tests in scriptRunner.test.ts are not read as a guarantee they do not make.
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
function normalizeError(err: unknown, timeoutMs: number): unknown {
  if (err instanceof Interrupted) return err
  // `runInContext`'s own `timeout` — the deadline for a body that never awaits — throws a plain host
  // Error, which shapeError would report at `ctx.at` ('script') with Node's own wording. It is the
  // same whole-script deadline the race below enforces, so the agent is told the same thing: `at:
  // 'timeout'`, with the reason this one could not be reported any other way.
  if ((err as { code?: unknown } | null | undefined)?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
    return new Interrupted('timeout', `script did not finish within ${timeoutMs} ms (it never awaited)`)
  }
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
  // A fresh object, so the script's own globals do not leak into the helpers object the caller keeps.
  // `log` is injected here rather than passed in, which puts it outside whatever gate the caller wraps
  // its helpers in — so it is gated here: an abandoned body that keeps logging would otherwise grow
  // the sink for the life of the app, invisibly (the result below is a copy) and without a bound.
  const sandbox: Record<string, unknown> = {
    ...helpers,
    log: (v: unknown) => {
      if (!opts.signal?.aborted) log.log(v)
    },
    console: undefined
  }
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
    // `timeout` bounds only the synchronous prologue — the wrapped body is async, so it returns at
    // the script's first `await` and everything after that is the race below. That one case is worth
    // bounding here all the same: a `while (true) {}` with no `await` in it never yields, so no
    // timer and no abort can ever reach it and it would hang the whole main process.
    const running = Promise.resolve(wrapped.runInContext(context, { timeout: timeoutMs })) as Promise<unknown>
    await Promise.race([running, interrupted])
    // A copy, not the sink. Losing the race does not stop the script body: it keeps running and keeps
    // calling `log`, and handing back the live array would let it grow what the caller was already
    // given — including between this return and the server serialising it.
    return { log: [...log.lines] }
  } catch (err) {
    return { log: [...log.lines], error: shapeError(normalizeError(err, timeoutMs), ctx.at) }
  } finally {
    if (timer) clearTimeout(timer)
    if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort)
  }
}
