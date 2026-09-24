// The Host's OrchServerDeps: the members it owns, and the actions it forwards to the app.
//
// **The command layer never learns which is which.** That is the whole point of the split (host
// control plane design §5) — S2 made startWorker local (HOST_LOCAL), and this file changed while
// `handleCommand` did not.
import type { OrchAccount, OrchRunConfig, OrchServerDeps } from '../core/orchestration/command'
import type { Provider } from '../core/types'
import { AppUnreachable } from '../core/host/orchProtocol'
import { RepairNeeded } from '../core/settings/repairNeeded'
import { HostRetiring } from '../core/host/hostRetiring'
import type { HostSessions } from './sessions'
import type { HostLocal, HostLocalName } from './spawner'

/** What the Host answers out of itself. `runningSessions` and `appVersion` look like app questions
 *  and are not: the Host knows its own version and its own session registry, and `status` and
 *  `version` have to answer with no app attached — which is the first thing anyone will try.
 *
 *  **`backup` joined them when the CLI stopped going through the app.** It copies
 *  `orchestration.json` aside before `reset` wipes it, and that file is the Host's — forwarding it
 *  had the app copy a file another process owns. That was harmless while the app was the only writer;
 *  with the CLI writing straight to the Host, a copy taken in the app can be a state one commit old,
 *  which is the one thing a safety net must not be. Here it goes through the store's own write queue,
 *  so the copy is of the state the command that asked for it just saw. */
const OWNED = ['getState', 'setState', 'now', 'log', 'runningSessions', 'appVersion', 'backup'] as const

/**
 * **Forwarded, and a refusal reaches the caller.** `handleCommand` either awaits these and lets the
 * rejection out, or turns it into its own error reply — either way the command's outcome is decided
 * by the refusal, so the call is answered CONFLICT (`orch.ts`'s `appRefused` mark).
 */
const PROPAGATES = [
  'browserRun',
  // **The three toggles the app owns.** Each is read as the first thing its command does, before any
  // state is read and before anything has been committed, so a refusal costs nothing but the answer
  // "not now" — which is the truth, and better than telling a person the feature is off when it is
  // their app that is missing. (`lang` is the fourth of this shape and is *not* here: see DEGRADES.)
  'browserEnabled', 'handoffEnabled', 'trackingEnabled'
] as const

/**
 * **Forwarded one method at a time, under a dotted name.** `handoffs` and `sessionTasks` are objects
 * of methods rather than functions, so there is nothing to put on the wire under the bare name — the
 * app's answer table resolves `handoffs.save` and the three `sessionTasks.*` the same way it resolves
 * every other entry, by looking the name up in the dependency object it already had.
 *
 * All four are async and every one of their results is used by the command that called them, so all
 * four are **PROPAGATES**: a refusal decides that command's outcome and reaches the caller.
 */
const NESTED = {
  handoffs: ['save'],
  sessionTasks: ['start', 'complete', 'cancel']
} as const

