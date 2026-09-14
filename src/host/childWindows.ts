// The Host must never give a child process a console window of its own (win32).
//
// **Why this exists, and why it did not before 1.3.20.** node-pty forks a helper on every ConPTY
// kill — `_getConsoleProcessList` in windowsPtyAgent.js, which enumerates the console's processes
// from a separate process because a process can only be attached to one console. It calls
// `child_process.fork(...)` with no options, so no `windowsHide`, and `fork` starts the child from
// `process.execPath`.
//
// Until 1.3.20 that `process.execPath` was `Astera.exe` — an executable linked for the Windows GUI
// subsystem, which is never given a console. The helper was silent (it also failed outright under
// ELECTRON_RUN_AS_NODE; see the `leave` comment in index.ts). From 1.3.20 the Host runs from a Node
// of its own, and `node.exe` is linked for the **console** subsystem: the Host itself is started
// DETACHED and so holds no console, so Windows hands the forked helper a brand-new one. That is a
// black window flashing up every time a person closes a session tab.
//
// The option belongs on that `fork` call, which is inside a dependency. Rather than reach into it,
// the Host states the rule for itself: nothing it starts gets a console window. The wrapper only
// adds a creation flag — it changes no argument, no stdio, and nothing about how a pty is created or
// torn down, because pty creation does not go through `child_process` at all (it is native, in
// conpty.node). The single caller today is node-pty's helper.
import type childProcess from 'node:child_process'
import type { ChildProcess, ForkOptions } from 'node:child_process'

/** `windowsHide` is missing from `ForkOptions` in @types/node, but `fork` honours it: node's own
 *  implementation spreads the options it was given into the `spawn` call it makes
 *  (`options = { ...options, shell: false }` then `spawn(options.execPath, args, options)`), and
 *  `spawn` is where `windowsHide` is read. The type is the gap, not the runtime. */
type ForkOptionsWithHide = ForkOptions & { windowsHide?: boolean }

/** The `node:child_process` module object, narrowed to the one function that is replaced. Injected
 *  rather than imported here so the behaviour is testable without forking anything. */
export interface ForkHolder {
  fork: typeof childProcess.fork
}

/**
 * Replaces `fork` with one that always passes `windowsHide: true`. Returns whether it did.
 *
 * A no-op off win32 — `windowsHide` is meaningless there, and leaving the real function in place
 * keeps the one platform this is for from being the only one running patched code.
 *
 * Idempotent by construction at the call site (it runs once, at Host startup), and deliberately not
 * guarded against double application: wrapping twice would still be correct, just pointless.
 */
export function hideForkedConsoleWindows(cp: ForkHolder, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return false
  // One cast, at the boundary: it merges `fork`'s two overloads into the single signature the wrapper
  // below is written against, and admits `windowsHide` — which `ForkOptions` omits but `fork` passes
  // through (see ForkOptionsWithHide).
  const real = cp.fork as (
    modulePath: string | URL,
    argsOrOptions?: readonly string[] | ForkOptionsWithHide,
    options?: ForkOptionsWithHide
  ) => ChildProcess
  const wrapped = (
    modulePath: string | URL,
    argsOrOptions?: readonly string[] | ForkOptionsWithHide,
    options?: ForkOptionsWithHide
  ): ChildProcess => {
    // `fork(path, options)` — the second argument is the options object, not an args array.
    if (argsOrOptions !== undefined && !Array.isArray(argsOrOptions)) {
      return real(modulePath, { ...(argsOrOptions as ForkOptionsWithHide), windowsHide: true })
    }
    return real(modulePath, argsOrOptions as readonly string[] | undefined, { ...options, windowsHide: true })
  }
  // `fork` is declared as two overloads; this covers both in one signature, which TypeScript cannot
  // see as the same type. The cast asserts exactly that, and both forms have a test.
  cp.fork = wrapped as typeof childProcess.fork
  return true
}
