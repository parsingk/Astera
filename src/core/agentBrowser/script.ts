// What every run shares: how long it may take, what it returns, how output and failure are shaped.
// Pure — the runner (scriptRunner.ts) and the helpers (main) both build on this.

/** The whole script. Long enough for a slow dev server to come up and a few loads to happen. */
export const SCRIPT_TIMEOUT_MS = 60_000
/** One wait — `waitFor`, `waitForLoad`, the load inside `open`/`reload`. */
export const WAIT_TIMEOUT_MS = 30_000

export interface RunError {
  message: string
  /** The helper that was running — or `'script'` for a throw between helpers, `'timeout'` for the
   *  whole-script deadline. Always present: an agent that knows where it stopped can decide what to do. */
  at: string
}

export interface RunResult {
  log: string[]
  error?: RunError
}

/** The only output channel. `console.log` inside a script goes nowhere; the guide says so. */
export interface LogSink {
  readonly lines: string[]
  log(value: unknown): void
}

/** Strings verbatim, everything else as JSON; a value JSON refuses (a cycle) falls back to
 *  `String(value)` rather than throwing out of `log()`. */
export function stringifyLog(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return 'undefined'
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function createLog(): LogSink {
  const lines: string[] = []
  return {
    lines,
    log(value: unknown): void {
      lines.push(stringifyLog(value))
    }
  }
}

/** A helper cut short — by its own deadline, the script's, or Stop. Carries where. */
export class Interrupted extends Error {
  constructor(
    readonly at: string,
    message: string
  ) {
    super(message)
    this.name = 'Interrupted'
  }
}

export function shapeError(err: unknown, at: string): RunError {
  if (err instanceof Interrupted) return { message: err.message, at: err.at }
  if (err instanceof Error) return { message: err.message, at }
  return { message: String(err), at }
}

/** Races a promise against a deadline. Rejects with `Interrupted(at)`; the timer is cleared either way
 *  so a fast helper does not leave a 30-second timer behind. */
export function withTimeout<T>(p: Promise<T>, ms: number, at: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Interrupted(at, `${at} did not finish within ${ms} ms`)), ms)
  })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}