/**
 * **Forwarded, and when it cannot be asked it answers the value its own contract already has.**
 *
 * The two members where refusing costs more than degrading, because the command has already done
 * something by the time they are called:
 *
 * - `repairTargetFor`: a refusal makes a review report answer CONFLICT, and then the reviewer's
 *   verdict is recorded **nowhere** — the worker reported and nothing is left of it. `null` is this
 *   dependency's own word for "no repair target", and the pure layer's answer to it is documented
 *   where the dependency is declared: it opens the `repairFailed` Gate, which a person sees. A Gate
 *   beats a lost verdict.
 *
 *   **This entry is also what makes `startRepair` safe with no app, and that is not obvious**
 *   (ruling F58). `startRepair` *is* forwarded — it is in FIRE_AND_FORGET below, so with an app it
 *   goes out over the socket and without one it is logged and swallowed. Swallowed is what would
 *   leave a half-opened repair: a Dispatch committed with no spec file and no worker, which nothing
 *   would ever finish. What stops that is this `null` one layer up — the verdict never opens a repair
 *   Dispatch at all, so the swallowed call has no Dispatch to have abandoned. **Move
 *   `repairTargetFor` out of this group and that hole opens**, silently, at a call site that says
 *   nothing about it — which is why it is written down at both ends.
 * - `repairOnce`: `gate-resolve` commits the Gate resolution **before** calling it, so a refusal
 *   answers CONFLICT for a command whose main effect has already landed — a script reads "nothing
 *   happened" about something that did. `{ ok: false, error }` is this dependency's own way of saying
 *   the retry did not open, and the call site already carries it to the caller as `retryOnceFailed`
 *   in a 200 body, for exactly this: the person's "one more try" quietly not happening.
 * - `lang`: read one line below `repairTargetFor`, in the same review report, for the same reason —
 *   both feed `applyReviewResult`. Refusing here would 409 the very command the line above degrades
 *   to keep, so the degradation above would buy nothing. `'en'` is this dependency's own documented
 *   absent value ("주입되지 않으면 영어다"): a Gate in the wrong language is a Gate a person can still
 *   read and act on, and a lost verdict is not.
 *
 * So these are the contracts the call sites were written against rather than behaviour invented for
 * the Host — and a group rather than two special cases, so they cannot drift back out of the guard.
 * The value is a function of the reason, so what a caller is handed says why. **Cannot-be-asked is
 * one condition**: no app attached and an app that will not answer are the same fact here, and both
 * are logged.
 */
const DEGRADES = {
  repairTargetFor: () => null,
  repairOnce: (why: string) => ({ ok: false as const, error: why }),
  lang: () => 'en',
  // **`chatPending` joined in CLI phase D4.** The card a chat session holds open is in the app's
  // adapter and nowhere the Host can read. `undefined` is this dependency's own word for "could not
  // be asked" (command.ts): `sessions read` then leaves `pending` out, rather than answering `null`,
  // which would claim there is no card. Refusing would cost the whole read, and the conversation
  // itself is the Host's to give.
  chatPending: () => undefined
} as const

/**
 * **Forwarded, and the command layer deliberately swallows a failure.** `resolveProjectRoot` logs and
 * keeps the path it was given. `probeLimit` (logs and carries on with no limit detected) and
 * `readReviewFile` (records the verdict file as malformed) were here until S2; they are HOST_LOCAL now,
 * and a call of theirs the Host does not own is still forwarded this way.
 *
 * **So these must not decide the status.** The command goes on to succeed or to fail for its own
 * reasons, and rewriting that later failure as CONFLICT tells a script "the app is missing" when the
 * truth was a bad id — the same lie the substring match used to tell, wearing a flag instead.
 */
const SWALLOWED = ['resolveProjectRoot'] as const

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
 * **Forwarded when the app is there, and answered from the profile when it is not** (CLI phase C).
 *
 * `listAccounts` was PROPAGATES, and that left a shell with Astera closed able to create a Job and
 * unable to put a task in it: `tasks add` checks every `--account`, and `accounts list` itself is
 * the list. The answer does not need the app, only the app's file — the profile's accounts.json,
 * which the app writes and nothing else does.
 *
 * **Not DEGRADES, and the difference is the point.** A degraded value is a stand-in the command
 * layer copes with (`null`, `'en'`). This fallback is the real answer: with no app attached there is
 * no writer, so the file is the last word the app wrote. When the app *is* attached its in-memory
 * list stays the authority, because it can lead the disk for a moment (a save that has not landed).
 *
 * Cannot-be-asked is one condition here as in DEGRADES: no app, or an app that stopped answering
 * mid-question, both read the file, and both are logged. `onAppRequired` is **not** called when the
 * read succeeds, so the call is not answered CONFLICT. When the read itself fails — a corrupt file,
 * which only the app may repair — it is called, and the caller gets 6 with the file's own reason.
 *
 * The local read is injected (`readAccounts`), so this file stays free of the filesystem.
 */
