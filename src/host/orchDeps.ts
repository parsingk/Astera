// The Host's OrchServerDeps: four members it owns, and the actions it forwards to the app.
//
// **The command layer never learns which is which.** That is the whole point of the split (host
// control plane design §5) — when S2 makes startWorker local, this file changes and `handleCommand`
// does not.
import type { OrchServerDeps } from '../core/orchestration/command'

/** The dependencies that are not questions about state but things somebody has to *do* — spawn a
 *  session, touch a worktree, read a log off disk. The Host has none of that; the app does.
 *
 *  **`runningSessions` and `appVersion` are NOT here.** They look like app questions and are not: the
 *  Host knows its own version and its own session registry, and `status` and `version` have to answer
 *  with no app attached — which is the first thing anyone will try.
 *
 *  **`listAccounts` is the one that does not fit, and it is listed anyway.** `handleCommand` calls it
 *  synchronously and uses the array in the same expression (`accounts`, `--account`,
 *  `--coordinator-account`), and a call that crosses a socket cannot be synchronous — those three
 *  read a Promise where an array should be. It stays here because it is an app question and nothing
 *  in this task can answer it locally; giving the Host an account list of its own (pushed the way the
 *  state is pushed) is what makes those three work through the Host. */
const REMOTE = [
  'startWorker', 'releaseWorker', 'unregisterRolling', 'backup', 'mergeWorktrees',
  'removeWorktrees', 'startCoordinator', 'makeRunWorktree', 'listAccounts', 'readWorker',
  'listRunConfigs', 'probeLimit', 'browserRun'
] as const

export function hostOrchDeps(a: {
  getState: OrchServerDeps['getState']
  setState: OrchServerDeps['setState']
  now(): string
  /** The Host's own live session count — `status` must answer with no app attached. */
  runningSessions(): number
  /** The Host's own version, from `ASTERA_HOST_VERSION`. */
  appVersion(): string
  act(name: string, args: unknown): Promise<unknown>
  hasApp(): boolean
}): OrchServerDeps {
  const remote = Object.fromEntries(
    REMOTE.map((name) => [
      name,
      // **Variadic, though almost every one of these takes a single object.** Two do not —
      // `mergeWorktrees(runCwd, paths)` and `browserRun(sessionId, script)` — and a wrapper with one
      // parameter would drop their second argument without a sound: `run-merge` would then report
      // success having merged nothing. One argument travels as itself, so the ordinary case stays the
      // plain object the app already expects, and `backup()` travels as `undefined`.
      async (...args: unknown[]) => {
        // **여기서 바로 거절한다.** 앱이 올 때까지 기다리게 두면 워커가 영영 멈춘다.
        if (!a.hasApp()) throw new Error(`APP_REQUIRED: ${name} needs the Astera app running`)
        return a.act(name, args.length > 1 ? args : args[0])
      }
    ])
  )
  return {
    getState: a.getState,
    setState: a.setState,
    now: a.now,
    // The Host serves orchestration or it would not have been asked. The app's toggle decides
    // whether the *app* drives Jobs, and a CLI talking to the Host is not the app.
    enabled: () => true,
    runningSessions: a.runningSessions,
    appVersion: a.appVersion,
    ...remote
  } as unknown as OrchServerDeps
}
