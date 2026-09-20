// A project's package.json has nothing to do with whether the agent's CLI can start, but a toolchain
// manager sitting in front of it on PATH ties the two together: it reads the manifest of the working
// directory to pick a tool version, and refuses to run anything when it cannot parse it. A reviewer's
// whole evaluation was lost to exactly that (design F5).
import type { ProcLike } from './proc'

/** A process that never said a word and was gone this fast did not fail — it was never run. Five
 *  seconds is long enough to cover a cold start behind a shim and short enough that a CLI which really
 *  did start and then crash is not mistaken for one that was refused. */
export const IMMEDIATE_EXIT_MS = 5000

/** What we add for the one retry. Volta reads this and passes straight through to the executable,
 *  skipping version resolution and project detection. **Never set on the first attempt** (design S7):
 *  the variable is inherited by everything the session spawns, so leaving it on would silently ignore
 *  the version the person pinned for their own project's commands — a worse fault than the one being
 *  fixed. Only Volta is here because only Volta is what the evidence showed; another manager's bypass
 *  goes in this same object when there is a case for it. */
export const BYPASS_ENV: Readonly<Record<string, string>> = { VOLTA_BYPASS: '1' }

export function shouldRetryWithBypass(a: {
  attempt: number
  sawProtocolLine: boolean
  elapsedMs: number
}): boolean {
  if (a.attempt !== 0) return false
  // One line of protocol means the CLI ran. Whatever killed it after that is its own business, and a
  // bypass would only change which version died.
  if (a.sawProtocolLine) return false
  return a.elapsedMs < IMMEDIATE_EXIT_MS
}

/** `ProcLike.onLine` takes a single subscriber — it is a setter, not an emitter — so a caller that
 *  wants to know whether anything arrived cannot just listen as well; it would take the adapter's
 *  place. This wraps the process and counts on the way past.
 *
 *  `pid` and `outlivesApp` are read through getters onto the real proc rather than copied by the
 *  spread below: `pid` is 0 until the Host answers the spawn and changes once it does, and
 *  `outlivesApp` is stamped by `createProcRouter` — a plain spread would freeze both at whatever they
 *  were the moment this wrapper was built, which for `pid` is always 0 and for `outlivesApp` is
 *  whatever it happened to race to. */
export function watchFirstLine(proc: ProcLike): { proc: ProcLike; sawLine: () => boolean } {
  let saw = false
  return {
    sawLine: () => saw,
    proc: {
      ...proc,
      get pid() {
        return proc.pid
      },
      get outlivesApp() {
        return proc.outlivesApp
      },
      onLine: (cb) =>
        proc.onLine((line) => {
          saw = true
          cb(line)
        }),
      onExit: (cb) => proc.onExit(cb),
      write: (line) => proc.write(line),
      kill: () => proc.kill(),
      ...(proc.remember ? { remember: (patch: Record<string, unknown>) => proc.remember?.(patch) } : {})
    }
  }
}