const LOCAL_WHEN_ABSENT = ['listAccounts', 'listRunConfigs'] as const

/** Which file each LOCAL_WHEN_ABSENT member reads, for the log line that says it answered from one.
 *
 *  **`listRunConfigs` joined in CLI phase D.** It was PROPAGATES, and never DEGRADES, for a reason
 *  that still holds: a coordinator told "there are no check configs" omits `--validate`, and that Run
 *  completes with verification silently off. That reason was against a *stand-in* `[]`. What the Host
 *  reads is the real list — the profile's run-configs.json, which only the app writes, merged with the
 *  seeds of the Job's folder by the same function the app uses (core/run/load.ts) — so there is no
 *  stand-in to mislead anyone, and a damaged file still refuses rather than answering `[]`.
 *
 *  With no Host at all the CLI still answers `run-configs` from the state file with `[]`
 *  (`core/orchestration/stateFile.ts`'s allowlist): nothing is coordinating anything then, and `[]`
 *  is true of that. */
const LOCAL_FILE: Record<(typeof LOCAL_WHEN_ABSENT)[number], string> = {
  listAccounts: 'accounts.json',
  listRunConfigs: 'run-configs.json'
}

/**
 * **Answered by the Host out of its own registries, with or without an app attached** (CLI phase C,
 * `astera sessions`).
 *
 * Not OWNED, and the difference is the one member that acts. OWNED is state and facts about the Host
 * itself, and its one effect, `setState`, is marked by the commit flag in `orch.ts`. These are the
 * sessions the Host holds — the ptys live in this process, so there is nothing to forward even when
 * the app is attached, and forwarding would only make `sessions list` fail when Astera is closed,
 * which is when a shell most wants it. But **`sendSession` types into a session**, and nothing about
 * that goes through `setState`: a retried `sessions send` would type the text a second time. So each
 * of these is wrapped to call `onEffect` when EFFECTFUL says it acts — the same mark the `act` funnel
 * leaves for a forwarded action, taken before the action for the same reason.
 *
 * Never refused, so never `onAppRequired`: nothing here needs the app.
 */
const HOST_SESSIONS = ['listSessions', 'readSession', 'sendSession', 'readChat'] as const

/**
 * **Forwarded when the app is attached, and done by the Host itself when none is** (CLI phase D4).
 *
 * `chatSend` types a turn into a chat session. With the app there it must be the app's to deliver:
 * its session driver (the one the scheduler and Slack use) moves the adapter's turn state with the
 * write, and only the app can see a card the turn would land behind. With no app there is no turn
 * state to keep in step; the Host writes the adapter's own bytes to the process (`HostSessions.
 * sendChat`), and the app, when it comes back, replays the process's output into a fresh adapter
 * and re-reads the transcript, which is how it already rebuilds a turn run while it was closed.
 *
 * **Not LOCAL_WHEN_ABSENT, and the difference is an app that stops answering mid-question.** A read
 * can be asked again from the file; a send cannot: the app may already have delivered it, and a
 * second write from the Host is the same turn twice. So only "no app attached" falls to the Host.
 * An app that went away mid-flight, or held the question past its deadline, is `onAppRequired` and
 * a refusal, like PROPAGATES. A local write that cannot be made (a Codex session with no thread yet)
 * is the app being required after all, and is refused the same way.
 *
 * Both routes run inside `HostSessions.serial`, so sends to one session go one at a time and in call
 * order whichever route each takes, and both are effects.
 *
 * **A send that delivered nothing leaves no receipt** (D4 review I1): a keyed refusal kept as a
 * receipt would replay the refusal to a retry the world has since made valid, for an hour. So each
 * route marks the effect only once nothing can refuse any more:
 * - app route: the card is asked first, through `chatPending` (DEGRADES, not an effect). A card open,
 *   or an app that does not hold the session or cannot say, is refused before anything is marked.
 *   Only then is `chatSend` forwarded, and the funnel marks it. The app's own card check stays as
 *   the backstop; a card that opens between the two calls is refused there, with a receipt, and that
 *   rare race is accepted.
 * - Host route: `sendChat` calls the mark right before it writes, after its own checks (no Codex
 *   thread yet, an ended process).
 */
