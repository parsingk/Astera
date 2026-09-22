// The Host's OrchServerDeps: the members it owns, and the actions it forwards to the app.
//
// **The command layer never learns which is which.** That is the whole point of the split (host
// control plane design §5) — when S2 makes startWorker local, this file changes and `handleCommand`
// does not.
import type { OrchServerDeps } from '../core/orchestration/command'
import { AppUnreachable } from '../core/host/orchProtocol'

/** What the Host answers out of itself. `runningSessions` and `appVersion` look like app questions
 *  and are not: the Host knows its own version and its own session registry, and `status` and
 *  `version` have to answer with no app attached — which is the first thing anyone will try. */
const OWNED = ['getState', 'setState', 'now', 'log', 'enabled', 'runningSessions', 'appVersion'] as const

/**
 * **Forwarded, and a refusal reaches the caller.** `handleCommand` either awaits these and lets the
 * rejection out, or turns it into its own error reply — either way the command's outcome is decided
 * by the refusal, so the call is answered CONFLICT (`orch.ts`'s `refused` flag).
 */
const PROPAGATES = [
  'startWorker', 'releaseWorker', 'backup', 'mergeWorktrees', 'removeWorktrees', 'startCoordinator',
  'makeRunWorktree', 'listAccounts', 'readWorker', 'listRunConfigs', 'browserRun', 'repairOnce'
] as const

/**
 * **Forwarded, and when it cannot be asked it answers the value its own contract already has.**
 *
 * `repairTargetFor` is the one member where refusing costs more than degrading. A refusal makes a
 * review report answer CONFLICT, and then the reviewer's verdict is recorded **nowhere** — the worker
 * reported and nothing is left of it. `null` is this dependency's own word for "no repair target",
 * and the pure layer's answer to it is documented where the dependency is declared: it opens the
 * `repairFailed` Gate, which a person sees. A Gate beats a lost verdict.
 *
 * So this is the contract the call site was written against rather than a behaviour invented for the
 * Host — and it is a group rather than a special case so it cannot drift back out of the guard. The
 * value is the fallback each name degrades to. **Cannot-be-asked is one condition**: no app attached
 * and an app that will not answer are the same fact here, and both are logged.
 */
const DEGRADES = { repairTargetFor: null } as const

/**
 * **Forwarded, and the command layer deliberately swallows a failure.** `probeLimit` logs and carries
 * on with no limit detected; `resolveProjectRoot` logs and keeps the path it was given;
 * `readReviewFile` records the verdict file as malformed.
 *
 * **So these must not decide the status.** The command goes on to succeed or to fail for its own
 * reasons, and rewriting that later failure as CONFLICT tells a script "the app is missing" when the
 * truth was a bad id — the same lie the substring match used to tell, wearing a flag instead.
 */
const SWALLOWED = ['probeLimit', 'resolveProjectRoot', 'readReviewFile'] as const

/**
 * **Called as a bare statement — nobody holds the result.**
 *
 * `unregisterRolling` is declared `(sessionId: string): void`, and `startValidation`, `startReview`,
 * `startRepair` and `onDispatchLost` are the same shape. An `async` wrapper on any of them hands Node
 * a rejected promise nobody holds, and there is no `unhandledRejection` handler in the Host — so the
 * default takes the whole process down, and every terminal it owns with it. `unregisterRolling` is
 * reached by `send worker_done`, the commonest worker path, in exactly the no-app case this design
 * exists to serve.
 *
 * Swallowing is what these call sites already expect of an absent dependency, but it is logged here,
 * never silent — and it does not decide the status either, for SWALLOWED's reason.
 */
const FIRE_AND_FORGET = [
  'unregisterRolling', 'startValidation', 'startReview', 'startRepair', 'onDispatchLost'
] as const

/**
 * **Not supplied, and each one needs a decision this task does not own.**
 *
 * - `lang`, `browserEnabled`, `handoffEnabled`, `trackingEnabled` are synchronous getters. Making
 *   them remote needs the same sync/async answer `listAccounts` got, and their callers read them
 *   inline in conditions rather than awaiting anything.
 * - `handoffs` and `sessionTasks` are objects of methods, so each method needs its own entry in the
 *   app's answer table rather than one name on the wire.
 *
 * Both belong with the task that writes the app's side of that table. Until then the commands that
 * read them behave as they do with any dependency that is not injected: `browser-js`, `handoff` and
 * the three `session-task-*` commands answer "that feature is off", which is visible rather than
 * silent. **The guard below is what keeps this list from growing without anyone noticing.**
 */
