// A project's package.json has nothing to do with whether the agent's CLI can start, but a toolchain
// manager sitting in front of it on PATH ties the two together: it reads the manifest of the working
// directory to pick a tool version, and refuses to run anything when it cannot parse it. A reviewer's
// whole evaluation was lost to exactly that (design F5).
//
// This used to decide an *automatic* retry — the app quietly added a bypass and respawned once on its
// own. Design S7 said why that default is wrong (the variable rides every command the session ever
// spawns, so it silently overrides a version the person pinned on purpose) and F5's rewrite found that
// the automatic retry path did the exact thing S7 forbade, just one door over. What is here now answers
// a narrower question — does this death *look like* a refusal? — and the app no longer acts on that
// answer by itself: `ChatSessionManager` uses it only to decide whether to *offer* the person a button,
// and the respawn itself only ever runs after they press it (manager.ts's `retryWithBypass`).
import type { ProcLike } from './proc'

/** A process that never said a word and was gone this fast did not fail — it was never run. Five
 *  seconds is long enough to cover a cold start behind a shim and short enough that a CLI which really
 *  did start and then crash is not mistaken for one that was refused. */
export const IMMEDIATE_EXIT_MS = 5000

/** What the person's confirmed retry adds (manager.ts's `retryWithBypass`, never the exit handler on
 *  its own — S7). Volta reads this and passes straight through to the executable, skipping version
 *  resolution and project detection. Only Volta is here because only Volta is what the evidence showed;
 *  another manager's bypass goes in this same object when there is a case for it. */
export const BYPASS_ENV: Readonly<Record<string, string>> = { VOLTA_BYPASS: '1' }

/** Whether a death *looks like* a refusal to run at all, rather than a CLI that started and then failed
 *  on its own: no line of its protocol ever arrived, and it was gone within `IMMEDIATE_EXIT_MS`. This
 *  alone is not enough to offer the bypass button — a DLL that is missing, an antivirus block, an
 *  ordinary crash all look the same from here — `ChatSessionManager` also requires positive evidence a
 *  bypassable manager is actually in the way (main's detection) before it sets `ChatState.bypassOffer`. */
export function looksLikeRefusal(a: { sawProtocolLine: boolean; elapsedMs: number }): boolean {
  // One line of protocol means the CLI ran. Whatever killed it after that is its own business, and a
  // bypass would only change which version died.
  if (a.sawProtocolLine) return false
  return a.elapsedMs < IMMEDIATE_EXIT_MS
}

/** design F5, detection signal 1: whether a resolved executable path is one a version manager rewired
 *  PATH to point at, rather than the tool's own install. Volta's shims (and the tool image one level
 *  under them) live under a `Volta` directory — `~/.volta/bin/<tool>` on macOS/Linux,
 *  `%LOCALAPPDATA%\Volta\bin\<tool>.exe` on Windows — so this checks for a path *segment* named
 *  `volta`/`.volta`, not a suffix, and case-insensitively (Windows paths). The environment read that
 *  supplies the path (`locateCli`) and the second signal (`VOLTA_HOME`) both stay in main — this is
 *  only the judgement on a path already in hand, which is why it can be pure and tested here. */
export function isVoltaManagedPath(resolvedPath: string): boolean {
  return resolvedPath
    .split(/[\\/]+/)
    .some((segment) => segment.toLowerCase() === 'volta' || segment.toLowerCase() === '.volta')
}

/** design F5 fix round 1 (Important 4 / review finding 3): *which* of the two detection signals
 *  matched, not just whether one did. `VOLTA_HOME` being set proves Volta is installed and active on
 *  this machine, not that it gated *this* CLI's launch — Volta can be managing Node while `codex` is a
 *  wholly separate install an antivirus blocked. `'path'` is the confident signal (the resolved
 *  executable is itself under a Volta directory); `'voltaHome'` is the weaker one, and a caller has to
 *  soften what it tells the person when this is the only signal it has. `null` is neither. */
export type BypassSignal = 'path' | 'voltaHome' | null

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
      // Fix round 1: a getter with no setter throws on assignment (strict mode, which ESM always is) —
      // loud, not quiet, but still not the contract `ProcLike` promises. Nothing writes through the
      // wrapper today (createProcRouter stamps `outlivesApp` on the raw proc *before* this wraps it),
      // but the two fields are declared as plain, writable properties, so the wrapper honours that.
      set pid(v) {
        proc.pid = v
      },
      get outlivesApp() {
        return proc.outlivesApp
      },
      set outlivesApp(v) {
        proc.outlivesApp = v
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