const HOST_WHEN_ABSENT = ['chatSend'] as const

/** DEGRADES members whose fallback is not logged when **no app is attached**, only when an attached
 *  app failed to answer. `chatPending` with Astera closed is every chat read, and its fallback (the
 *  field left out) already tells the caller; a line per read would bury the degradations that are
 *  news (CLI phase D4 review M1). */
/**
 * **Answered by the Host's own spawner, with or without an app attached** (Host S2 design §1.4, §2.1;
 * Host S3 §3.1). The Host starts the worker or coordinator in its own pty registry, reads its output
 * there, and kills it there — so a coordinator's `worker-start`, `worker-stop`, `worker-release` and
 * `worker-read` work with no Astera window open. And it forks, merges and removes Job worktrees over
 * its own registry — so `--worktree new`, `makeRunWorktree`, `mergeWorktrees` and `removeWorktrees`
 * work the same way.
 *
 * **Per call, not per name (R1).** The spawner's `owns(name, args)` says whether this particular call
 * is the Host's. **The worktree names and `--worktree new` are the Host's unless an attached app still
 * keeps them itself (R4)** — an app old enough to have no S3 worktree module of its own asks the Host
 * to fork, merge and remove for it, exactly as it did before S3, and `owns` says so for as long as
 * that app is attached. It also says no to a read of a tail the app holds, and to a stop or a
 * `--terminal` reuse of a session the Host's registry never held (an app-local pty: the app started
 * it, so only the app can end it). A call the Host does not own goes the way its name went before S2
 * (`HOST_LOCAL_FALLBACK`): the seven that decide their command as PROPAGATES, `probeLimit` and
 * `readReviewFile` as SWALLOWED. So `worker-start --worktree new` with no app and no attached app that
 * keeps worktrees is still 409 `APP_REQUIRED` with no Dispatch left, exactly as before S3.
 *
 * **A Host started without the CLI paths has no spawner (`local: null`)**, and then every one of the
 * nine takes its old route — that Host behaves exactly as a Host before S2.
 *
 * A local call that acts calls `onEffect` before it runs, the rule the `act` funnel keeps. A local
 * refusal only the app can clear (a profile file the Host cannot read: accounts.json, app-settings.json)
 * arrives as `RepairNeeded` and is flagged with its file, so the command answers CONFLICT carrying
 * `repair: <file>` and the refusal's own words — never the 400 a failed start otherwise is.
 */
const HOST_LOCAL = [
  'startWorker', 'startCoordinator', 'releaseWorker', 'readWorker', 'probeLimit', 'readReviewFile',
  'makeRunWorktree', 'mergeWorktrees', 'removeWorktrees'
] as const satisfies readonly HostLocalName[]
type _hostLocalIsWhole = NothingLeft<Exclude<HostLocalName, (typeof HOST_LOCAL)[number]>>

/** When `local` does not own a call, it goes the way its group went before S2 (R1). */
const HOST_LOCAL_FALLBACK: Record<HostLocalName, 'propagates' | 'swallowed'> = {
  startWorker: 'propagates',
  startCoordinator: 'propagates',
  releaseWorker: 'propagates',
  readWorker: 'propagates',
  probeLimit: 'swallowed',
  readReviewFile: 'swallowed',
  makeRunWorktree: 'propagates',
  mergeWorktrees: 'propagates',
  removeWorktrees: 'propagates'
}

const QUIET_ABSENT: ReadonlySet<string> = new Set(['chatPending'])

