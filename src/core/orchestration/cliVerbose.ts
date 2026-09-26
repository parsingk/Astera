// `--verbose` (CLI spec §39): what this process did on the way to its answer, on stderr.
//
// **stdout is never touched.** It carries one result and one envelope, and a script reading it must
// get the same bytes with or without this flag. Every line here goes through the writer the caller
// passes, which in run.ts is stderr, the same channel the keepalive uses.
//
// **Off unless asked for.** A command that answers at once prints nothing extra by default, and a CI
// log that wants the diagnostics turns them on for the step that needs them.
//
// **The lines say what can only be seen from here**: which address this process reached, what the Host
// said in its handshake, and how long each call took. The Host's own log already says what it did with
// a call; what it cannot say is how long the round trip was from the caller's side, or which Host a
// shell with `ASTERA_HOST` set actually reached.
import type { HostConnection } from '../host/connect'
import { HOST_PROTOCOL } from '../host/protocol'

export interface VerboseLog {
  /** One line, when `--verbose` was given. */
  say(msg: string): void
  /** Runs `run` and says how long it took and how it ended (`outcome`), or how long it took to throw.
   *  The value or the throw goes on unchanged. */
  timed<T>(label: string, run: () => Promise<T>, outcome: (r: T) => string): Promise<T>
}

export function verboseLog(a: { enabled: boolean; write: (line: string) => void; now?: () => number }): VerboseLog {
  const now = a.now ?? Date.now
  const say = (msg: string): void => {
    if (a.enabled) a.write(`verbose: ${msg}`)
  }
  return {
    say,
    timed: async (label, run, outcome) => {
      if (!a.enabled) return run()
      const started = now()
      let value: Awaited<ReturnType<typeof run>>
      try {
        value = await run()
      } catch (err) {
        say(`${label} failed after ${now() - started}ms: ${String(err)}`)
        throw err
      }
      say(`${label} took ${now() - started}ms: ${outcome(value)}`)
      return value
    }
  }
}

/** The Host's `hello`, in one line. The protocol is this CLI's own: a handshake only completes when the
 *  two match (`connectHost` fails with `protocol` otherwise). */
export function helloLine(hello: HostConnection['hello'], ms: number): string {
  const features = hello.features.length > 0 ? hello.features.join(', ') : 'none'
  return `handshake in ${ms}ms: Host ${hello.host}, protocol ${HOST_PROTOCOL}, pid ${hello.pid}, started ${hello.startedAt}, features ${features}`
}
