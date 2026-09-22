// The Host's OrchServerDeps: four members it owns, and the actions it forwards to the app.
//
// **The command layer never learns which is which.** That is the whole point of the split (host
// control plane design §5) — when S2 makes startWorker local, this file changes and `handleCommand`
// does not.
import type { OrchServerDeps } from '../core/orchestration/command'
import { AppUnreachable } from '../core/host/orchProtocol'

/** The dependencies that are not questions about state but things somebody has to *do* — spawn a
 *  session, touch a worktree, read a log off disk. The Host has none of that; the app does.
 *
 *  **`runningSessions` and `appVersion` are NOT here.** They look like app questions and are not: the
 *  Host knows its own version and its own session registry, and `status` and `version` have to answer
 *  with no app attached — which is the first thing anyone will try. */
const REMOTE = [
  'startWorker', 'releaseWorker', 'unregisterRolling', 'backup', 'mergeWorktrees',
  'removeWorktrees', 'startCoordinator', 'makeRunWorktree', 'listAccounts', 'readWorker',
  'listRunConfigs', 'probeLimit', 'browserRun'
] as const

/**
 * The ones `handleCommand` calls as a bare statement and never awaits.
 *
 * **A refusal from one of these has nobody to reject to.** `unregisterRolling` is declared
 * `(sessionId: string): void` and both of its call sites (`command.ts`'s dispatch-abandon, and
 * `dropRollingChain` on the two worker_done paths) drop the result on the floor. An `async` wrapper
 * there hands Node a rejected promise nobody holds, and there is no `unhandledRejection` handler in
 * the Host — so the default takes the whole process down, and every terminal it owns with it. It is
 * reached by `send worker_done`, the commonest worker path, in exactly the no-app case this design
 * exists to serve.
 *
 * Swallowing is the right answer for this one — with no app there is no rolling registration to
 * unregister — but it is logged, never silent.
 */
const FIRE_AND_FORGET: ReadonlySet<string> = new Set(['unregisterRolling'])

export function hostOrchDeps(a: {
  getState: OrchServerDeps['getState']
  setState: OrchServerDeps['setState']
  now(): string
  /** The Host's own live session count — `status` must answer with no app attached. */
  runningSessions(): number
  /** The Host's own version, from `ASTERA_HOST_VERSION`. */
  appVersion(): string
  act(name: string, args: unknown[]): Promise<unknown>
  hasApp(): boolean
  /** The Host's log. Passed on as `OrchServerDeps.log` as well, so that every `deps.log?.()` the
   *  command layer already writes — the limit probe that could not run, a task-update that bypassed
   *  the transition table — lands somewhere a person can read it. Without it the Host's command layer
   *  degrades silently, which is the one thing a degradation must not do. */
  log(message: string): void
  /** Called when a forwarded action could not be put to the app at all — none attached, or the one
   *  that was did not answer. `orch.ts` answers that call CONFLICT on the strength of this, rather
   *  than by matching text in the reply. */
  onAppRequired(name: string, why: string): void
}): OrchServerDeps {
  const refusal = (name: string): AppUnreachable =>
    new AppUnreachable(`APP_REQUIRED: ${name} needs the Astera app running`)

  // **Every argument travels, always, as the array it arrived in** (F21). Not "the one argument when
  // there is one": `removeWorktrees(paths)` takes a single argument that is itself an array, so a
  // conditional puts it on the wire byte-identically to a two-argument call and the far side cannot
  // tell them apart. One rule, no per-name table, and no room for a fourth argument shape to fall
  // off later — the app spreads what it is given. `backup()` travels as `[]`.
  const forward = (name: string) =>
    async (...args: unknown[]): Promise<unknown> => {
      // **여기서 바로 거절한다.** 앱이 올 때까지 기다리게 두면 워커가 영영 멈춘다.
      if (!a.hasApp()) {
        const err = refusal(name)
        a.onAppRequired(name, err.message)
        throw err
      }
      try {
        return await a.act(name, args)
      } catch (err) {
        // The app was there a moment ago and the question still could not be put to it — it went
        // away mid-flight, or held the question past the deadline (`HostServer.act`). That is the
        // same class of fact as "no app attached" and gets the same answer: not now. An `ok: false`
        // from an app that did answer is the action's own failure and is not this — it arrives as a
        // plain Error and passes straight through.
        if (err instanceof AppUnreachable) a.onAppRequired(name, err.message)
        throw err
      }
    }

  /** Same forwarding, with the refusal caught and written down instead of thrown. Returns nothing:
   *  the declared signature is `void`, and handing back a promise is what made this dangerous. */
  const forgetful = (name: string) =>
    (...args: unknown[]): void => {
      if (!a.hasApp()) {
        a.log(`${name} was not forwarded: ${refusal(name).message}`)
        return
      }
      void a.act(name, args).catch((err) => a.log(`${name} failed in the app: ${String(err)}`))
    }

  const remote = Object.fromEntries(
    REMOTE.map((name) => [name, FIRE_AND_FORGET.has(name) ? forgetful(name) : forward(name)])
  )
  return {
    getState: a.getState,
    setState: a.setState,
    now: a.now,
    log: a.log,
    // The Host serves orchestration or it would not have been asked. The app's toggle decides
    // whether the *app* drives Jobs, and a CLI talking to the Host is not the app.
    enabled: () => true,
    runningSessions: a.runningSessions,
    appVersion: a.appVersion,
    ...remote
  } as unknown as OrchServerDeps
}