const DEGRADING = Object.keys(DEGRADES) as (keyof typeof DEGRADES)[]
const REMOTE = [...HOST_LOCAL, ...PROPAGATES, ...SWALLOWED, ...FIRE_AND_FORGET, ...DEGRADING, ...LOCAL_WHEN_ABSENT, ...HOST_WHEN_ABSENT]

/** Every name the groups above classify between them. Nothing is unsupplied any more: the four
 *  synchronous getters became `T | Promise<T>` in `command.ts` and are awaited at their one call site
 *  each, and the two objects of methods travel a method at a time (NESTED). */
type Classified =
  | (typeof OWNED)[number]
  | (typeof HOST_LOCAL)[number]
  | (typeof PROPAGATES)[number]
  | (typeof SWALLOWED)[number]
  | (typeof FIRE_AND_FORGET)[number]
  | keyof typeof NESTED
  | keyof typeof DEGRADES
  | (typeof LOCAL_WHEN_ABSENT)[number]
  | (typeof HOST_SESSIONS)[number]
  | (typeof HOST_WHEN_ABSENT)[number]

/**
 * **Whether calling this dependency changes something outside the state** (request receipts design
 * §3). A receipt is recorded when a command committed, or when it called one of the names below that
 * is `true` — and the second half is what a list of command names would have got wrong: `run-merge`
 * runs a git merge, `worker-release` kills a session, `handoff` writes a memo and `browser-js` runs a
 * script in a real browser, none of them through `setState`.
 *
 * **Keyed by `Classified`, so the existing check below covers this too**: a dependency added later
 * cannot compile until both its group and its effectfulness are declared. The entries for OWNED are
 * declarations rather than lookups — those members never cross `a.act`, and `setState`'s half of the
 * rule is the commit flag `orch.ts` sets in its own wrapper.
 *
 * The reading is "does a second call leave something a single call could not have left". So a probe,
 * a file read and every toggle are `false` although they touch the disk; `unregisterRolling` is
 * `true` although it returns nothing, because the rolling chain it drops does not come back.
 */
const EFFECTFUL: Record<Classified, boolean> = {
  // OWNED — never forwarded; here for the compiler check and to state the rule in one place.
  getState: false,
  setState: true,
  now: false,
  log: false,
  runningSessions: false,
  appVersion: false,
  backup: true,
  // HOST_LOCAL — the same values these names had in PROPAGATES and SWALLOWED before S2 (the six), and
  // in PROPAGATES before S3 (the three worktree names).
  startWorker: true,
  startCoordinator: true,
  releaseWorker: true,
  readWorker: false,
  probeLimit: false,
  readReviewFile: false,
  mergeWorktrees: true,
  removeWorktrees: true,
  makeRunWorktree: true,
  // PROPAGATES.
  browserRun: true,
  browserEnabled: false,
  handoffEnabled: false,
  trackingEnabled: false,
  // SWALLOWED — a question about what is already there.
  resolveProjectRoot: false,
  // FIRE_AND_FORGET — every one of them starts or ends something, which is why nobody holds the
  // result. That the caller does not wait for them does not make them free to do twice.
  unregisterRolling: true,
  startValidation: true,
  startReview: true,
  startRepair: true,
  onDispatchLost: true,
  // NESTED, **by group and not by method**: `handoffs.save` writes the memo, and the three
  // `sessionTasks.*` each record a work unit. A method added to either object inherits its group's
  // flag with no compiler stop — the check below is over `OrchServerDeps`'s own keys, and these two
  // are objects. That is the safe direction of the two, because both groups are `true`: a new method
  // is over-marked, so a command that did nothing may leave a receipt, where the opposite would let a
  // command that acted leave none. Splitting the record per dotted method would buy the stop back and
  // is worth doing the day one of these groups gains a member that reads rather than writes.
  handoffs: true,
  sessionTasks: true,
  // DEGRADES.
  repairTargetFor: false,
  repairOnce: true,
  lang: false,
  chatPending: false,
  // LOCAL_WHEN_ABSENT — a read either way, from the app or from its file.
  listAccounts: false,
  listRunConfigs: false,
  // HOST_SESSIONS. Reading a screen twice leaves it as it was; typing twice types twice.
  listSessions: false,
  readSession: false,
  sendSession: true,
  readChat: false,
  // HOST_WHEN_ABSENT — a turn, on either route.
  chatSend: true
}