const NOT_SUPPLIED = ['lang', 'browserEnabled', 'handoffEnabled', 'trackingEnabled', 'handoffs', 'sessionTasks'] as const

const DEGRADING = Object.keys(DEGRADES) as (keyof typeof DEGRADES)[]
const REMOTE = [...PROPAGATES, ...SWALLOWED, ...FIRE_AND_FORGET, ...DEGRADING]

/** Every name the groups above classify between them. */
type Classified =
  | (typeof OWNED)[number]
  | (typeof PROPAGATES)[number]
  | (typeof SWALLOWED)[number]
  | (typeof FIRE_AND_FORGET)[number]
  | (typeof NOT_SUPPLIED)[number]
  | keyof typeof DEGRADES

/** Whatever the groups above do not name between them lands here. */
type Unlisted<T, Listed extends PropertyKey> = Exclude<keyof T, Listed>
/** If anything is left, the compiler names it here and the build stops. An unused alias on purpose —
 *  what it produces is not a value but the check itself (the same pattern as
 *  `core/orchestration/cliPublic.ts`, for the same reason: the only way a list like this fails is by
 *  falling behind, and a dependency that quietly joins the unsupplied six is a Job that runs and
 *  never converges). */
type NothingLeft<T extends never> = T
type _everyDependencyIsClassified = NothingLeft<Unlisted<OrchServerDeps, Classified>>

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
  /** Called when a **PROPAGATES** action could not be put to the app — none attached, or the one that
   *  was did not answer. `orch.ts` answers that call CONFLICT on the strength of this, rather than by
   *  matching text in the reply. Never called for the other two groups: their refusal does not decide
   *  what the command answers. */
  onAppRequired(name: string, why: string): void
}): OrchServerDeps {
  const refusal = (name: string): AppUnreachable =>
    new AppUnreachable(`APP_REQUIRED: ${name} needs the Astera app running`)

  // **Every argument travels, always, as the array it arrived in** (F21). Not "the one argument when
  // there is one": `removeWorktrees(paths)` takes a single argument that is itself an array, so a
  // conditional puts it on the wire byte-identically to a two-argument call and the far side cannot
  // tell them apart. One rule, no per-name table, and no room for a fourth argument shape to fall
  // off later — the app spreads what it is given. `backup()` travels as `[]`.
  const forward = (name: string, flags: boolean) =>
    async (...args: unknown[]): Promise<unknown> => {
      // **여기서 바로 거절한다.** 앱이 올 때까지 기다리게 두면 워커가 영영 멈춘다.
      if (!a.hasApp()) {
        const err = refusal(name)
        if (flags) a.onAppRequired(name, err.message)
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
        if (flags && err instanceof AppUnreachable) a.onAppRequired(name, err.message)
        throw err
      }
    }

  /** Same forwarding, but a question that could not be put to the app answers `fallback` instead of
   *  rejecting — see DEGRADES for why that is this dependency's own contract and not a Host
   *  invention. One condition, not two: "no app attached" and "the app did not answer" are the same
   *  fact to the caller. An `ok: false` from an app that *did* answer is the action's own failure and
   *  still throws — that is not a question we could not ask. */
  const degrading = (name: string, fallback: unknown) =>
    async (...args: unknown[]): Promise<unknown> => {
      try {
        if (!a.hasApp()) throw refusal(name)
        return await a.act(name, args)
      } catch (err) {
        if (!(err instanceof AppUnreachable)) throw err
        // Logged every time. A Gate that opened because the app was unreachable has to be traceable
        // to that — otherwise it reads as a verdict about the work.
        a.log(`${name} could not be asked (${err.message}) — answering ${JSON.stringify(fallback)}`)
        return fallback
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
    REMOTE.map((name) => {
      if ((FIRE_AND_FORGET as readonly string[]).includes(name)) return [name, forgetful(name)]
      if (name in DEGRADES) return [name, degrading(name, DEGRADES[name as keyof typeof DEGRADES])]
      return [name, forward(name, (PROPAGATES as readonly string[]).includes(name))]
    })
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