/** The names an action really travels under, narrowed to the effectful ones — the NESTED groups
 *  expanded to the dotted names `a.act` is called with. Built once at module load: the funnel looks
 *  a name up here, and the answer cannot depend on which call is running. */
const EFFECTFUL_ACTS: ReadonlySet<string> = new Set<string>([
  ...REMOTE.filter((name) => EFFECTFUL[name]),
  ...Object.entries(NESTED).flatMap(([group, methods]) =>
    EFFECTFUL[group as keyof typeof NESTED] ? methods.map((m) => `${group}.${m}`) : []
  )
])

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
  /** `reset`'s one safety net: the state file copied aside before it is wiped. The Host's own store
   *  does it — see OWNED for why it stopped being the app's. */
  backup(): Promise<void>
  act(name: string, args: unknown[]): Promise<unknown>
  hasApp(): boolean
  /** The Host's log. Passed on as `OrchServerDeps.log` as well, so that every `deps.log?.()` the
   *  command layer already writes — the limit probe that could not run, a task-update that bypassed
   *  the transition table — lands somewhere a person can read it. Without it the Host's command layer
   *  degrades silently, which is the one thing a degradation must not do. */
  log(message: string): void
  /** Called when a **PROPAGATES** action (or a HOST_LOCAL one that falls back to that route) could not
   *  be put to the app — none attached, or the one that was did not answer — or when the Host itself
   *  refused for want of the app. That last case carries `detail` (so the log says the Host refused,
   *  not that the app was asked), and a profile file only the app can repair (`RepairNeeded`) rides
   *  in it as `repair`. `orch.ts` answers that call CONFLICT on the strength of this, rather than by
   *  matching text in the reply. Never called for the other three groups — SWALLOWED, FIRE_AND_FORGET
   *  and DEGRADES: their refusal does not decide what the command answers. */
  onAppRequired(name: string, why: string, detail?: { repair?: string; retry?: string }): void
  /** Called when this command is about to ask the app for something that **changes something outside
   *  the state** — the other half of "did this call do anything", beside the commit flag (request
   *  receipts design §3). Optional: a caller that does not record receipts leaves it out, and the
   *  funnel below then costs one `Set` lookup on the acts that really go out.
   *
   *  **Before the action, not after it.** `a.act` rejects when the app goes away mid-question or
   *  holds it past the deadline, and neither says the app did not do it — a request that may have
   *  landed has to read as one that did. */
  onEffect?(): void
  /** `listAccounts` answered from the profile's accounts.json (LOCAL_WHEN_ABSENT). Rejects when the
   *  file cannot be read, with a message that says how to repair it. */
  readAccounts(provider?: Provider): Promise<OrchAccount[]>
  /** `listRunConfigs` answered from the profile's run-configs.json and the project folder
   *  (LOCAL_WHEN_ABSENT). Rejects when the file cannot be read, with a message that says how to repair it. */
  readRunConfigs(projectPath: string): Promise<OrchRunConfig[]>
  /** The Host's own sessions (HOST_SESSIONS), out of its two registries (`host/sessions.ts`), and
   *  the local half and the per-session order of `chatSend` (HOST_WHEN_ABSENT). */
  sessions: HostSessions
  /** The Host's own spawner (HOST_LOCAL), or null/absent for a Host started without the CLI paths —
   *  then the nine names take their pre-S2 routes. */
  local?: HostLocal | null
}): OrchServerDeps {
  const refusal = (name: string): AppUnreachable =>
    new AppUnreachable(`APP_REQUIRED: ${name} needs the Astera app running`)

  /** **The one funnel every app-side action goes through**, and the reason the receipt rule can be
   *  "did this call act" rather than a hand-kept list of command names: the three wrappers below all
   *  end here, so a dependency cannot be forwarded without passing this line. A name that never
   *  reaches it — the app is not attached, so `forward` throws first — really did not act. */
  const act = (name: string, args: unknown[]): Promise<unknown> => {
    if (EFFECTFUL_ACTS.has(name)) a.onEffect?.()
    return a.act(name, args)
  }

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
        return await act(name, args)
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
  const degrading = (name: string, fallback: (why: string) => unknown) =>
    async (...args: unknown[]): Promise<unknown> => {
      try {
        if (!a.hasApp()) throw refusal(name)
        return await act(name, args)
      } catch (err) {
        if (!(err instanceof AppUnreachable)) throw err
        const value = fallback(err.message)
        // Logged every time. A Gate that opened, or a retry that did not happen, because the app was
        // unreachable has to be traceable to that — otherwise it reads as a verdict about the work.
        // Except where no app is the ordinary state and the fallback says so by itself (QUIET_ABSENT).
        if (a.hasApp() || !QUIET_ABSENT.has(name))
          a.log(`${name} could not be asked (${err.message}) — answering ${JSON.stringify(value)}`)
        return value
      }
    }

  /** Same forwarding, but a question that could not be put to the app is answered by `local` — see
   *  LOCAL_WHEN_ABSENT. A failed local read is the app being required after all: it is flagged and
   *  thrown as `AppUnreachable`, carrying the reader's own reason — and, for a file only the app can
   *  repair, which file (`repair`). */
  const localWhenAbsent = (
    name: (typeof LOCAL_WHEN_ABSENT)[number],
    local: (...args: never[]) => Promise<unknown>
  ) =>
    async (...args: unknown[]): Promise<unknown> => {
      const fromFile = async (why: string): Promise<unknown> => {
        try {
          const value = await local(...(args as never[]))
          a.log(`${name} answered from ${LOCAL_FILE[name]} (${why})`)
          return value
        } catch (err) {
          const refused = new AppUnreachable(
            `APP_REQUIRED: ${name} could not be answered without the app: ${err instanceof Error ? err.message : String(err)}`
          )
          a.onAppRequired(name, refused.message, err instanceof RepairNeeded ? { repair: err.file } : {})
          throw refused
        }
      }
      if (!a.hasApp()) return fromFile('no app attached')
      try {
        return await act(name, args)
      } catch (err) {
        if (!(err instanceof AppUnreachable)) throw err
        return fromFile(err.message)
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
      void act(name, args).catch((err) => a.log(`${name} failed in the app: ${String(err)}`))
    }

  /** HOST_WHEN_ABSENT: to the app when one is attached, else the Host's own write — see that group
   *  for why an app that fails mid-flight is refused rather than written for. */
  const askPending = degrading('chatPending', DEGRADES.chatPending)
  const hostWhenAbsent = (name: (typeof HOST_WHEN_ABSENT)[number]) =>
    (id: string, text: string): Promise<unknown> =>
      a.sessions.serial(id, async () => {
        if (a.hasApp()) {
          const pending = await askPending(id)
          if (pending === undefined) return { sent: false, reason: 'not-held' }
          if (pending !== null) return { sent: false, pending }
          return forward(name, true)(id, text)
        }
        try {
          await a.sessions.sendChat(id, text, () => {
            if (EFFECTFUL[name]) a.onEffect?.()
          })
        } catch (err) {
          const refused = new AppUnreachable(
            `APP_REQUIRED: ${name} could not be done without the app: ${err instanceof Error ? err.message : String(err)}`
          )
          a.onAppRequired(name, refused.message, {})
          throw refused
        }
        a.log(`${name} written by the Host (no app attached)`)
        return { sent: true }
      })

  /** HOST_SESSIONS: the Host's own answer, marked as an effect before it runs when it is one. */
  const own = <K extends (typeof HOST_SESSIONS)[number]>(name: K): HostSessions[K] => {
    const fn = a.sessions[name] as (...args: unknown[]) => unknown
    return ((...args: unknown[]) => {
      if (EFFECTFUL[name]) a.onEffect?.()
      return fn(...args)
    }) as HostSessions[K]
  }

  /** HOST_LOCAL: the spawner's answer when it owns this call, otherwise the route the name had before
   *  S2. A local `RepairNeeded` is flagged with its file the way a propagating forward is flagged, a
   *  `HostRetiring` with `retry`, and a local `AppUnreachable` as it is — only for the names that
   *  propagate, since a swallowed failure must not decide the status. */
  const hostLocal = (name: HostLocalName) => {
    const propagates = HOST_LOCAL_FALLBACK[name] === 'propagates'
    const fallback = forward(name, propagates)
    return async (...args: unknown[]): Promise<unknown> => {
      const local = a.local
      if (!local || !local.owns(name, args)) return fallback(...args)
      if (EFFECTFUL[name]) a.onEffect?.()
      try {
        return await (local[name] as (...xs: unknown[]) => Promise<unknown>)(...args)
      } catch (err) {
        if (propagates && err instanceof RepairNeeded) a.onAppRequired(name, err.message, { repair: err.file })
        // A Host that is leaving refuses new starts; the caller retries once a Host is up (ruling a).
        if (propagates && err instanceof HostRetiring) a.onAppRequired(name, err.message, { retry: HostRetiring.RETRY })
        // The Host refused on its own for want of an app it could not ask (host/worktrees.ts: an
        // app running but not attached): the same conflict as an app that could not be reached.
        if (propagates && err instanceof AppUnreachable) a.onAppRequired(name, err.message, {})
        throw err
      }
    }
  }

  const remote = Object.fromEntries(
    REMOTE.map((name) => {
      if ((HOST_LOCAL as readonly string[]).includes(name)) return [name, hostLocal(name as HostLocalName)]
      if ((FIRE_AND_FORGET as readonly string[]).includes(name)) return [name, forgetful(name)]
      if (name in DEGRADES) return [name, degrading(name, DEGRADES[name as keyof typeof DEGRADES])]
      if (name === 'listAccounts') return [name, localWhenAbsent(name, a.readAccounts)]
      if (name === 'listRunConfigs') return [name, localWhenAbsent(name, a.readRunConfigs)]
      if ((HOST_WHEN_ABSENT as readonly string[]).includes(name))
        return [name, hostWhenAbsent(name as (typeof HOST_WHEN_ABSENT)[number])]
      return [name, forward(name, (PROPAGATES as readonly string[]).includes(name))]
    })
  )
  // The dotted names (NESTED). Built as real objects because that is the shape the command layer
  // checks before it calls — `if (!deps.sessionTasks) return conflict(...)` — so an object whose
  // methods happen to travel is what keeps those guards reading the way they always did.
  const nested = Object.fromEntries(
    Object.entries(NESTED).map(([group, methods]) => [
      group,
      Object.fromEntries((methods as readonly string[]).map((m) => [m, forward(`${group}.${m}`, true)]))
    ])
  )
  return {
    getState: a.getState,
    setState: a.setState,
    now: a.now,
    log: a.log,
    runningSessions: a.runningSessions,
    appVersion: a.appVersion,
    backup: a.backup,
    listSessions: own('listSessions'),
    readSession: own('readSession'),
    sendSession: own('sendSession'),
    readChat: own('readChat'),
    ...remote,
    ...nested
  } as unknown as OrchServerDeps
}
