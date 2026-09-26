# Host S2 to S6: Jobs advance with the app closed

Design only. No code was changed. Written 2026-09-23 against `develop` at `afab43f`, with Track A's
uncommitted edits present in the working tree (`src/core/orchestration/command.ts`,
`src/host/index.ts`, `src/host/server.ts`, `docs/cli.md`). Every `file:line` below is from that
working tree. Line numbers in `command.ts` and `src/host/index.ts` may move when Track A lands.

Binding context: `docs/2026-09-22-host-control-plane-design.md` §2 (the slice table and the S5 trap),
§5 (S2 to S4 make dependencies local while `handleCommand` stays unchanged), §12.3 (the S5 question
belongs to S4's design). The S1 ledger rulings F21 to F72 are assumed; the ones this design leans on
are named where they matter.

## Decisions (2026-09-24)

Taken with the user after the draft, and binding on every slice below. §10 keeps the options and the
reasoning; this list is what was chosen.

| | Decision | Chosen | By |
|---|---|---|---|
| D1 | The S5 trap | S5 (validation, review, repair) moves **with** S4, in the same release | user |
| D2 | Scheduled Jobs with the app closed | Fire only while an app is attached, as today (superseded 2026-09-25, see Amendments A80: the Host now fires whenever it drives, app or not) | user |
| D3 | Owner of `worktrees.json` | The Host; the app writes through it | controller, the draft's recommendation |
| D4 | Worker environment | The Host's own environment minus a documented strip list | user |
| D5 | New app, old Host holding work | The app keeps today's loop until that Host is replaced | controller |
| D6 | A worker lost to a Host restart with no journal | Open a Gate at load | controller |
| D7 | A usage limit with no app | A Gate carrying the reset time, so `runs wait` ends with 8 (left out of S4+S5 by the user; S6, see Amendments A58; replaced in S6 by the `limited` ending with no Gate, see Amendments A68; the coordinator's own wait counts too, see Amendments A74) | controller |
| D8 | Journal and reconciler | Stay in the app (reversed 2026-09-26 by the Host journal, A125) | controller |
| D9 | A second app | Left as S1 recorded it | controller |
| D10 | Release shape | S2 and S3 merge separately; S4 and S5 release together | controller |
| D11 | `jobs run` with no Host | Keep exit 3 and point at `astera host start`; no auto-start | controller |
| D12 | Permission mode with no settings file | The app's default | user |

D4 has a consequence the docs must carry: a Host started from a CI shell hands that shell's variables,
secrets included, to the agents it spawns, exactly as an app started from that shell would.

## Amendments (2026-09-24, after S2 shipped)

S2 landed on `develop` at `2354267`. Its plan and review rulings changed some statements below, and
those rulings were recorded only in working notes outside the repository. This list is the record.
The sections themselves keep their original text; each statement that is no longer true carries a
short note pointing here. The later slices build on this list, not on the original sentence. Each
entry gives the section, what it said, what shipped, why, and the tests that pin it.

**Exits**

- **A1. §2.6, the exit owner.** It said: while an app is attached the app handles session exits, and
  while none is the Host does. What shipped is an owner per pty. A pty belongs to the socket that
  sent `pty-spawn` or `pty-attach` for it, **whatever role that socket declared**; the Host handles
  the exit of every other `kind: 'session'` pty after the same `EXIT_DEFER_MS`, and
  `releaseCoordinator` follows the same owner. Why: the original rule loses the exit of a
  Host-spawned worker that dies before the app adopts it, and every exit while an older app that
  ignores `pty-opened` is attached (plan ruling R2). A role check would also let the Host handle
  the exits of apps v1.3.17 to v1.3.25, which say `hello` with no role, and so write
  `orchestration.json` behind an app that writes it too. Rolls still happen only on ptys an app
  holds, so the safety reason of §2.6 stands. A coordinator slot is not cleared on a `-1` exit.
  Pinned by `src/host/exits.test.ts` and `src/core/orchestration/exec/exitOwner.test.ts`.
  (amended for S6, see Amendments A69: rolls now happen in the Host too; and A72: an exit that a roll
  caused)
- **A2. §2.6, the handover sweep.** It said: each time ownership passes to the Host, every open
  Dispatch whose session is not alive in its registry goes through `handleExit`. What shipped runs
  the sweep only when a socket that has held a pty closes (a CLI socket never runs one), after the
  defer, and only over sessions the registry holds as ended. A session the registry never held is
  skipped and left to the next `store.load` (plan ruling R3), because its exit code is unknown here;
  an app-local node-pty worker from the unresponsive-Host fallback is that case. To tell the two
  apart, `PtyRegistry.sessionExitCode` answers `{ code: number | null } | null`, where null means
  still alive or never here. A pty that ended with no code is handed on as `ENDED_WITHOUT_A_CODE`
  (`-2`), not `-1`, because `-1` is `PTY_LOST_SIGHT_EXIT_CODE` and `handleExit` keeps a Dispatch open
  over it. Pinned by `src/host/exits.test.ts` and `src/host/registry.test.ts`.
- **A3. §2.6 and §8.2 step 5, exits the app owns before it can handle them.** Not stated before.
  The app's startup sweep adopts sessions before `bootOrch` has built its roll tap, so an exit in
  that gap would be handled by nobody. The app queues such exits (`ExitsBeforeTap`, at most 256) and
  hands them on once the tap exists. And the Host answers a `pty-attach` for a pty that already
  ended with that pty's `pty-exit`, so a worker that died just before its adoption does not show as
  running. Pinned by `src/main/orchestration/rollTap.test.ts` and `src/host/ptyHost.test.ts`.
  Known gap: an app whose `bootOrch` returns early or throws never builds the tap, and holds its
  adopted workers' exits until it quits (the handover then closes them) or until the next load.

**Spawning, reading and stopping**

- **A4. §2.1 and §7.3, the app keeps its own spawn path.** §2.1 said the app keeps its copy of the
  spawn path for one purpose only, a Host that does not announce `spawn`. In S2 the app also spawns,
  through the shared `startWorkerWithChain`, for its own scheduler's starts and for every
  `worker-start` with `worktree: 'new'` and no terminal, because the Host creates no worktree until
  S3. The Host's `owns(name, args)` answers false for those, for a `--terminal` it does not hold,
  and for the release of a session it does not hold, and such a call takes its old route
  (`APP_REQUIRED` with no app attached; plan ruling R1). S3 removes the worktree case (done, see
  Amendments A22 and A24) and S4 the scheduler's. Pinned by `src/host/spawner.test.ts` and
  `src/host/orchDeps.test.ts`.
- **A5. §1.4, `readWorker` after a roll.** The table makes `readWorker` Host-local in S2. The Host
  answers it only for a Dispatch it started, while that Dispatch still names the session it started
  on (or a `pending:` id). Once a roll has moved the Dispatch to another session, the call goes to
  the app, which holds the tail that followed the roll. Why: the Host's tail stops at the roll, and
  reads of it froze (reproduced). Pinned by `src/host/spawner.test.ts`. (amended for S6, see
  Amendments A70: the Host's tail now follows the rolls the Host makes)
- **A6. §2.3, how the app takes a `pty-opened` session.** It said the handler is the reattach
  sweep's per-entry body applied to `m.entry`. What shipped queues a sweep limited to that one pty
  id, over a fresh `pty-list`, through the same queue as every other sweep. Why: an exit that lands
  between the push and the sweep is then already in the list, so a dead pty is never adopted as
  running, and its exit stays the Host's because nothing sent `pty-attach` for it. Pinned by
  `src/main/host/reattach.test.ts`.
- **A7. The app's Stop button, not stated before.** The app answered its own `worker-stop` with
  `core.sessions.kill`, which does nothing for a session the app does not hold. Since S2 that is a
  real case, a Host-spawned worker the app has not adopted yet, and Stop marked it stopped while it
  kept working (reproduced). What shipped: for a session the app does not hold running, the app
  forwards `pty-kill` to the Host, and the stop counts only when the Host's `pty-exit` for that pty
  arrives or a fresh `pty-list` no longer shows it alive. With neither, the stop is refused, the
  Dispatch stays open, and the refusal is shown in the toast. A `worker-stop` the Host answers
  kills through its registry and marks the Dispatch stopped at once; ConPTY's close is synchronous
  and a kill that throws rejects the command first, so this asymmetry is recorded, not a known
  failure. Pinned by `src/main/orchestration/stopWorker.test.ts`.
- **A8. §8.1 row 1, stopping a start in flight, not stated before.** `worker-stop`, `runs-stop`,
  `run-delete` and `run-pause` refuse with 409 and write nothing while an open Dispatch's session is
  still a `pending:` id and its `startedAt` is less than `PENDING_START_WINDOW_MS` (2 minutes) ago.
  An older placeholder is a start that died, and the stop closes it with nothing to kill. Why:
  recording a still-starting worker as stopped leaves a live agent on a closed Dispatch, and the
  next `--retry-of` puts a second agent in the same worktree; but refusing forever left a dead
  start that nothing could close. A test pins that the window stays above the spawn deadline plus
  the coordinator's idle wait. Pinned by `src/core/orchestration/command.test.ts`.
- **A9. §2.8, the busy signal.** It said the hook state is the second opinion, `working` counting as
  busy. What shipped is the `BusyScanner` alone, gated by `busyTitleReliable` (plan ruling R4).
  Why: `OrchCoordinator.isBusy` is synchronous while the hook state is a file read, and the app's
  `orchIsBusy` uses the scanner alone; parity between the two spawners is the first risk in §11.

**Environment and settings**

- **A10. §2.2, the permission mode.** It said: read from `app-settings.json`, default `yolo`. What
  shipped: a missing file gives `yolo` (D12 as chosen), and a file that exists but cannot be read
  **refuses the spawn**. The readers throw a typed `RepairNeeded` naming the file, and the Host
  answers 409 (exit 6) with `details.repair` and empty `nextSteps`, because no command opens Astera
  and the message says so. The same refusal covers a damaged `accounts.json`, `run-configs.json` or
  skills settings on a Host-local call. The mode is read at every spawn, never cached. The app's
  own recovery of a damaged settings file now writes `manual` back (keeping the `.bak`) and tells
  the person once with a notice that stays, where it used to reset to `yolo`. Why: reading a
  damaged file as the default would raise a person's `manual` choice to bypass. Pinned by
  `src/core/settings/agentPermissionMode.test.ts`, `src/host/spawner.test.ts`,
  `src/host/orchDeps.test.ts` and `src/main/appSettingsStore.test.ts`.
- **A11. §2.2, what the Host's own start strips.** `NOT_INHERITED` used to strip the whole
  `CLAUDE_CODE_` prefix when the Host was started. It now strips only the parent session's identity
  keys, one list shared with `cliEnvFor`, so settings such as Bedrock or OAuth reach Host workers as
  they reach app workers. The Host's start also drops any `ASTERA_HOST_*` the caller's environment
  carried, so a Host whose caller could not name the paths never spawns with an ancestor's. The worker strip
  list (`HOST_ONLY_ENV`) is as §2.2 describes it. Pinned by `src/core/host/spawn.test.ts`.
- **A12. §2.2, checking the three paths in a packaged install.** The Host checks each path before it
  announces `spawn`, and a path inside `app.asar` is checked as the archive file up to `.asar`,
  because plain `node.exe` cannot see inside the archive. Without this every packaged Host would
  turn `spawn` off. Pinned by `src/core/host/spawn.test.ts`.
- **A13. §1.3 and §9.1, placement.** `StatusLineManager` moved to `src/core/sessions/statusline.ts`,
  not to `exec/`, because non-orchestration app code uses it, and `init()` stays as the app's
  composition of `ensureFiles()` and `startupCleanup()` (plan ruling R5). S2 has no Host path guard
  (plan ruling R7); the one §9.1 lists is the validation runner's guard of §5.1 and belongs to S5.

**Retire and the Host's death**

- **A14. §8.4, replacement mid-spawn.** The rule shipped as written: the retire handler waits for
  spawns in flight, bounded by `SPAWN_DEADLINE_MS` (20 s, now in `src/core/host/unresponsive.ts`),
  and starts no new ones. Three things were added. A start refused while the Host leaves is a typed
  `HostRetiring`, answered 409 (exit 6) with `details.retry`, and the CLI says to run the same
  command again; `worker-start` rolls its Dispatch back. From the moment it starts leaving, the
  server destroys every new connection on arrival and keeps serving the sockets it has, so a
  replacing app does not attach to the leaving Host again; a new CLI process therefore meets a
  hang-up (exit 3), and only a caller connected before the retire gets the 409. And `astera host
  stop` waits `HOST_STOP_WAIT_MS`, 35 s (the 20 s settle plus the 15 s unresponsive verdict), for
  the retire reply. Measured on Windows: the app settles on the new Host about 33 s after the
  retire. Pinned by `src/host/server.test.ts`, `src/host/spawner.test.ts` and `src/cli/host.test.ts`.
- **A15. §8.1 row 2 and §9.1, measured.** A Host-spawned worker dies with the Host: `Stop-Process`
  on the Host we started ended its worker (end-to-end run, 2026-09-24, dev build). The packaged path
  (`node.exe` Host, asar entry, shuttle) was not run end to end.

**Accepted risks, recorded**

- **A16. Codex rollout swap (R-S2-10).** For about one second around the app adopting a Host-spawned
  codex pty, the Host's locate loop and the app's watcher both scan the same account and cwd. Two
  codex sessions in that bucket at that instant could swap rollouts. The cost is misattributed
  telemetry, not lost data. Accepted for S2; revisit if seen.
- **A17. One headless `conhost.exe` per pty that exits by itself.** node-pty 1.1.0 closes the pseudo
  console only when a live pty is killed, so a pty whose process ends on its own leaves its conhost
  until the Host exits (measured: three natural exits left three, a kill left none). This predates
  S2, but S2 makes Hosts that live long with the app closed more common. Released and stopped
  workers are killed and leak nothing. A follow-up beside S3's cap on registry growth.
- **A18. §7.3 row 3, an old app's Stop button.** An S1-era app attached to an S2 Host ignores
  `pty-opened`. Until its next sweep adopts a Host-spawned worker, its Stop button runs a kill that
  does nothing and records the Dispatch stopped while the worker runs. The fix of A7 lives in the
  new app and cannot reach an old one. Rare, because it needs a downgrade or a newer CLI's
  `host start`.
- **A19. No `PROMPT_WRITE_*` journal rows for Host-spawned workers (plan ruling R9) (lifted by A131).** The journal
  is the app's (D8). This holds with the app attached too, not only with it closed. Recovery reaches
  the same decision, `redispatch/safe`, but its reason reads `promptNeverLeft`, which is untrue for
  these workers. For the S4 notes.

## Amendments (S3 as shipped)

S3 landed on `develop` at `03b75be` (Task 9 shipped). Its plan and its execution ledger
(`.superpowers/sdd/2026-09-24-host-s3/progress.md`) changed or added to some statements above, and this
list is the record, in A1's form. `§3.4`, `§3.5`, `§7.2` and `§7.3` row 3 each carry a short note
pointing here at the sentence it replaces.

**Worktrees, who owns them**

- **A20. §3.4 and §7.2, D3's two added messages (plan ruling R1).** The design named three internal
  `orch-call`s the app would use to write through the Host, `worktree-add`, `worktree-remove`,
  `worktree-root`, and left out how the app's mirror would learn what the Host wrote on its own. What
  shipped adds the two pieces the design left out: an internal `orch-call` `worktree-list`, which fills
  the mirror at every handshake the way `state-get` fills the orch mirror (`src/host/worktrees.ts:42,
  284-305`, routed at `src/host/orch.ts:919,932`), and a push `{ t: 'worktrees-state', seq, file }`
  after every Host write (`src/core/host/protocol.ts:308`, sent from `registry.onChange` at
  `src/host/worktrees.ts:95-98`). Why: without a fill and a push, a worktree the Host made while the
  app was open would be missing from the Explorer panel and its Delete would answer `NOT_MANAGED`.
  Pinned by `src/host/worktrees.test.ts` and `src/main/host/worktreeRoute.test.ts`.
- **A21. §3.4, every registry write is read-modify-write (plan ruling R2).** The design named the
  two-writer problem and recommended the Host own the file; it did not say how a write avoids losing
  an entry another process just added. What shipped: `WorktreeRegistry.add`, `removeEntry` and
  `setRoot` all re-read the file before they apply (`mutate`, `src/core/worktrees/registry.ts`), in
  both processes, and a write's re-read refuses on a damaged file (`RepairNeeded`) rather than healing
  it, which only `load()` at a process start does (A26). Why: two registries on one file, each adding
  an entry, both survive only if neither rewrites the other's entry away; the design's own §9.2 test
  names exactly this failure on the code before S3. Pinned by
  `src/core/worktrees/registry.test.ts`, describe block "one worktrees.json, more than one writer".
- **A22. §3.4 and §7.2, `hello.yields` decides who owns worktree operations (plan ruling R4).** The
  design did not say what happens when an app from before this feature attaches to an S3 Host. What
  shipped: the new app says `yields: ['worktrees']` in its `hello` (`src/main/host/client.ts:505-512`);
  the Host remembers each socket's `yields` and answers `appKeeps(duty)`
  (`src/host/server.ts:187-189,452-454`); the spawner's `owns` answers `--worktree new`,
  `makeRunWorktree`, `mergeWorktrees` and `removeWorktrees` for itself only when no attached app keeps
  worktrees for itself (`src/host/spawner.ts:525-527`). An app that says nothing (one from before S3,
  or a role-less app v1.3.17-25) keeps doing its own worktree work, exactly as before S3. Why: such an
  app writes `worktrees.json` whole from its own memory and does not understand `git-op`, so a Host
  that forked or merged behind it would have its entry erased and its merge recorded as an outside
  change. Pinned by `src/host/spawner.test.ts`, `src/host/server.test.ts` and
  `src/main/host/client.test.ts`.
- **A23. §3.1, `worktrees` is announced only by a Host with a spawner (plan ruling R5).** Not stated
  before. What shipped: `src/host/index.ts` announces `features: [HOST_FEATURE_SPAWN,
  HOST_FEATURE_WORKTREES]` only when it built a spawner, the same one fact `spawn` itself is (S2). Why:
  a Host with worktrees and no spawner would create a Run worktree in `run-start` and then fail
  `startCoordinator` with no app, leaving a registered worktree no Run records on every retry. Not
  pinned by a dedicated test; read directly from `src/host/index.ts:249,295`, the way A15 was measured
  rather than pinned.
- **A24. §3.5, what the app becomes for worktrees, and what moved (plan ruling R6).** The design read
  as if the whole scheduler moved with `run-merge`. What shipped: only the three deps
  (`makeRunWorktree`, `mergeWorktrees`, `removeWorktrees`) and `--worktree new` move to the Host
  (`src/host/orchDeps.ts:258-261`); the app's `runScheduler` keeps its own lazy Run-worktree fork, its
  integration merge and its child-run reap in `src/main/ipc.ts` until S4, now pointed at
  `src/core/orchestration/exec/integrateGit.ts`, with their registry writes going through the Host
  (A21). `run-merge` becomes Host-local exactly as the design said, because the CLI's `run-merge`
  already reached `handleCommand`'s `mergeWorktrees` dep, which is one of the three that moved. Pinned
  by `src/host/orchDeps.test.ts` and `src/core/orchestration/command.test.ts`'s `run-merge` suite.
- **A25. §3.1, the Host's `isPathInUse` (plan ruling R8).** The design said the Host answers from its
  registry; it did not say the registry only has entries for session ptys. What shipped:
  `PtyRegistry`/`ProcRegistry` keep the `cwd` each entry was spawned with, tagged `SESSION:<title or
  id>` for a session, terminal or chat, and `RUN:<configName or id>` for a run, matching the app's own
  tags (`src/host/worktrees.ts:140-156`). Why: without a `cwd` on every kind, the Host would treat a
  live run or a shell tab in the folder as free to delete under. Pinned by `src/host/worktrees.test.ts`.
- **A26. §3.4 and §9.2, a damaged `worktrees.json` (plan ruling R10).** The design said the Host
  recovers a damaged file the way the app does, `.bak` then an empty list, because refusing would leave
  every worktree operation stuck. Task 1's review found that instinct wrong when applied to *every*
  read: healing on every read means a file damaged mid-life is wiped without warning. What shipped
  instead: only `load()`, run once at Host start and only when the Host can spawn
  (`src/host/worktrees.ts:318-320`, `loadWorktreesIfSpawning`, `src/host/worktrees.ts:374-386`), keeps
  `.bak` of the bytes it read and rewrites the file; every later read or write goes through
  `refresh()`/`readForWrite()`, which throws `RepairNeeded` rather than healing
  (`src/core/worktrees/registry.ts:183-184,234-254`), and the Host answers it as a 409 naming the file
  to repair (`src/host/worktrees.ts:346-357`). The app's own fallback from Host to local mirrors this:
  it calls the registry's queued `refresh()`, not `load()`, so a file damaged while the Host owned it
  is not silently wiped the moment the app takes the file back (`src/main/host/worktreeRoute.ts`, Task
  9 ruling I3). Why `load()` only at start: healing rewrites the list, and doing that in the middle of
  a Host's life would erase entries nobody asked to lose. Pinned by
  `src/core/worktrees/registry.test.ts` and `src/host/worktrees.test.ts`'s `RepairNeeded` suite.
- **A27. §3.2, rules 1-11 move with tests, 12-14 stay (plan ruling R11).** What shipped exactly as
  ruled: rules 1 through 10 (never merge into an unreachable folder, onto a detached HEAD,
  mid-operation, over tracked changes; branch matching; the git-version pre-check; probe-then-merge;
  `--no-edit`; abort on failure; counting uncommitted changes) and rule 11 (reap only registered
  worktrees with no held or working session) moved verbatim into
  `src/core/orchestration/exec/integrateGit.ts` and gained their first tests there. Rules 12 and 13
  (`isIntegrationTask`, `integrationTaskFor`, `workingInRunRoot`) stay the app scheduler's, in
  `src/main/ipc.ts` and `src/core/orchestration/integrate.ts`. Rule 14 (a worker never runs in the
  project folder of an app-driven Run) stays `handleCommand`'s, in
  `src/core/orchestration/command.ts:1850-1858`. Why: rules 12-14 are about *when* the scheduler or
  `handleCommand` may call the merge, not about the merge itself, and neither moves to the Host until
  S4. Pinned by `src/core/orchestration/exec/integrateGit.test.ts`,
  `src/core/orchestration/integrate.test.ts` and `src/core/orchestration/command.test.ts`.
- **A28. §3.3, a Host merge made with no app attached (plan ruling R13).** The design's `git-op`
  message covers only a merge made while an app is attached. What shipped matches the plan's own
  recording of this as a known gap, not a design change: a Host merge with nobody attached is announced
  to nobody, and the next app to open compares the project's stored snapshot against its HEAD
  (`src/main/workUnit/collector.ts:1326-1332`, `gitRound`) and records the move as an outside change if
  that project had a snapshot. Why: a persisted Host git-op journal would be new design, not this slice's.
  Not yet measured as of this task; Task 11 measures it. No test pins this; it is the documented cost
  of not building that journal.
- **A29. §11, the carried items taken and not taken (plan ruling R14).** M4 (registry growth) is
  taken: `PtyRegistry` and `ProcRegistry` each keep at most `DEAD_ENTRIES_KEPT = 64` ended non-session
  entries, dropping the oldest ended one first (`src/host/registry.ts:61,188,202,209`,
  `src/host/procRegistry.ts:112,150`); live entries and ended session entries are never dropped. M7
  (the spec pile-up) is not taken: a sweep during the Host's life would race every spawn in flight in
  both processes while the app still spawns its scheduler's workers, so it waits for S4, when the app
  yields `dispatch` and the Host becomes the only writer of `orch/specs`. Pinned by
  `src/host/registry.test.ts` and `src/host/procRegistry.test.ts`.
- **A30. `command.ts`'s `startCoordinator`, risk 6 (plan ruling R16, corrected).** The plan said
  `handleCommand` stays untouched and this gap, a coordinator that fails to start after `run-start`
  made its Run worktree leaves that worktree with no Run to record it, stays recorded but unfixed. The
  controller's own ruling on the plan's risk 6 reversed this before Task 7 began: "record the Run
  worktree before starting the coordinator, or remove it on start failure." What shipped: a new
  optional dep, `discardRunWorktree(path)`, called only when the coordinator's start throws, after the
  Run worktree was already made (`src/core/orchestration/command.ts:227,1400-1408`); the Host supplies
  a real one (`src/host/orchDeps.ts:649`) that best-effort removes the orphaned folder and is never
  marked as "needs the app" even when it is refused, so a coordinator failure never reads as a 409
  asking for Astera. The failed start still answers its own 400 whether or not the cleanup succeeded
  (fix round 1, I1). **This whole cleanup is new**, not something `run-start` always had: at 02bef5a a
  coordinator's start failure returned its 400 with no cleanup at all, and the fresh Run worktree was
  simply orphaned. The app's own code path has no `discardRunWorktree`, so it falls back to
  `removeWorktrees` alone when that is wired (`command.ts:1409-1420`), which is the same new cleanup
  minus the tag, not an older behaviour (final review m4). This duplication of the two branches is
  known and left for a later slice. Pinned by `src/core/orchestration/command.test.ts` and
  `src/host/orchDeps.test.ts`.

**Not in the design or the plan, found while building it**

- **A31. The detached-app guard.** While Astera runs, it writes its pid to `app.pid` in the profile
  and removes it on a clean quit (`src/core/host/pidFile.ts:79-95`, called from
  `src/main/index.ts:386,1397`). Before the Host removes a worktree folder, it checks that file: an app
  that is alive but not attached to this Host (one that gave up on a stalled Host, or has not
  reconnected since a restart) runs sessions the Host cannot see, so the removal is refused with 409
  (exit 6), `Astera is running but not connected to this Host; remove the worktree from the app, or
  quit Astera and retry` (`src/host/worktrees.ts:197-199,329-342`). A crashed app's stale pid is not
  read as alive: the check signals the pid, and a process that no longer exists reads as no app
  (`src/core/host/pidFile.ts:97-114`). Pid reuse is not guarded against, and that fails toward keeping
  the folder, the safe direction, at the cost of one manual quit-and-retry. The refusal is tagged
  `refusedBeforeActing`, so it leaves no request receipt; quitting Astera and repeating the same
  command with the same `--request-id` really removes the folder. A refusal that lands after some
  folders were already removed keeps its receipt, because the command acted before it failed. **Only
  an Astera from this version on writes `app.pid`**; a pre-S3 app running but not attached is invisible
  to this check (final review m1, "Known limits after S3"). Pinned
  by `src/host/worktrees.test.ts` and `src/core/host/pidFile.test.ts`.
- **A32. `worktreePathInUse` (the ruling on plan risk 3).** Before removing a folder, an attached app
  is asked `worktreePathInUse` (`src/core/host/protocol.ts:94-101`, `HOST_ACT_PATH_IN_USE`). The app
  answers with only what it runs itself through local, non-Host ptys: sessions, terminals, runs that
  have not exited, and chat sessions (`src/main/host/localPathInUse.ts`, `appPathInUse`). An app that
  does not answer, or answers something that is not a string or null, costs the removal: the folder is
  kept. Why: the Host cannot see a session the app is running on its own fallback pty, and this
  in-use check, together with the Host's own (A25), is what keeps a removal from touching a folder a
  live process is using, on every OS (final review m2; the plan's "Windows fails rather than deleting
  under a live process" is not something the code relies on). Pinned by
  `src/main/host/localPathInUse.test.ts` and `src/host/worktrees.test.ts`.
- **A33. `WorktreesSnapshot.seq` (review of Tasks 4-5).** Every `worktree-*` reply and the
  `worktrees-state` push carry `{ seq, file }`, one counter per Host life
  (`src/core/host/protocol.ts:72-89`, `src/host/worktrees.ts:82-85`). The receiver keeps the last `seq`
  it applied per connection, resets it on every refill from `worktree-list`, and ignores anything lower
  (`src/main/host/worktreeRoute.ts:43,49-51,106,126`). Why: without a counter, a Host restart's low
  numbers could roll back state a longer-lived push already advanced, or a reply racing a refill could
  apply out of order. Pinned by `src/main/host/worktreeRoute.test.ts`.
- **A34. `run-delete` on a scheduled Job, ordering that predates S3.** Not new to S3, but now reachable
  headless and worth recording here: `run-delete` on a Job that fires on a schedule closes its open
  workers and, if asked, merges its worktrees before it reaches the worktree removal S3 can refuse
  (`src/core/orchestration/command.ts:1200-1279`). After a 409 from `removeWorktrees`, nothing about
  the Job or its runs is deleted, but the workers are already closed and the merge has already
  happened. Documented in `docs/cli.md`.
- **A35. The Host forgets exited worker session records (Task 8).** The Host's `SessionManager` drops
  an exited session's record on its exit (`src/host/spawner.ts:238`, `sessions.forget`,
  `src/core/sessions/manager.ts:483`), unlike the app's, which keeps one so a session can be resumed.
  Why: a long-lived Host would otherwise grow one record per worker for as long as it runs. Pinned by
  `src/host/spawner.test.ts`.

**Follow-ups after S3 shipped**

- **A36. Receipts over failed starts that left nothing (A30's cleanup, and the same cleanup for
  `--worktree new`).** A30 said: a coordinator failure in `run-start` best effort removes the fresh Run
  worktree, and the command had already marked its effect through the `makeRunWorktree` that made
  the folder. So a keyed `run-start` whose coordinator failed kept its request receipt even when the
  folder was removed again and no process ran, and a retry with the same `--request-id` after the
  cause was fixed (a damaged `app-settings.json` repaired, say) replayed the old failure instead of
  starting. And a `worker-start --worktree new` whose spawn failed after the fork left the forked
  folder on disk, with its Dispatch rolled back so nothing would ever target it. What shipped:
  - The effect marks are counted, not a flag (`src/host/orch.ts:420-429,447,466-471,781`), and
    `hostOrchDeps` gains `withdrawEffect` to take one back (`src/host/orchDeps.ts:458-464`).
  - `startCoordinator` joins `MARKS_AFTER_ACTING` (`src/host/orchDeps.ts:291-294`). The Host spawner
    tags every failure that came before a pty was opened as `refusedBeforeActing`: the settings
    refusal, an unknown account, a spawn the registry refused, and a retiring Host
    (`src/host/spawner.ts:457,555-579`). Whether a pty was opened is read from a count the pty factory
    moves, taken around the synchronous `sessions.spawn` (`src/host/spawner.ts:225,379-399`), so it
    answers for that one call even with other starts in flight. A failure after a pty opened is not
    tagged, and stays marked.
  - A `discardRunWorktree` that answers `removed: true` withdraws the one mark that this same call's
    `makeRunWorktree` made for that path (`src/host/orchDeps.ts:672-685`). A folder left in place, in
    use or not removable, keeps its mark.
  - The fork of a `--worktree new` start is removed again when the start fails before any pty opened
    (`src/host/spawner.ts:492-554`, with the folder recorded at `:431-435`), best effort and logged, with the start's own error thrown
    unchanged: the risk 6 pattern. Only when the folder is gone is the error tagged with the new
    `undoneBeforeFailing` (`src/core/host/orchProtocol.ts:34-84`), and then `hostLocal` withdraws the
    mark it made before `startWorker` ran (`src/host/orchDeps.ts:644`).
  - `worker-start` commits its Dispatch before it starts the worker, so a withdrawn effect alone still
    left a receipt. Its failure rollback now says it is one (`setState(next, { rollsBack: true })`,
    `src/core/orchestration/command.ts:146-151,1960-1978`) when, and only when, the start's error says
    it left nothing (`leftNothingBehind`). The Host counts that commit as taking back the first. That
    tag also covers a start the Host refused before touching anything: a retiring Host, or a fork
    refused by a damaged `worktrees.json`, so those keep no receipt either. Every other failed
    `worker-start` keeps its receipt as before, including one refused for want of the app, which the
    receipts design pinned on purpose (`src/host/orch.test.ts:1258-1286`).

  The result: a failed keyed `run-start` whose worktree was removed and whose coordinator started no
  process keeps no receipt, and neither does a failed `--worktree new` start whose fork was removed.
  One that left an orphan folder, or whose process did start, keeps its receipt. Why: a receipt over a
  call that left nothing replays a refusal to a retry the world has since made valid, the reason
  `refusedBeforeActing` exists (I2). **Host only.** The app path is unchanged: its fork runs through
  its own `forkWorktree`, and cleaning up there would need an in-use check the shared
  `OrchCoordinator` does not have, so the cleanup lives in the Host's own start wrapper rather than in
  shared code. **Found while checking, and not fixed:** `startCoordinator` cannot throw after its pty
  opened in practice, since everything after that point (the factory's announcement, whose failure is
  caught, the session bookkeeping, and the Host log, which never throws) does not throw. If it ever
  did, the coordinator would keep running while `run-start` answers 400, leaves the state unchanged
  and removes the Run worktree, so a live coordinator would be left with no Run naming it. The same
  holds for a worker whose start throws after its pty opened. The tests pin that such a failure stays
  marked. Pinned by `src/host/orch.test.ts` (the three keyed receipts through the real spawner) and
  `src/host/spawner.test.ts` (the tags, the fork removal, and the two cases that must keep their
  mark).

  **Follow-up round (review of A36).** Four changes, no change to the result above except the first:
  - A `worker-start` with no fork (`--worktree current`, or an explicit path) refused by the permission
    setting is tagged `refusedBeforeActing` too, since it comes before `sessions.spawn` and nothing was
    forked (`src/host/spawner.ts:368-377,545-551`). It keeps no receipt, and the retry after the repair
    starts. The same refusal after a fork that is still on disk stays untagged.
  - The tags go on a copy of the error, never on the caught object (`taggedCopy`,
    `src/core/host/orchProtocol.ts:36-57`). The spawner's `once()` setup promises hand every waiting
    start the same rejection, so a tag on that object could make a start whose fork is still on disk
    read as having left nothing. The copy keeps the class, message, stack, cause and own fields.
  - The wider effect (a retiring Host, and a fork a damaged `worktrees.json` refused) is pinned by
    tests, so it cannot flip back unnoticed.
  - cli.md says the no receipt case holds when the Host removes the worktree itself. When an older
    Astera that still keeps worktrees does the removal, the forwarded removal is marked as an effect
    and the receipt is kept, the safe direction.

  Pinned by `src/host/orch.test.ts` (the no fork settings refusal, the two retiring Host cases, the
  damaged `worktrees.json` fork, and two concurrent starts sharing one rejection),
  `src/host/spawner.test.ts` and `src/core/host/orchProtocol.test.ts`.

## Amendments (S4+S5 as shipped)

S4 and S5 landed together on `develop` (D1, D10), through Task 15 at `d80492c`. The plan
(`.superpowers/sdd/2026-09-24-host-s4s5/plan.md`, rulings R1 to R29 and the pre-flight rulings N1 to
N11) and its execution ledger (`progress.md` in the same folder) changed or added to some statements
above, and this list is the record, in A1's form. Every `file:line` is from `d80492c`. §4.1, §4.3,
§4.4, §4.6, §5.1, §6, §7.2, §7.4, D7 and "Known limits after S3" each carry a short note pointing here
at the sentence it replaces. What is still open is under "Known limits after S4+S5".

**Who drives**

- **A37. §4.3, the driver (plan ruling R1).** It said: `driver` is `'app'` when a `role:'app'` client
  is attached and its hello did not say `yields: ['dispatch']`. The server's `appKeeps` looks only at
  the first app socket. What shipped: a new `appsKeep(duty)` answers true when **any** attached app
  lacks the yield (`src/host/server.ts:476-477`), and `driverOf` answers `'app'` first, then `'parked'`
  from the settings gate, then `'host'` (`src/core/host/driver.ts:14-18`). `appKeeps` stays as S3
  shipped it, for the callers that pick the app an `act` goes to. The value is recomputed at every
  kick and tick, and set synchronously from the gate already read in the same turn as an app's hello
  or close (`src/host/driving.ts:141-158,299-304`, N1). Before the first read it is `'parked'`, and an
  unread gate parks unless an app keeps dispatch (`driving.ts:88-94,181-185`, N2 and Task 12 review
  I1). Why: an app from before this feature runs its own loop on every push whether or not it is
  first, and `'app'` beats `'parked'` because the Host does nothing either way and `status` should say
  who drives. Pinned by `src/core/host/driver.test.ts`, `src/host/server.test.ts` and
  `src/host/driving.test.ts`.
- **A38. §4.6, what parks the Host (R2).** It said: parked when the file exists without the marker,
  read with the app's own test. What shipped: an existing file without `orchAlwaysOnMigrated: true`
  parks, a missing file does not (F64's correction), and a file that cannot be read or parsed parks
  too (`src/core/host/driver.ts:21-33`). The read goes through `readFileRetrying`, so the app's own
  tmp+rename does not read as damaged, and it is repeated at every computation, which is how the Host
  notices a migration an app wrote after its last commit (`driving.ts:163-177`). Why: the app reads a
  damaged file as `'unknown'` and never pauses on it, but the Host cannot repair it, and a damaged
  file already refuses every Host spawn (A10). **Found in review (Task 14, m1):** the app yields to any
  Host that announces `dispatch`, parked or not (`src/main/host/outdated.ts:70-76`), and nothing in the
  app shows that the Host is parked. So while it is parked nobody dispatches and the app says nothing.
  A settings file damaged while the app runs parks the Host until Astera restarts: the app's load keeps
  a `.bak`, and its migration then writes the marker (`src/main/appSettingsStore.ts:237-248,336-346`).
  Pinned by `src/core/host/driver.test.ts` and `src/host/driving.test.ts`.
- **A39. §4.1 trigger 2, no eager load (R3).** It said: the loop runs at load, after `store.load` and
  the drain. The Host never loads at start (`src/host/index.ts`, "Constructed, not loaded"), and S4
  keeps that. What shipped: the first call that needs the state loads it, and `createHostOrch` calls
  `onLoaded()` once at the end of that load, after `loaded = true` (`src/host/orch.ts:453-458`). The
  driver's after-load pass hands over (drain, resume sweep, repair belt), gates lost workers and runs
  the loop (`driving.ts:110-139,241-246,332-337`). A Host whose first contact is an accepted `state-put`
  never loads, so the handover also runs the first time the state is in memory while the Host drives
  (`driving.ts:152`). A Host started by `astera host start` with a Run in its file and nobody asking
  stays idle and leaves after `IDLE_MS`, as before. Why: eager loading would run the restart cleanup
  behind an app a second away from attaching. Pinned by `src/host/orch.test.ts` and
  `src/host/driving.test.ts`.
- **A40. §4.4, the pending-report drain (R4, N4).** It said: the drain runs at `ready()`, right after
  `store.load`, and the app stops draining when the Host announces `dispatch`. What shipped: inside
  the load, through `handleCommand` directly, and only when an awaited `mayDrain()` says the Host
  drives at that moment (`orch.ts:439-452`). A Host that did not drive at its load drains once, at its
  first handover (`drainOnce`, `orch.ts:1072-1086`, called from `driving.ts:110-112`). **Except the
  not-migrated to migrated change out of `'parked'`**, which drains nothing (`driving.ts:154`): the
  app's migrating launch leaves the queue alone ("The next start takes them"), and so does the Host.
  Those reports then wait for the next Host start, or for this Host's next handover. Why: inside the
  load, so an app's `state-get` is answered after the drain and its recovery never sees a Dispatch a
  report is about to close. An old app that read the queue before the Host drained it applies a report
  twice, and the second `applyWorkerDone` answers `alreadyReported`. Pinned by `src/host/orch.test.ts`
  and `src/host/driving.test.ts`. The one gap is under "Known limits after S4+S5".
- **A41. §4.1 trigger 1, every commit (R5).** It said: after every commit the Host makes, including an
  accepted `state-put`. Only `depsFor`'s `setState` called anything. What shipped: an `onCommit()`
  hook, called after that `setState` and after an accepted `state-put` (`orch.ts:516,705`, through
  `kickDriver` at `:559-566`),
  isolated so a driver that throws cannot fail the command. A refused `state-put` changed nothing and
  kicks nothing. Pinned by `src/host/orch.test.ts`.
- **A42. §7.2 and §7.4, `status` (R6, R7).** It said: the `status` body gains `driver` and
  `appAttached`. What shipped: the Host's `call` merges the two into a 200 `status` reply
  (`orch.ts:1186-1194`), so `command.ts` is not touched. The driver is built only with a spawner
  (`src/host/index.ts:212-231`), the same one fact that announces `dispatch` (`index.ts:334`), so the
  fields appear only from a Host that announces `dispatch`, and their absence tells a script this Host
  does not drive. `astera status` passes them through (`cliPublic.ts` shapes no `status`). §7.4's
  interim note is moot for such a Host. Pinned by `src/host/orch.test.ts` and
  `src/host/driving.integration.test.ts`.
- **A43. §1.4 and F58, the six S5 names (R8, R9).** It said: they become HOST_LOCAL in S5. What
  shipped: their own group, `HOST_DRIVES`, answered per call by `drive.owns()`, read synchronously by
  each wrapper, and otherwise the route each had before S5 (`src/host/orchDeps.ts:147-160,614-650`).
  **F58 holds by construction**: `repairTargetFor` and `startRepair` switch on the same predicate in
  the same turn. The F58 comment is rewritten at both ends (`orchDeps.ts:125-139`, and `startRepair`'s
  doc in `command.ts`, Task 10 review I2). `repairOnce` is marked after acting, never over a
  `{ ok: false }`, which it answers only before acting. The Host's own commands run under
  `HOST_CALLER = 'astera:host'` (`src/core/host/driver.ts:9`, `orch.ts:1060-1069`). Pinned by
  `src/host/orchDeps.test.ts`.

**The Host's checks**

- **A44. §5.1, a validation run's environment (R11).** Not stated. `RunManager` started from
  `process.env`. What shipped: it takes an injected base environment (`src/core/run/runManager.ts:62-64,92`),
  and the Host passes `hostWorkerBaseEnv(env)`, read at each start (`src/host/checks.ts:187-188`).
  Why: D4's strip list applies, or a validation inherits `ELECTRON_RUN_AS_NODE=1`. Pinned by
  `src/core/run/runManager.test.ts` and `src/host/checks.test.ts`.
- **A45. §5.1, the path guard (R10).** Shipped as described: a Job's `cwd`, a Run's `worktree`, or a
  path the Host's `worktrees.json` lists, each read at the call, an empty root skipped, containment by
  `isPathWithin` (`src/core/run/hostPathGuard.ts:10-24`, wired at `checks.ts:159-167`). A Job whose
  `cwd` is broad allows its whole subtree (Task 9 review m4, under "Known limits after S4+S5"). Pinned
  by `src/core/run/hostPathGuard.test.ts`.
- **A46. §5.1, the changed files (R12).** It said: `startValidation` computes suspicious files. They
  need the journal's first checkpoint, which stays the app's (D8). What shipped: the Host passes no
  diff base (`checks.ts:245-247`), so the calculation falls back to the Task's own `filesModified`.
  A degradation, recorded. Pinned by `src/core/orchestration/exec/validation.test.ts` and
  `src/host/checks.test.ts`.
- **A47. §1.4, `lang` (R13).** It said: from `app-settings.json`. What shipped: the file's `lang`, else
  `pickInitialLang` over the OS locale, and `'en'` for a file that cannot be read or parsed
  (`checks.ts:122-151`). The moved bodies take a synchronous `lang()`, so the Host keeps the value it
  last read (`langNow`), refreshed by every `lang()` call and every driver computation
  (`driving.ts:163-168`). Pinned by `src/host/checks.test.ts` and `src/host/driving.test.ts`.
- **A48. §5.1, `validation-stop`.** It said: the app forwards the stop and the Host's validator calls
  `markStopped`. What shipped: the Host marks the run and then kills it (`checks.ts:366-372`), because
  it has no other door that stops a run, and the app does **not** also kill it while the Host drives:
  a kill from the app could land before the mark and read as a failed check
  (`src/main/orchestration/yieldDispatch.ts:47-100`). An answer of `stopped: false` means the app's own
  validator started the run, and the app stops it its own way; a 501, a failure, or no answer within
  2 s makes the app mark and stop the run itself. The Host accepts the call from role app only
  (`orch.ts:1136-1142`). Pinned by `src/main/orchestration/yieldDispatch.test.ts`,
  `src/host/checks.test.ts` and `src/host/orch.test.ts`.
- **A49. §1.3 and §9.3, one module per wiring (R28, N11).** It said: the modules move to `exec/`. What
  shipped: the bodies that lived inline in `ipc.ts` are modules both processes build:
  `startValidation` and `onSettled` in `src/core/orchestration/exec/validation.ts`, `startReview` in
  `exec/review.ts`, and `runScheduler`, `gateSlot`, the fire tick and the nudges in
  `exec/dispatchLoop.ts`. The Host composes its driving in one place, `src/host/drivingWiring.ts`,
  which `index.ts` and the two-process rig (`src/host/driving.integration.test.ts`, in-process) both
  use. The three text guards over `ipc.ts` (property 5, Finding 1, F63) became behaviour tests of the
  modules; the property-4 guard stays, and N8 added two source guards that `ipc.ts` reaches every
  yield through one `hostDrives()` closure (`src/main/orchestration/ipcConvergenceWiring.test.ts:59-81`).

**Leaving, lost workers, and the app that yields**

- **A50. §8.4 and the loop, a Host that is leaving (R15, and the ruling on Task 13).** §8.4 covered
  retire mid spawn and said nothing about the loop or the checks. What shipped: the driving is
  disposed first when retire starts (`src/host/index.ts:118-127`). From then on `drive.owns()` is false
  (`src/host/drivingWiring.ts:136`), so the six S5 names take their not-driving routes together, and
  `mayStart` is false (`drivingWiring.ts:117`), so a pass stops at its next slot. A 409 carrying `retry`
  stops the loop's activation without a Gate (`src/core/orchestration/exec/dispatchLoop.ts:487-497`),
  because the Host's own `handle()` answers through the same rewrite as `call` (`orch.ts:582-593,1060-1069`,
  B1). **A leaving Host starts no validation, review or repair, and records none as failed**: a run it
  kills on its way out hands the validator the lost-sight code, which settles nothing
  (`checks.ts:254-267`). The Task stays `validating` or `reviewing`. The successor restarts it in a
  convergence Job, through the resume sweep of its handover, and gates it otherwise, at its load (the
  restart Gate, or blocked for review; `interruptStalledTask`, `src/core/orchestration/state.ts:1419-1431`).
  Why: read as a result, the kill would be a failed check, a repair the leaving Host refuses, and a
  blocked Task with a fix attempt spent. The ruling first said the successor restarts it in every Job;
  that premise was only partly true and was corrected in review. Pinned by
  `src/host/driving.integration.test.ts`, `src/host/checks.test.ts`,
  `src/core/orchestration/exec/dispatchLoop.test.ts` and `src/host/orch.test.ts`.
- **A51. D6, the lost-worker Gate (R16, N5).** D6 said: a Gate at load on a worker lost to a Host
  restart with no journal. The Host cannot read the journal (D8), and the same stranding happens
  without a restart. What shipped: on every pass while the Host drives **and no app is attached**, a
  Gate on each Task that `candidates()` finds in a Run with no coordinator slot, through `gate-create`
  (`src/core/orchestration/lostGate.ts:17-22`, `src/host/driving.ts:220-239`). A Run with a coordinator
  is left to it, and with an app attached its reconciler decides. **Accepted reach (N5):** there is no
  journal check, so a worker the app journalled before it closed, which its reconciler could have
  resumed at its next start, gets a Gate instead. That goes past D6's "at load, no journal" into D8's
  ground, and is accepted because the Gate is the safe direction: a person restarts it. Pinned by
  `src/core/orchestration/lostGate.test.ts` and `src/host/driving.test.ts`.
- **A52. §4.2, an app in front of a Host that does not answer (Task 14 review I1).** Not stated. What
  shipped: the app keeps yielding while the Host is unresponsive, if that Host announced `dispatch`
  (`src/main/host/outdated.ts:64-76`). The Host still sees a yielding app attached and still drives, so
  an app that took the drive would nudge the same coordinator twice and kill a Host validation run with
  no mark. The cost: a hung Host that keeps its pipe open leaves Jobs unmoved until it answers, dies,
  or is restarted from Settings, Info. The status bar says "Host not answering"; the Jobs sidebar does
  not say why nothing moves. Pinned by `src/main/host/outdated.test.ts`.
- **A53. §5.3 and R21, the S5 starts forwarded to an app that yields (the m6 ruling, Task 14 review
  I2).** R21 said: an app that yields dispatch may still be asked to validate, and answers correctly.
  What shipped instead: an app that yields refuses `startValidation`, `startReview` and `startRepair`
  forwarded to it, and answers `repairTargetFor` with `null`, so a review's verdict lands as the
  `repairFailed` Gate rather than a half-opened repair (`src/main/orchestration/answerAct.ts:51-69`).
  A Host forwards these only while it does not drive: parked, retiring, or an older app keeps dispatch.
  **So R21 is false** with a new and an old app both attached: the forward reaches the first app, which
  may be the new one, and the Task waits. It is restarted at the next handover in a convergence Job.
  Otherwise it gets the restart Gate once no app is attached (A54). Why: it matches the ruling on Task 13, and the cost if
  wrong is one Task waiting for the next Host. Pinned by `src/main/orchestration/answerAct.test.ts`.
- **A54. §5.1, the resume sweep when an app leaves (Task 14 review I3, round 2; final review I1, I2,
  M1).** It said: the Host sweeps at load and at every change of `driver` to `host`. A yielding app
  that leaves does not change the driver, yet it may have been running a validation or review itself
  (recovery, D8). What shipped: the handover and a yielding app leaving run the same steps
  (`afterDriveChange`, `driving.ts:225-246`), the handover after its drain. A yielding app leaving
  is decided at the end of `APP_LEFT_GRACE_MS` (5 s), or when an app attaches within it
  (`decideAppLeft`, `driving.ts:438-475`). A socket that drops while its app lives reads as a leaving
  app, and that app reconnects after a 1 s backoff, perhaps still starting a person's retry-once or
  settling a check. The profile's `app.pid` (S3) tells the two apart: the pid it named when the app
  left is read again, and the same live pid is the same app, which keeps what it left until it
  reconnects, or until a tick with no app attached finds `app.pid` no longer naming it. Another pid,
  or none, is a new instance (`system.relaunch` starts one at once) or a quit, and the steps run,
  even beside the new instance, which yields and so runs no resume sweep of its own. With no app
  attached, the Host first tree-kills every live `run` pty in its registry marked `validation` that
  its own `RunManager` did not start, waits for each exit up to `FOREIGN_KILL_WAIT_MS` (5 s) and
  records nothing (`checks.ts:322-371`). Beside a new instance it kills only the runs whose note says
  they started before the old one left, so the new one's own runs are spared. This covers an older
  app that drove and left (the handover) as well as a yielding one.
  Then it runs one resume sweep, which restarts a convergence Run's `validating` and
  `reviewing` Tasks, and starts any repair Dispatch that was opened and never started (N1's belt).
  Last, it arms the restart Gate for every other Task left `validating` or `reviewing` with no open
  Dispatch and nothing of this Host's checking it (`checking`: its validator, a review start in
  flight, or a foreign validation run still alive in a folder the Task's Dispatches work in, or in any
  folder when the run or the Task does not name one). Every later tick that drives with no app
  attached arms again, so a Task such a run held is armed once the run is gone. A tick at least
  `STALL_CONFIRM_MS` (5 s) later opens the load's own restart Gate (`interruptStalledTask`) for each
  such Task that is unchanged and still unchecked, with no app attached (`driving.ts:149-198,400-403`).
  An app attaching drops every armed Task. A person's ordinary runs carry no
  `validation` mark and are never touched. Why: the app's validation runs open through the Host's pty
  factory and outlive it, nobody settles them any more, and a second check would start beside them in
  the same folder. The Gate waits for a tick because the Host's own `worker_done` commits `validating`
  before it starts the check, and a Task caught in that gap must not be gated. Without the Gate such a
  Task kept its Run running for good: the Host never idled, `host stop` refused, and no load came to
  gate it (final review I1). Pinned by `src/host/driving.test.ts`, `src/host/checks.test.ts` and
  `src/host/driving.integration.test.ts`.
- **A55. §4.2, the renderer's commands (R20).** Shipped as the design said: they still run
  `handleCommand` in the app and write with `state-put`, including a person's `retry-once`, which opens
  and starts a repair from the app while the Host drives. The app's own deps answer the S5 names for
  them (`src/main/ipc.ts:3143-3190`). Accepted: it is a person's click, it commits before it spawns,
  and F56 refuses it if the Host committed first. Not pinned; recorded.

**Schedules, the later run, and D7**

- **A56. D2 and R17, schedules and the sidebar's next fire (N3).** It said: `orchFireTick` moves to the
  Host subject to D2. What shipped: the Host's tick fires only while it drives and an app is attached,
  and drops its arming otherwise, so the first tick that may fire again only arms
  (`driving.ts:269-274`). In front of a driving Host the app's timer arms without firing (`armOnly`),
  because the sidebar reads its next-fire time off that arming (`dispatchLoop.ts:604-610`,
  `yieldDispatch.ts:26-45`). **Found while moving it (the F65 gap):** a fired run of a scheduled Job is
  not placed by the loop, because `appDriven` needs `job.autoDispatch` (`src/core/orchestration/schedule.ts:33-44`)
  and a schedule never carries it. That is the app's behaviour too, and is unchanged. Pinned by
  `src/host/driving.test.ts`, `src/main/orchestration/yieldDispatch.test.ts` and
  `src/core/orchestration/exec/dispatchLoop.test.ts`. **Closed 2026-09-25, see Amendments A79:** a fired
  run now starts the way `jobs run` starts one.
- **A57. Carry 4, a later `jobs run` of a coordinator Job (R18, the user's Q2, N7).** The S3 known limit
  said such a run is not driven until S4 moves the loop. The loop would not drive it either:
  `run-start` deletes `autoDispatch` when it attaches a coordinator, and a later run went to
  `run-spawn`, which starts no coordinator. What shipped, as the user decided: a later `jobs run` of a
  Job with a coordinator account and no schedule starts that run's coordinator, as the first run does
  (`src/core/orchestration/command.ts:992-1026`). A later run's failed start is not like a first run's:
  `run-spawn` has already committed the run, so it stays with no coordinator, and the error names the
  retry, `astera run-start --run <jobId>`, with `jobId` and `runId` in the body (N7). The CLI keeps
  `runId` in `error.details` (`src/cli/run.ts:547-555`, Task 15 review M1). Pinned by
  `src/core/orchestration/command.test.ts` and `src/cli/run.test.ts`.
- **A58. §6 and D7, a worker at its usage limit (R19, the user's Q1).** D7 said: a Gate carrying the
  reset time, so `runs wait` ends with 8. `createGate` refuses a Task with an open Dispatch, and a
  stalled worker keeps its Dispatch open, so the Gate is reachable only by ending the worker. **The user
  left D7 out of S4+S5; it moves to S6.** The worker stalls as §6 describes; `runs wait` ends at its
  deadline with 7; when Astera opens it adopts the session and rolls it. Rolling stays in the app until
  S6. A Task carries several accounts (`Task.accountIds`, `tasks add --account a,b`), and a session
  rolls across them (`rollAccountIds`). No code; recorded.
- **A59. A29 and M7, the spec pile-up (R22).** A29 deferred it to S4's tick. What shipped: the Host
  sweeps `orch/specs` during its life only on a tick with no app attached and no spawn of its own in
  flight (`driving.ts:275-280`), because an app still writes specs in front of a new Host (a person's
  retry, an old app). Pinned by `src/host/driving.test.ts`.

**Worktrees and merges**

- **A60. The carried registry items (R23, carries 2 and 7a).** What shipped: `WorktreeRegistry.add` is
  one add-or-replace. An entry whose id is listed changes nothing, and an entry at a path another names
  replaces it in the same write (`src/core/worktrees/registry.ts:136-151`). `readForWrite` rides out a
  Windows rename-busy read through `readFileRetrying` (`registry.ts:258-261`), which resolves the first
  entry of "Known limits after S3". Why: the loop's lazy Run-worktree fork calls `fresh()` on every
  headless Run, and a transient sharing violation there would open a Gate. Pinned by
  `src/core/worktrees/registry.test.ts`.
- **A61. Carry 1, the per-merge record (R24; Task 3 and Task 4 reviews).** A28 said a Host merge made
  with nobody attached is announced to nobody and may read as an outside change. What shipped: the Host
  writes each merge into `profile/host/merges.json`, with `headBefore` on disk before `git-op begin`
  and `headAfter` in the `finally` that sends `end` (`src/host/worktrees.ts:271-296`,
  `src/host/mergeRecords.ts:55-112`). It keeps the newest `HOST_MERGES_KEPT` (200) records. A missing
  file is empty, a damaged one is kept as `.bak`, and any other read error skips the write. The Work
  Unit collector counts a HEAD move as Astera's when a chain of completed records leads from its stored
  head to the new one, or when a record for that folder is still open and between 0 and
  `MERGE_OPEN_MAX_MS` (2 minutes) old (`src/core/git/hostMerges.ts:26-29,81-120`,
  `src/main/workUnit/collector.ts:1398-1430`). Completed records count only while the branch is
  unchanged, and only those that ended after the stored snapshot was captured (Task 4 review I1).
  **This closes A28** and the matching entry of "Known limits after S3". Pinned by
  `src/core/git/hostMerges.test.ts`, `src/host/mergeRecords.test.ts` and
  `src/main/workUnit/collector.test.ts`.
- **A62. Carry 3, the app's `discardRunWorktree` (R25).** What shipped: the app supplies it from
  `reapWorktree` (`yieldDispatch.ts:123-134`, wired at `src/main/ipc.ts:2928`), so `run-start`'s cleanup
  takes the same branch in both processes. `reapWorktree`'s `false` means not removed for any reason,
  so the 400 says the folder "could not be removed" (C7). The fallback in `command.ts` stays for deps
  that lack it. Pinned by `src/main/orchestration/yieldDispatch.test.ts`.
- **A63. Carries 6 and 7, and A19 (R26, R27, R29).** Carry 6 stays out: after S4 the app forks only
  for its own loop in front of an older Host (D5), and a `--worktree new` start from a shell or a
  coordinator goes to the new Host, which cleans up. Carry 7's other limits stay as recorded: a pre-S3
  app writes no `app.pid`, the ~2 s replacement window for the app's worktree writes, and A17's
  conhost per self-exiting pty, which grows with long-lived headless Hosts. (The replacement window and
  the conhost leak are resolved in the left-over limits pass, see Amendments A111 and A124; a pre-S3 app
  writing no `app.pid` is unchanged.) A19 (no `PROMPT_WRITE_*`
  rows for Host-spawned workers) now covers every headless worker, and recovery's reason still reads
  `promptNeverLeft` for them. No code; recorded.

**Found while building it**

- **A64. An exit that lands before the validator recorded its start (Task 6 review I1).** Not stated,
  and older than S4. The app's pty factory queues an exit in a microtask while the socket is down, so
  an exit could reach `onRunExit` before `startCheck` recorded the run, and that folder's queue stalled
  forever. What shipped: the validator keeps such an exit while a start is in flight (at most 64) and
  replays it once the run is recorded (`src/core/orchestration/exec/validator.ts:63-87,234-238`). Pinned
  by `src/core/orchestration/exec/validator.test.ts`.
- **A65. One start per repair Dispatch in the Host (Task 12 review m1).** Not stated. `performRepair`
  re-reads the Dispatch only before its `startWorker`, so the validator's start and the handover's
  belt could both spawn: two agents in one worktree. What shipped: a second start of the same Dispatch
  while one is in flight is skipped (`checks.ts:191-207`). The belt itself runs only with no app
  attached (`driving.ts:125-138`). Pinned by `src/host/checks.test.ts`.

**Found after S4+S5 shipped**

- **A66. §1.4, `resolveProjectRoot` with the app closed (final review M3).** It said: `resolveProjectRoot`
  becomes HOST_LOCAL in S3, over the worktree list plus Job cwds. It did not: it stayed SWALLOWED, so
  with the app closed the Host forwarded it, got APP_REQUIRED, and `run-create` kept the path it was
  given. A Job made with `--cwd` in a subfolder of a project then showed in no project list, because
  ownership is an exact match. What shipped: a new orchDeps group, HOST_RESOLVES
  (`src/host/orchDeps.ts`). The Host answers when no app is attached, or while it drives. An attached
  app that does not yield is still asked, and if that app cannot be reached the Host answers instead;
  an app that answers with an error is not overruled, so the given subfolder is kept. A failure is still
  swallowed and never answers CONFLICT. The rule is one function for both processes,
  `resolveProjectRootFrom` in `src/core/files/tree.ts`, next to `projectRootOf`. The worktree
  repoPaths come first, the walk stops at `repoRoot(cwd)`, there is no boundary outside a repository,
  and the given cwd comes back when nothing holds it. `ipc.ts` now calls that function. The Host's
  candidates are its own registry's repoPaths plus the projects that the transcripts of the
  accounts.json accounts name (`src/host/projectRoots.ts`). The listing moved out of
  `core/history/index.ts` into `src/core/history/projects.ts`, which has no watcher and no chokidar
  import. HistoryIndex keeps its watcher and caches and calls the new module. The Host's
  `ProjectPathListing` keys a claude folder's cwd on its mtime signature, the key `dirCache` uses, so
  an unchanged folder is not parsed again. It opens `session-cwd.json` read-only
  (`SessionCwdCache`'s `readOnly`), so the app's file is never written, not even as a `.bak`. Why
  not Job cwds: a stored one may itself be a subfolder that was never normalised (any Job made with
  the app closed before this), and a subfolder candidate pins every later Job below it there. So the
  Host keeps the app's two lists. Why not the app's `HistoryIndex`: the chokidar import would add a package to the Host bundle, and
  nothing but its watcher ever clears its project cache. What the Host does not see: the ghost
  accounts the app finds on disk, which are not in accounts.json. A Job made from one of those
  folders with the app closed is left at its subfolder. The cost is one stat per transcript across
  every account on each call, so it grows with history size with no upper bound: measured at about
  130 ms per `jobs create` (about 1 s on the first) with 6 accounts and about 11,000 transcripts. The
  Host's memo maps are never pruned for its life; they grow slowly. Pinned by `src/core/files/tree.test.ts`,
  `src/core/history/projects.test.ts`, `src/core/history/sessionCwdCache.test.ts`,
  `src/host/projectRoots.test.ts`, `src/host/orchDeps.test.ts` and `src/host/orch.test.ts`.

## Amendments (S6 as shipped)

S6 landed on `develop` from `b753c537` through Task 16 at `2d426dcb`. Its design
(`.superpowers/sdd/2026-09-25-host-s6/design.md`, which reads this document as binding), its plan
(`plan.md` in the same folder, rulings R1 to R35), the pre-flight scan of that plan (`preflight.md`,
findings B1 to B3, R1 to R13 and C1 to C17) and its execution ledger (`progress.md`) changed or added to
some statements above, and this list is the record, in A1's form. "Plan R" names a ruling of that plan
and "preflight" a finding of the scan; neither is one of this document's own rulings. The user's answers
for S6 (Q1 to Q5) are in `decisions.md` in the same folder. Files are cited by symbol, not by line. §6,
D7, A1, A5, §7.2 and the usage-limit entry of "Known limits after S4+S5" each carry a short note
pointing here. What is still open is under "Known limits after S6".

**What S6 is, and what §6 got wrong**

- **A67. §6, the slice (the S6 design's §8).** It said: S6 is not needed for the goal and moves
  `rolling.ts`, `codexRolling.ts`, `rollTap.ts`, the coordinator wiring and `codexRolloutWatcher.ts`; a
  worker at its limit stalls until an app opens, whose adopter "detects the stall and rolls or nudges as
  it does for any session"; and the Host "already runs the limit probe locally" and could open a Gate
  when a worker's statusline shows a limit. That was wrong in four places. Step 4 is false for codex: the
  adopter registers an adopted codex chain unmapped (`sameAccount` and `locate` both false), and such a
  chain does not roll until codex writes a limit record of its own, which a blocked turn never does. So a
  codex worker stalled at its limit stayed stalled after the app opened. The limit probe is a verdict on
  an exit (`limitProbe.ts`, called from `handleExit` and `worker_done --outcome failed`). A stalled worker
  does not exit, and the probe reads the transcript or rollout, not the statusline. The size list missed
  the usage fetcher's `net.fetch`, the resume packet and git summary, the hook events watcher, the
  `rolling.json` double writer, the per-process block registry, the Host's asynchronous spawn against a
  roll's await-free kill, and the coordinator slot (A72). It also named `codexRolloutWatcher.ts`, which
  did not need to move: its one headless duty, the rollout mapping in the note, the Host's spawner
  already did. And it left out coordinators, each of which is a single-account chain that is waited out
  and resumed in place. What shipped: the two coordinators moved with no logic change to
  `src/core/rolling/claudeCoordinator.ts` and `codexCoordinator.ts`; the roll tap, the resume packet and
  the git summary to `src/core/orchestration/exec/`; the hook watcher to `src/core/hooks/eventWatcher.ts`,
  with a `startAtEnd` option the Host passes (plan R13); and the usage fetcher and its cache to
  `src/core/usage/` with an injected `fetch`. The app passes `net.fetch`; the Host passes nothing and gets
  the global one (plan R11). The Host builds its own two coordinators over its own registry, statusline
  files, hook events, `accounts.json` snapshot (read again on each 15 s tick) and login memo
  (`createHostRolling`, `src/host/rolling.ts`). They are composed once, in `src/host/rollingWiring.ts`,
  which `index.ts` and the S6 rig (`src/host/rolling.integration.test.ts`, in process) both use. The Host
  asks for account usage itself, as the app does, and a lookup that fails accepts the limit (Q4, plan R28,
  preflight R1). It keeps its own block registry, writes its roll config to `profile/host/rolling.json`
  (the app reads its own file first, then the Host's, plan R9), and appends `[host]` and `[host][codex]`
  lines to the profile's `rolling.log` (plan R10). A roll's respawn is split in two (plan R5).
  `prepareRollSpawn`, awaited before the kill, does every await and every refusal the Host's spawn has:
  a retiring Host, a damaged settings or accounts file, a missing folder, an unknown account. `rollSpawn`,
  inside the await-free stretch, is synchronous. A refusal reschedules the roll visibly and leaves the old
  session alive. The new pty's note is written in the same `registry.open` that makes it (`restoreExtra`,
  plan R6). The spawner locates each codex session the Host starts, once, and hands the result to the
  chain (`attachFresh`, plan R12), so a Host codex chain is never adopted unjudged. `roll()` asks the owner
  rule (A69) at entry and again right before the kill (preflight B1). A chain that rule quiets keeps
  reading its tails and statusline and takes no action (preflight R2, plan R27). No dependency the Host
  hands a coordinator rejects unheld, because the Host has no `unhandledRejection` handler (preflight R3,
  plan R29); `prepareSpawn` and `copy` still reject, inside `roll()`'s own catch. The Host rolls pty
  sessions only, and keeps all three kinds of unattended typing: the resume in place at a reset, the idle
  nudge and the reset anchor (Q5, plan R21). When retire starts, the Host's rolling is disposed with its
  driving (A50): no new roll, no takeover, and nothing waits for a roll in flight, because `leave()` kills
  every pty (plan R16). Pinned by `src/host/rolling.test.ts`, `src/host/spawner.test.ts`,
  `src/host/importFence.test.ts`, `src/host/rolling.integration.test.ts` and the two coordinators' tests.
- **A68. D7 and A58, a usage limit with no app (Q3).** D7 said: a Gate carrying the reset time, so
  `runs wait` ends with 8. A58 moved it to S6, because `createGate` refuses a Task with an open Dispatch.
  What shipped instead, as the user decided: **no Gate**. A worker at its limit rolls or waits in the Host
  (A67), and the Host's roll tap records the stop and its reset time on the Dispatch, as the app's does.
  `runs wait` and `jobs wait` end with 8 in a new state, `limited`, when the Run has at least one open
  Dispatch, every open Dispatch of the Run is in a stop whose reset time is known (its last `resumes`
  entry has `resetsAt` and no `resumedAt`), and no Task of the Run is `validating`, `reviewing` or
  `ready` (`limitedUntil` in `src/core/orchestration/command.ts`, asked after the open Gate and the
  pause). `ready` was added in the controller's review of Task 15: a Run with a Task ready to start can
  still move before the reset, because the loop may dispatch it. The envelope is `WAITING_FOR_INPUT` with
  `details: { runId, progress, state: 'limited', resetsAt }`, where `resetsAt` is the earliest reset
  among the waiting workers. Its `nextSteps` are `astera runs wait --id <runId>` and `astera runs get
  --id <runId>`, not `questions answer` or `runs resume` (`src/core/orchestration/cliOutput.ts`). The
  workers still resume by themselves, so a later `runs wait` can end `completed`. A restored wait is
  published as a re-publish (`reattach: true`), so a takeover does not record the app's stop a second
  time (preflight R5, plan R32). Why no Gate: it was reachable only by ending the worker, and the ending
  tells a script the one true thing, that nothing in the Run moves before that time. A Run whose waiting
  session is its coordinator is not seen by this rule (known limits). Pinned by
  `src/core/orchestration/command.test.ts`, `src/core/orchestration/cliOutput.test.ts` and
  `src/host/rolling.integration.test.ts`.

**Who rolls a session**

- **A69. A1 and `exitOwner.ts`, "rolls happen only on ptys an app holds" (Q1, Q2; plan R1 to R3, R18,
  R25, R31, R33).** A1 said: rolls still happen only on ptys an app holds, so the safety reason of §2.6
  stands; `exitOwner.ts` said the same. Both are false since S6. What shipped is one owner per session,
  which starts as the process that spawned it (Q1). Every session the Host spawns is marked
  `rolledBy: 'host'` in its note at the spawn and is rolled by the Host for its life, with or without an
  app attached. A new app says `yields: [..., 'rolling']` in its hello to a Host that announces
  `rolling`, and its adopter skips a note so marked. The Host acts on a chain only while every socket
  that holds that pty yielded `rolling` (`hostMayAct`, `src/core/host/rollOwner.ts`, over
  `exits.holdersOf` and `server.yieldsOf`). It reads holders, not roles, so an older or role-less app
  that holds a pty quiets the Host's chain for that pty; only a socket that said hello counts as a holder
  (the Task 1 review). A session the app spawned (a person's tab with rolling on, the app's `retry-once`
  repair) is rolled by the app while it lives, and by the Host once the app is gone (Q2). The app writes
  a `RollSnapshot` of each chain into the pty's note whenever the chain's durable state changes
  (`src/core/rolling/snapshot.ts`), and the Host restores the chain from it (`takeOverSessions`,
  `src/host/takeover.ts`). The takeover runs in one synchronous turn with no app attached, while the Host
  announces `rolling` and is not retiring. It takes each live session pty that has no `rolledBy`, a
  snapshot that parses, whose accounts equal the note's `rollAccountIds` and whose current account is the
  note's, no socket holding it, and no Host chain on its id. In that turn it resumes a paused pty
  (preflight R4), writes the mark, then restores, and takes the mark back if the restore refuses or
  throws. `src/host/appGone.ts` decides that the app is gone with the driver's rule (`APP_LEFT_GRACE_MS`,
  `app.pid`, a kept pid asked again on every tick) and one difference: an app that attaches within the
  grace cancels the takeover whatever its pid, because a new instance restores the old one's chains
  itself. After a gone decision the pass runs again on every 15 s tick with no app attached (preflight
  R13), and it waits until `accounts.json` has been read once with success (the Task 16 review). **Why the
  same live pid keeps its sessions** (corrected, preflight R10): not because a dropped app's chains keep
  running while its socket is down. They do not. The drop ends every Host-backed handle with
  `PTY_LOST_SIGHT_EXIT_CODE`, `onSessionExit` hands that exit to `rolling.handleExit`, and every chain
  that is not mid-roll is disposed. So such an app holds no chain that could be a second owner, and its
  reconnect **restores** each chain from the note's snapshot instead of registering it from zero (the S6
  design's §3A.3 rule 2). The app's adopter has three branches (plan R18): a Host mark in front of a Host
  that rolls is skipped, and any chain the app still holds for it is unregistered (preflight R11); a
  snapshot is restored; anything else registers as before. **Ownership does not come back** (controller
  ruling, preflight R8, `progress.md`): a session the Host took stays the Host's when an app returns. The
  four reasons are in the S6 design's §3A.1: one handover point instead of two; the chain's memory stays
  where it is; the display path already exists; and it is Q1's rule, applied once. `exitOwner.ts`'s
  header now says rolling runs in both processes, the app for the ptys it owns and the Host for the ones
  it spawned or took over, each deferring its own exits so its own roll tap rekeys first. The exit owner
  itself is unchanged. Pinned by `src/core/host/rollOwner.test.ts`, `src/host/takeover.test.ts`,
  `src/host/appGone.test.ts`, `src/host/exits.test.ts`, `src/main/host/adoptRolling.test.ts` and
  `src/host/rolling.integration.test.ts`.
- **A70. A5, `readWorker` after a roll (plan R19).** A5 said: once a roll has moved the Dispatch to
  another session, the call goes to the app, which holds the tail that followed the roll. The Host now
  rolls its own workers, so its tail follows them. On a rekeyed Dispatch, the Host's roll tap sets the
  spawner's `startedOn` to the new session and restarts `WorkerTails` on it with `previousSessionId`
  (`retarget` in `src/host/spawner.ts`, called from `src/host/rollTapHost.ts`). A5's rule now holds only
  for a session the app rolled. A Dispatch the app started and the Host rolled after a takeover is
  retargeted too, so from then on the Host answers `worker-read` for it, with only the output since that
  roll (known limits). Pinned by `src/host/rollTapHost.test.ts`, `src/host/spawner.test.ts` and
  `src/host/rolling.integration.test.ts`.
- **A71. §7.2, the S6 additions (plan R17, R30; the S6 design's §3.4).** The table has no S6 rows. What
  shipped, none of it a protocol bump (`HOST_PROTOCOL` stays 3): the feature `rolling` in the Host's
  hello, announced exactly when `spawn` is (`hostFeatures`, `src/host/features.ts`); the `hello.yields`
  value `rolling`, from an app; two pushes to every greeted client, `{ t: 'roll-state', event }` (a Host
  chain's banner state) and `{ t: 'session-rolled', oldSessionId, info, ptyId, dest? }` (a Host roll
  rekeyed a session, and `ptyId` is the new session's pty); two internal `orch-call`s, role app only and
  answered 501 by a Host that does not roll, `roll-state` `{ sessionId }` answering `{ state }` and
  `roll-force` `{ sessionId }` answering `{ forced: true }`, or 404 for a session the Host does not roll;
  the note keys `rolledBy`, `rolledFrom`, `roll` (the snapshot), `forkSeen` and `nativeSessionId`, plus
  the existing `rolloutPath` and `codexSessionId`, which the Host now writes on a codex roll's respawn;
  and one profile file, `host/rolling.json`. The app adopts the new pty of a `session-rolled` before it
  forwards the rekey, and holds the old session's exit until then and until its orchestration mirror
  shows the rekey, at most 15 s (`src/main/host/hostRollView.ts`, the Task 14 review). It keeps the last
  lasting `roll-state` per session for a renderer that mounts later. Its history resume guard asks the
  Host's notes for a native id its own indexes miss while the Host rolls
  (`src/main/host/hostNativeGuard.ts`). The Work Unit collector forks once per roll, through `forkSeen`
  (preflight C10). Pinned by `src/host/features.test.ts`, `src/host/orch.test.ts`,
  `src/host/rolling.test.ts`, `src/main/host/hostRollView.test.ts`,
  `src/main/host/hostNativeGuard.test.ts` and `src/main/host/adoptRolling.test.ts`.

**Exits a roll causes, and the one name that changed group**

- **A72. A1 and A2, an exit that a roll caused (plan R7, R14).** A1 said `releaseCoordinator` follows
  the exit owner, and A2 that the handover sweep hands every open Dispatch whose session ended to
  `handleExit`. Two kinds of exit must not be handled that way. First, a roll that respawns a coordinator
  (a single-account chain's in-place fallback) kills the session the Run's `coordinatorSessionId` names,
  and both processes detached that slot on the exit, because `rekeyDispatch` moves Dispatches only. That
  defect was older than S6 (the S6 design's §2.4). What shipped: a pure `rekeyCoordinator`
  (`src/core/orchestration/state.ts`), applied by the moved roll tap before its Dispatch branch, and so
  used by both processes. The app's release of the slot now waits `EXIT_DEFER_MS` as well, and a release
  still pending when orchestration stops is cancelled (`PendingCoordinatorReleases` and
  `coordinatorReleaseOf`, `src/core/orchestration/exec/releaseDefer.ts`). The Host's exit handler already
  runs after that defer and applies the same `coordinatorReleaseOf`. Second, an app that dies between its
  roll's spawn and its tap's rekey commit leaves a live new pty whose note says `rolledFrom: <old id>`,
  and an open Dispatch on the dead id, which the sweep would close. Before the Host handles an exit it now
  looks for a live session pty whose note names that session as `rolledFrom` (`rolledInto`), and when
  there is one it rekeys the Dispatch and the slot through its own roll tap instead (`sessionExited`,
  `src/host/orch.ts`). The takeover then restores the chain, which types the carry-on prompt. A pre-S6
  app writes no `rolledFrom`, and its case stays as it was (A51). Pinned by
  `src/core/orchestration/exec/rollTap.test.ts`, `src/core/orchestration/state.test.ts`,
  `src/core/orchestration/exec/releaseDefer.test.ts`, `src/host/orch.test.ts`,
  `src/host/rollTapHost.test.ts` and `src/host/rolling.integration.test.ts`.
- **A73. §1.4, `unregisterRolling`'s group (plan R8).** It was FIRE_AND_FORGET: forwarded to an attached
  app, swallowed with none. A Dispatch closed while its session lives would then leave a Host chain
  rolling a session its Task no longer wants. What shipped: a group of its own, HOST_ROLLS
  (`src/host/orchDeps.ts`). The wrapper disposes the Host's own chain first, synchronously and never
  throwing, then takes FIRE_AND_FORGET's route to an attached app, which ignores an unknown id. EFFECTFUL
  stays `true`, and the classification test names the group. Pinned by `src/host/orchDeps.test.ts`.

## Amendments (S6 limits follow-up, 2026-09-25)

The follow-up plan `.superpowers/sdd/2026-09-25-s6-limits/plan.md` (Decisions D1 to D7, in that plan's
own numbering) closed three entries of "Known limits after S6": a coordinator's own wait was not a
`limited` ending; a Host roll made with no app attached was never announced in Slack or in a desktop
notice; and block knowledge was per process. Its execution ledger is `progress.md` in the same folder,
and its five tasks' reports are `task-1-report.md` through `task-5-report.md`. Landed on `develop` from
`2d8685e3` through `5338222f`. This list is the record, in A1's form; the closed entries under "Known
limits after S6" point back here, and the limits it found along the way are under "Known limits after
the S6 limits follow-up".

- **A74. "A coordinator's own wait is not a `limited` ending" (Known limits after S6; plan D1, D2).** The
  rule looked at open Dispatches only, and a coordinator is a Run's slot, not a Dispatch, so such a Run
  waited to its deadline (7). What shipped: `JobRun.coordinatorStop?: { since: string; resetsAt?: string
  }` (`src/core/orchestration/types.ts`). `recordCoordinatorStop(s, { runId | sessionId, resetsAt? },
  now)` sets the field when it is absent and only patches `resetsAt` on a repeat, leaving `since` alone;
  `clearCoordinatorStop(s, { sessionId })` drops it (`state.ts`). `rekeyCoordinator` carries the field
  across a rekey, `attachCoordinator` starts without one, and `detachCoordinator` drops it, which is also
  the load clearing D2 asked for: the restart cleanup already detaches a coordinator whose session is not
  alive through `detachCoordinator`. In `exec/rollTap.ts`, `recordStop` with no Dispatch now records the
  stop on the coordinator slot, and clears it on `nudged`, `none`, `stalled` and in `onRolled` together
  with the slot's rekey; a restored reattach `waiting` records the stop too, when the coordinator has
  none on record yet and the event carries a reset, which covers an older app that owned a waiting
  coordinator the Host then took over. `limitedUntil` (`command.ts`) counts the coordinator when it is
  stopped with a known reset that is not more than 10 minutes stale (`coordinatorResetOf`); the Run is
  `limited` when the coordinator counts and every open Dispatch is also limited or none is open, and the
  answer is the earliest reset among them. Only a Run still `running` can be `limited` (final review
  I1): `coordinatorSessionId` outlives the Run's finish, so without that check a coordinator that hit a
  limit after its closing summary turned `completed` into `limited` and made `jobs run` refuse the Job. A `ready` Task no longer holds `limited` back in a
  coordinator-driven Run (`autoDispatch` off), because only the stopped coordinator can start it; it
  still holds `limited` back everywhere else, since the dispatch loop could still place it. `limited`
  means nothing moves on its own before the reset, not that nothing can: a person can still start a ready
  Task by hand, the same way a person answers a `waiting` Run's question or resumes a `paused` one. A
  second bug came with it: `jobs-run` decided a Job was already running by asking whether
  `waitEndingFor(...)` was `null`, and `limited` is not `null`, so a cron `jobs run` during a usage wait
  started a second Run beside the one already waiting, a bug S6 shipped with too for its case where every
  worker of a Run is limited at once. `jobs-run` now refuses (409) when the ending is `null` or
  `limited`; `waiting` and `paused` keep their old behaviour, since those need a person and a second
  `jobs run` cannot help either. Pinned by `src/core/orchestration/state.test.ts`,
  `src/core/orchestration/exec/rollTap.test.ts`, `src/core/orchestration/command.test.ts`,
  `src/core/orchestration/store.test.ts` and `src/host/rolling.integration.test.ts` (a Host coordinator
  wait reaching `limited`).
- **A75. BlockRegistry gains the exchange primitives (plan D3).** Preparation for A76: a `BlockRegistry`
  had no way to tell another process about a change, or to accept one without re-announcing it.
  `onChange(fn)` (`src/core/rolling/blockRegistry.ts`) returns an unsubscribe and fires from `record`
  (the merged value) and `clear` (`rec: null`), never from the two additions below. `absorb(accountId,
  rec, now)` merges a remote record exactly as `record` does, but fires nothing; `absorbClear(accountId,
  at)` clears without firing and remembers the clear time in a `clearedAt` map, local or remote, so an
  incoming record whose `since` is no later than the account's last clear is ignored. `record` itself
  never consults `clearedAt`, so a local record made after a clear always applies. `clear`'s `now` became
  an optional third argument, defaulting to `Date.now()`, so its two existing production callers
  (`claudeCoordinator.ts`'s and `codexCoordinator.ts`'s `declareHealthy`) kept compiling unchanged; A76
  later threads `this.now()` through both. Pinned by `src/core/rolling/blockRegistry.test.ts`.
- **A76. "Block knowledge is per process" (Known limits after S6, its §4.8; plan D4).** The app's chains
  and the Host's did not share a `BlockRegistry`, so each side paid one kill and respawn per account to
  learn a block the other already knew. What shipped: `HOST_FEATURE_BLOCKS = 'blocks'` and a `{ t:
  'blocks', records, cleared }` message in both `ClientMessage` and `HostMessage`
  (`src/core/host/protocol.ts`; the record shape is written inline there rather than imported, because
  `tsconfig.web.json` compiles `protocol.ts` but not `core/rolling`). `BlockRegistry.snapshot(now)`
  answers every live record plus every remembered clear time. The shared `src/core/rolling/blockWire.ts`
  reads a pushed or sent payload with `parseBlocks(v, now)`, which never throws: it keeps only
  well-shaped entries, drops a record whose `since` is more than 60 seconds ahead of `now`
  (`BLOCKS_MAX_FUTURE_MS`), and reads at most 256 records and 256 clears per message
  (`BLOCKS_MAX_ENTRIES`). `absorbBlocks(reg, p, now)` applies clears first, then records, and skips a
  clear older than the `since` of the record already held, so a late clear cannot erase a newer block;
  when it skips one it still raises the registry's remembered clear time through the new
  `BlockRegistry.noteCleared(accountId, at)`, so a later remote record observed before that clear stays
  ignored. On the Host, `rollingWiring` broadcasts `blocks` on the registry's `onChange`, sends the whole
  snapshot once after every app's hello (`appGreeted`), and absorbs an app's own `blocks` message
  (`blocksFromApp`); `server.ts` gained the `onAppGreeted` dep, called for role `app` only, after the
  hello reply; `index.ts` routes `t: 'blocks'` from a greeted app to it; `features.ts` announces `blocks`
  alongside `rolling`. In the app, `hostSpeaksBlocks` (`src/main/host/outdated.ts`) follows
  `hostSpeaksRolling`'s rule, and the new `src/main/host/blockSync.ts` sends on a local change only when
  the Host speaks `blocks`, sends the whole registry again after every connect (so a restarted or
  replacement Host learns what the app knows), and absorbs a `blocks` push; both sides' coordinators
  (`claudeCoordinator.ts`, `codexCoordinator.ts`) now call `clear(id, this.now())`. The message is a new
  fire-and-forget entry in `ClientMessage`/`HostMessage`, not an `orch-call`: it needs no reply, and the
  server already hands an unrecognised `t` to `onMessage` with `from` (role, greeted), which is exactly
  the gate needed; an older Host never receives the app's message, since the app gates on the feature.
  The Host still broadcasts over the same channel `roll-state` uses, which also reaches CLI sockets; both
  sides' push handlers filter by `t`, so this is harmless, but a future need for "apps only" would need a
  `broadcastApps`. Pinned by `src/core/rolling/blockWire.test.ts`,
  `src/core/rolling/blockRegistry.test.ts`, `src/host/features.test.ts`, `src/host/server.test.ts`,
  `src/host/rolling.integration.test.ts` (the rig, including an end-to-end round trip through a real
  `blockSync`), `src/main/host/outdated.test.ts` and `src/main/host/blockSync.test.ts`.
- **A77. The Host journals a roll made with no app attached (plan D5).** New `RollJournalEntry { seq, at,
  kind: 'rolled' | 'state', sessionId, oldSessionId?, state?, accountLabel?, nextRetryAt?, scope? }` and
  `HOST_FEATURE_ROLL_JOURNAL = 'roll-journal'` live in `src/core/host/protocol.ts`, not `src/host`, so
  the app (A78) can import the type without reaching into the Host's own tree. `src/host/rollJournal.ts`:
  `journalEntryOf(e)` keeps `waiting` (with `nextRetryAt`, `scope`), `switching` (with `accountLabel`),
  `nudged`, `stalled` and every session `rolled` link, and drops `trust`, `none`, `adopted` and any
  `reattach` event, waiting or switching alike, since both are re-publishes of something already told.
  `boundEntries` bounds the entries to 7 days old, then the newest 64 per roll chain (a union-find over
  the `rolled` links), then the newest 1024 overall, applied on both append and load. `createRollJournal`
  writes `<profile>/host/roll-journal.json` as `{ v: 1, lastSeq, entries }`, atomically (tmp then
  rename), behind one promise queue so load, `append` and `take(ack?)` never race; every step is caught,
  so a journal failure cannot produce an unhandled rejection (R3). `take` prunes entries with `seq <=
  ack`, saving only if something was pruned, and answers the rest plus `lastSeq`. A damaged file, or one
  whose top level is not the expected shape, loads as empty rather than refusing, is logged, and is
  copied to `.bak`; a single bad entry inside an otherwise good file is dropped on its own (see Known
  limits below for what a damaged file does to `lastSeq`). `rollingWiring` builds the journal at that
  path and, beside its existing broadcast, appends an entry in its own try whenever
  `!server().hasApp()`; an append after the wiring is disposed at retire still runs, harmlessly, since it
  only journals what no app heard. `src/host/orch.ts` answers the app-only `roll-journal { ack? }` call
  beside `roll-state`/`roll-force`: 403 for a non-app caller, 501 with no journal configured, 400 for an
  `ack` that is not a safe non-negative integer, 200 `{ entries, lastSeq }` otherwise. `features.ts`
  announces `roll-journal` after `blocks`. Pinned by `src/host/rollJournal.test.ts`,
  `src/host/orch.test.ts`, `src/host/rolling.integration.test.ts` (no app: a roll journals `switching`
  and `rolled`, and an ack empties the file; app attached: the same roll broadcasts and journals nothing)
  and `src/host/features.test.ts`.
- **A78. "A Host roll is silent in Slack and in desktop notices until an app attaches" (Known limits after
  S6; plan D6, D7).** What shipped: the app reads A77's journal once after its startup adoption sweep and
  after each reconnect sweep, and announces what it learns instead of replaying it through
  `onRollState`. `src/main/host/rollJournalSummary.ts` (pure) folds the entries: `foldRollChains` sorts by
  `seq` and follows `rolled` links old to new (cycle-safe) to group every entry under its chain's newest
  session id; `chainText` renders one line per chain (a run of `waiting` is one limit naming the first
  wait and the last reset, a run of `stalled` is one, `switching` names its account or, with none of its
  own, falls back to the live session's account when it is the chain's last switch, `nudged` reads
  "resumed at", and a bare roll link says nothing on its own); `summarizeRollJournal` answers `{
  sessions: [{ sessionId, text, seq }] }` for chains with a live session id (what Slack needs, a thread
  to post into), and `limited: [{ sessionId, seq }]` for every chain with a `waiting` or `switching`
  entry, live or not (the desktop count; a stall alone does not count, and neither does a `rolled` link
  with no `switching`, the same-account respawn the ruling below keeps silent). New
  `SlackNotifier.announceOffline(sessionId, text)` (`src/main/slack.ts`) posts once into that session's
  thread, answers `false` when the session has no Slack record, and rejects, rather than swallowing,
  a failed post or a not-yet-ready transport, so the caller knows not to ack. "Not yet ready" means no
  config has been applied at all (slack.json still loading); once one has, a null transport is a user who
  turned Slack off, and `announceOffline` answers `false` like a session with no record, so the journal
  is acked instead of withheld on every start (final review I2). A
  `SlackNotifier.onTransportReady(fn)` fires on every swap to a real transport
  (`applyConfig`/`setWebhookUrl`/`setTransport`), so a later Slack setup can retry what a first attempt
  could not send. The desktop's own `announceOffline(count, sessionId?)`
  (`src/main/desktopNotifier.ts`) shows one aggregated notice, gated on the `limitWaiting` setting alone,
  not held back by window focus, and its click opens the first live chain. D7: both `onRollState`
  handlers skip a `waiting` that carries `reattach`, since a restored wait is not a new limit, it was
  already announced by whichever app first saw it, or it is folded into this summary. New
  `src/main/host/offlineRolls.ts`: `createOfflineRolls(...).swept(why, result)` never rejects; it runs
  only after a sweep that answered a real reattach result (not `null` or `'unknown'`) and only when the
  Host speaks `roll-journal`, fetches the journal, sends the Slack line for every live session in order,
  then the one desktop notice, then acks with the `lastSeq` it fetched; any failure along the way, a
  non-200 answer, a bad body, a Slack rejection, a desktop throw, or the call itself throwing, is logged
  and the ack is withheld, except that a desktop throw no longer withholds it once the Slack lines that
  could be sent were tried. Only one sweep's fetch runs at a time; a sweep that lands mid-run queues one
  more run right after. The ack itself is never persisted; an in-memory per-chain mark (`postedThrough`
  for Slack, `countedThrough` for desktop, both by the chain's newest `seq`) keeps a retry inside the
  same app run from repeating a line it already sent. `offlineRolls.attached(why)` fetches with no sweep
  result at all, for the `other-host` handshake (a new Host replaced a dead one, which runs no sweep) and
  for a `first` handshake whose own startup chain gave up before any sweep ran. `ipc.ts` wires `swept`
  after both `takeSessionsBack('at startup')` and `takeSessionsBack('after a reconnect')`, without
  awaiting the startup one, so the boot cleanup's own answer is unchanged, and subscribes
  `offlineRolls.slackReady()` to `onTransportReady`. i18n gained `slack.offline.*` and
  `notify.offlineRolls` (ko, en; ja and es fall back, as the catalog allows). A ruling from the task's
  review: a `rolled` entry with no `switching` entry, a same-account respawn, says nothing about the roll
  itself, since a roll link alone is not evidence of an account switch, and the desktop count leaves it
  out as well. The offline strings say "While Astera was away from the Host" ("Astera 가 Host 와 끊겨
  있던 사이"), since a reconnect after a dropped socket fetches the journal too while the app stayed
  open. Pinned by
  `src/main/host/rollJournalSummary.test.ts`, `src/main/slack.test.ts`, `src/main/desktopNotifier.test.ts`,
  `src/main/host/offlineRolls.test.ts` and `src/main/host/outdated.test.ts`.

## Amendments (control plane follow-ups, 2026-09-25)

The follow-up plan `.superpowers/sdd/2026-09-25-cp-followups/plan.md` (Decisions U1, R1 to R5, in that
plan's own numbering) closed the F65 gap A56 above found: a fired run of a scheduled Job started no
coordinator, and nobody placed its Tasks. Its execution ledger is `progress.md` in the same folder, and
its two tasks' reports are `task-1-report.md` and `task-2-report.md`. Landed on `develop` from
`8296d9ba` through `bf479b4e`, with the final review's fixes after `960708ab` (`final-fix-report.md`,
A83 and A84). This list is the record, in A1's form; A56 and D2 point back here.

- **A79. U1: a schedule's fire runs a Job exactly the way `jobs run` runs one (plan U1, R1, R2).** The
  gap A56 found: `appDriven` needed `job.autoDispatch`, and a schedule never carried it, so a fired run
  started no coordinator and nobody placed its Tasks. What shipped: the coordinator hand-over that
  `run-start` and `jobs-run` already had moved into one closure, `handToCoordinator` (`command.ts`); the
  fire's own `run-spawn` calls it too, so a Job with a coordinator account gets one for every run its
  schedule fires, at the cost of one coordinator's usage per fire. A Job with no coordinator account has
  its fired run's `autoDispatch` stamped on the **Run itself**, not the Job, by `startJobRun` at fire
  time (`state.ts`); `placedByApp(job, run)` reads either field, and every "who drives this Run" question
  now goes through it. Stamping the Run rather than deriving the answer from the Job means an old
  on-disk scheduled Job needs no migration: only Runs fired from now on are placed, not the Runs a Job
  already fired before the fix, which would otherwise have started all at once with `ready` Tasks nobody
  had ever placed. R1: the `job.schedule !== undefined` clause left `runGatedForTask`, since a definition
  Task has no Run and `!run` already refuses it there; the review Gate's text no longer mentions a
  schedule template. Pinned by `dispatchLoop.test.ts`, `state.test.ts`, `reviewGate.test.ts` and
  `command.test.ts` (task-1-report.md).
- **A80. D2 replaced: the driving Host fires with no app attached (plan R5; the user's ruling U2).** D2
  said a schedule fires only while an app is attached, as today. R5, a controller ruling during Task 1,
  found that reasoning already overtaken by S4 and S5: a driving Host always has a spawner, so it can
  start coordinators and place workers with no app either way, and nothing left needs the old rule. The
  user confirmed it as U2, which replaces D2's choice: the Host fires whenever it drives, with or without
  Astera attached. D2's other reason is untouched: a Host with no client and no running work still leaves
  a minute after its last one, and an armed schedule alone is not "running work," so with Astera closed a
  schedule only fires while some Host happens to be up. What shipped: `driving.ts` fires on `mayStart()`
  alone; `hasApp()` is no longer asked. Pinned by `driving.test.ts`, replacing the old D2 test.
- **A81. U3: a fire is skipped, once, while the Job's latest run is still running.** `jobs run` already
  refuses a Job that is already running; a fire did not, so a cron-driven schedule could start a second
  run beside one still going. The user's ruling: skip the fire the same way, and log it, rather than
  double-running or silently doing nothing. What shipped: `run-spawn --run <jobId> --unless-running`
  answers `409 { error, jobId, running: <runId> }` and makes no Run; without the flag it behaves as
  before. `orchFireTick` sends the flag for every fire, logs `scheduled fire skipped job=<id>, its run
  <runId> is still running` once, and moves on. The skipped fire time is not retried: `firesDue` had
  already re-armed at `nextFireAt(rule, now)` before the skip is decided, so a skipped fire is neither
  retried on the next tick nor fired late. Pinned by `dispatchLoop.test.ts` and `command.test.ts`.
- **A82. One "moveable" rule for what counts as running, superseding A74's null-or-`limited` test
  (review ruling C1, plan U3).** A74 shipped `jobs-run` refusing when `waitEndingFor(...)` is `null` or
  `limited`. Review of this follow-up found that test both too broad and too narrow: a Run with no
  Tasks, or one whose coordinator died leaving `ready` Tasks nobody placed, is never `isTerminal`, so it
  read as running forever and every later fire or `jobs run` was refused for good; a Run only waiting on
  a Gate answered `null` and so read as not running, though nothing could move it without a person. What
  shipped: `runMoves(s, job, run, now)`, behind `runningRunOf(s, job, now)` (`command.ts`), used by both
  `jobs run` and a fire's `--unless-running`. A Run is not running once every Task is `isTerminal` (now
  exported from `view.ts`) or the Run or its Job is paused; otherwise it is running while any of these
  holds: a coordinator slot is attached, or its start is in flight; `placedByApp` is true and some Task
  is unfinished; a Dispatch is open; a Gate is open; a Task is `validating` or `reviewing`; the Run is
  `limited`. **Behaviour change:** a Run only waiting on a Gate now counts as running, so `jobs run`
  refuses it, where it used to allow it; a Run nothing can move (no coordinator, nothing placed, nothing
  open) does not count as running even with unfinished Tasks, where the A74 test would have refused
  `jobs run` on it forever. The coordinator-start half needed a new persisted marker,
  `JobRun.coordinatorStartingAt` (hidden from the public CLI's `RUN_FIELDS`, in `RUN_HIDDEN`): a fire or
  a rebased hand-over (▶, or a Job-id restart with nothing to release) sets it before the coordinator
  starts, `coordinatorStarting(run, nowMs)` treats it as live for `COORDINATOR_START_WINDOW_MS` (2
  minutes, `state.ts`), and a failure or the attach itself drops it. While it is live, a second ▶ or fire
  for the same Run answers 200 and starts nothing; a finished Run's ▶ does the same, since there is
  nothing left for a coordinator to manage. Pinned by `command.test.ts`, `view.test.ts`,
  `dispatchLoop.test.ts` and `orchDeps.test.ts` (task-1-report.md, fix rounds 1 and 2).
- **A83. A82's driver clauses ask whether the driver can still start a Task (final review I1, and the
  user's U4).** A82 counted a Run as running while `placedByApp` held and some Task was unfinished, and
  while a coordinator slot was attached at all. Both were too broad. In a Run the app places, nothing
  starts a failed Task again: `slotsToFill` takes `ready` Tasks only, and recovery acts on open
  Dispatches alone. And `recomputeReady` never frees a `pending` Task behind a dependency that failed
  for good. So one worker failure made the Run count as running for ever, and every later fire and
  `jobs run` was refused, which is C1 again by another road. A live coordinator on a Run with no Task it
  can start did the same: a Run made from an objective alone has no Task, and its coordinator is told not
  to make any (`handover.ts`). What shipped: the two clauses became one, "its driver can still start one
  of its Tasks" (`startable`, `command.ts`). The driver is the live coordinator, or else the app's loop
  when `placedByApp` holds. A Task it can start is `ready` under the circuit break, `pending` with every
  dependency still able to complete, or, for a coordinator only, `failed` under the circuit break or
  `dispatched` with its Dispatch closed, since only a coordinator retries (`worker-start --retry-of`).
  The start mark, open Dispatches, open Gates, checks under way and `limited` count as before. Pinned by
  `command.test.ts` (final-fix-report.md).
- **A84. U4: a scheduled Job's finished Run has its coordinator stopped, and a fire replaces a Run that
  has only its coordinator left (the user's ruling of 2026-09-25).** A79 costs one coordinator per fire,
  and nothing ever stopped one: each looped on `check --wait` after its Run finished, and each counted in
  the Host's live sessions, so a frequent schedule grew them without bound. What shipped, in three parts.
  (1) A new session command, `run-coordinator-stop --run <runId>`: it stops the Run's coordinator through
  the `stopCoordinator` dep Task 1 added, and empties the slot. It answers 409 while the Run still moves
  (A83), and 200 with `stopped: null` when no coordinator is attached. (2) The dispatch loop of the
  process that drives sends it once for each finished Run of a scheduled Job that still has a
  coordinator, after the slot pass and before the reap, asking `mayStart` before each stop, so the app
  and the Host never both stop one coordinator. (3) A fire (`run-spawn --unless-running`) of a scheduled
  Job whose latest Run is not running but still has a coordinator stops that coordinator and empties
  its slot. An unfinished Run is also paused, the way `runs stop` ends a Run, so it reads as stopped and
  `runs resume` takes it back. Then the fire makes the new Run on the state as it is after that. A
  stop that fails is logged and never thrown, and the slot is emptied anyway, so the Host has no
  unhandled rejection and a replaced Run does not keep a dead slot. **Scope (the controller's ruling):**
  only scheduled Jobs. A Run that `jobs run` starts for a Job with no schedule keeps its coordinator
  when it finishes, because a person may be reading its tab. **One rule for both callers:** a Run the
  fire would replace is one A83 already calls not running, so `jobs run` does not refuse on it either;
  it starts the next Run beside it and leaves that coordinator alone. **A paused Run shows no ▶**, and
  `run-start --run` on one answers 200 and starts nothing, so a replaced Run gets no coordinator by
  accident; `runs resume` takes it back. **The idle rule (final round 2, I-A):** state alone cannot tell
  a coordinator parked in `check --wait` from one doing the work itself on an objective-only Job, and a
  title spinner cannot either. So an unfinished Run is replaced at a fire, and `run-coordinator-stop`
  stops an unfinished Run's coordinator (a Run with no Tasks), only when the optional dep
  `coordinatorIdle(runId, sessionId)` answers `true`: that session has a `check --wait` for that Run in
  flight in the process that serves it. `false`, `null` or no dep keeps the plain U3 skip (409, logged
  "coordinator busy or unknown, skipped"). A finished Run needs no such check. The waits are recorded
  where `check --wait` is served: every CLI call reaches the Host, so the Host's command server holds one
  tracker for its life (`checkWaits.ts`, wired through `hostOrchDeps`), and a fire or loop stop the Host
  drives reads it. The app serves no session's `check`, so it records nothing. **When the app drives it
  asks the Host (final round 3):** its `coordinatorIdle` is a Promise that sends the new app-only
  orch-call `coordinator-idle { runId, sessionId }`, answered `{ idle }` from the Host's tracker beside
  `roll-state` (403 to anyone but the app, never a command layer command, never a receipt). It is
  gated on the new `HOST_FEATURE_COORDINATOR_IDLE`, which every Host announces, spawner or not
  (`hostFeatures`), read live at each ask (`hostSpeaksCoordinatorIdle`, `src/main/host/outdated.ts`).
  An older Host, one that is not connected, a call that fails or runs out the orch-call deadline
  (`HOST_UNRESPONSIVE_MS`), and any other answer read as unknown, so the fire skips
  (`src/main/host/coordinatorIdle.ts`). HOST_PROTOCOL stays 3. Also: a replaced Run is paused even when the exit release emptied its slot
  during the stop, and `run-coordinator-stop` asks `runMoves` again on the state after the stop and
  writes nothing (409) when the Run gained work meanwhile. Pinned by `command.test.ts`, `view.test.ts`,
  `dispatchLoop.test.ts`, `checkWaits.test.ts`, `host/orch.test.ts`, `host/features.test.ts` and
  `main/host/coordinatorIdle.test.ts` (final-fix-report.md).

## Amendments (chat takeover, 2026-09-26)

The chat takeover plan (`docs/superpowers/plans/2026-09-26-chat-takeover.md`, rulings P1 to P14) and its
spec (`docs/superpowers/specs/2026-09-26-chat-takeover-design.md`, decisions C1 to C3) close the S6 known
limit "Chat sessions are not taken over" (plan R20, this document's own "Known limits after S6"). Its
execution ledger is `progress.md`, and its ten tasks' reports are `task-1-report.md` through
`task-10-report.md`, all in `.superpowers/sdd/2026-09-26-chat-takeover/`. Landed on `develop` from
`e1dcd87a` through `3db032df`. This list is the record, in A1's form; the "Chat sessions are not taken
over" entry under "Known limits after S6" points back here.

- **A85. Spec §3.1: the adapters move to core (Task 1, plan P1).** The spec said `manager.ts`,
  `adapterCore.ts`, `claudeAdapter.ts` and `codexAdapter.ts` move to `src/core/chat/` unchanged, as a pure
  move (the S6 Task 2 pattern), so the Host can run the same adapters the app does; `nodeProcFactory.ts`
  stays with the app, the no-Host fallback. What shipped matches it exactly: `git mv` for the four files
  (`.ts` plus `.test.ts`), their import paths rewritten, and one header sentence added to each of the four
  production files naming the move, with nothing else changed (checked file by file). The two live
  adapter tests, `claudeAdapter.live.test.ts` and `codexAdapter.live.test.ts`, stay in `src/main/chat/`
  (P1): they import `nodeProcFactory`, which stays with the app, so moving them to core would make core
  import main; only their adapter import path changed. `src/host/importFence.test.ts` gained a case
  pinning that the four files live in `core/chat` and are inside the fence. Pinned by that test and the
  moved adapters' own tests, now in `src/core/chat/`.
- **A86. Constraint 3: one writer per chat process, and the Host's own adapter (Task 3, plan P13).** The
  spec said a chat process has exactly one writer, the app while it is attached and has adopted the proc,
  the Host in every other case, and that a Host-side adapter in the reader role decodes lines and never
  writes. What shipped: `src/host/procHolders.ts` (`ProcHolders`) tracks which greeted socket holds which
  proc, from its `proc-spawn` or `proc-attach`; a hold changes the writer only when it is placed or when
  the holding socket leaves (`appGone`), never when the proc itself simply ends (`ended` is bookkeeping
  only, so a session's own exit is not counted as a writer change). `src/host/hostProcs.ts` builds the
  Host's own `ProcLike` over `ProcRegistry` (`HostProcHandle`, `NotWriterError`): every `write` and
  `remember` asks `mayWrite()` first while an app socket holds the proc, and a refused write throws rather
  than being dropped in silence (review Important 3: a silently dropped write would leave the adapter's
  own state believing it had run; `adapterCore`'s `takeRequest` keeps the card open and a turn is left
  unmarked only because the throw reaches it). `kill` is never gated, since killing is the roller's act,
  not a writer's. `release()` cuts a handle off the registry, so a forgotten session's adapter decodes
  nothing further (the Task 2 review's carry). This needed `ProcRegistry.onLine` and `onExit` to become
  additive, each returning an unsubscribe (P13, `src/host/procRegistry.ts`), since the Host's chats and
  its proc holders both need to hear the same lines and exits, something the app's single listener slot
  never had to share. `claudeAdapter.ts`'s `doSend` now writes to the wire before it marks the turn
  `working`/pending, so a refused write starts no turn (codex's `doSend` already wrote first, through
  `core.request`). Pinned by `src/host/procRegistry.test.ts`, `procHolders.test.ts`, `hostProcs.test.ts`
  and `hostChats.test.ts`.
- **A87. Chat facts ride in the proc note, not in `RollSnapshot` (Tasks 2 and 4, plan P2, P4, P9,
  P14).** The spec's §3.3 said the chosen model, bypass, the permission policy and the claude transcript
  path "ride along" with a chat chain's roll snapshot. `parseRollSnapshot` is all or nothing and shared
  with ptys, and the permission policy changes independently of the chain, so what shipped is separate
  note keys beside the existing `roll` snapshot (whose `claude.transcriptPath` already carries the path):
  `chosenModel`, `unattendedPermission` (§3.5's policy), `carryOn`/`carrySent` (the roll's first turn and
  its sent marker) and `hostStarting` (A89). `bypassPermissions` and `bypassedToolchain` were already
  written. A note write is not gated on the `chat-takeover` feature (P9): it is storage, so an older Host
  merges it and never reads it, and the no-Host fallback simply has no note; only the calls
  (`chatPrompts`, `chatAnswer`, the deferred adoption) are gated. `ChatSessionManager.spawn` writes
  `carryOn` and `carrySent: false` when the prompt fits in `MAX_SNAPSHOT_PROMPT_CHARS` (the snapshot's
  bound); a longer prompt is not carried in the note at all, and neither key is written; whoever sends it marks `carrySent: true` before writing the turn, at most once, so a
  writer change across a roll cannot type the prompt twice (P4). A carry-on lost between that mark and
  its write, a crash in between with nobody left to notice, is not re-sent (known limit, below).
  `ChatSessionManager.adopt` now reads `chosenModel` back out of the note (P14): before this, an adopted
  session forgot the person's model pick entirely, so a roll after an app restart silently dropped it; the
  note key fixes that for the app too, not only for a Host takeover. `AdapterCore` gained
  `openRequests()`, and both adapters a `pending()` method, so a takeover pass can see a session's open
  cards before deciding anything about it. Pinned by `src/core/chat/manager.test.ts`,
  `adapterCore.test.ts`, `src/core/sessions/noteInfo.test.ts` and `chatRead.test.ts`.
- **A88. Takeover of chat procs (Task 5, plan P3).** The spec's §3.3 said the Host's takeover lists chat
  procs beside ptys and takes them the same way: a holders check, the mark `rolledBy: 'host'`, and the
  chain restored, all in one turn. What shipped, `src/host/takeover.ts`'s `takeOverChats`, run right after
  `takeOverSessions` in the same pass (`src/host/rollingWiring.ts`): a chat proc qualifies when it is
  alive, its note reads as a chat note, `chatInfoFromNote` parses it, its `unattendedPermission` is a
  value only a chat-takeover-aware app writes (the marker P3 uses for "an older app's chat procs are not
  taken", the way a missing snapshot marks a pre-S6 pty), no socket holds it, and the Host does not
  already hold it. Two things happen in one entry, in order. First, only when the note names a chain the
  Host does not already roll (`rollAccountIds.length >= 1`, `rolledBy !== 'host'`, no chain yet): the same
  snapshot checks S6 makes of a pty (a missing snapshot, other accounts, another current account) skip
  the proc as stalled; otherwise the mark is written and the chain restored, and a refusal or a throw from
  the restore takes the mark back. Second, always, whether or not a chain exists: the Host adopts an
  adapter on the proc, because answering a held prompt from the CLI needs one even with no rolling chain
  at all (P3). An adopt that fails after a chain was restored unregisters that chain and takes the
  `rolledBy` mark back too, so no chain is left rolling a proc the Host could not actually take an adapter
  on. `HostChats.adopt` replays the proc's buffered lines, then, only while the Host is the writer and
  only once, sends any unsent `carryOn`: it marks `carrySent: true`, counts the proc's writes around the
  synchronous part of the send, and, if nothing reached the wire (a codex thread not yet resumed, a
  refused write), puts the mark back to `carrySent: false` and logs that the prompt was left for the next
  writer rather than call it delivered. A proc that fails to adopt twice with an unchanged note is not
  retried every tick; it is logged once and left alone until its note changes or it ends (fix round 1,
  Minor 1). Pinned by `src/host/takeover.test.ts` and `hostChats.test.ts`.
- **A89. R20 lifted: the Host rolls chat sessions too (Task 6, plan P5, P11).** Plan R20 (S6) had the
  Host's rolling coordinators skip every chat chain outright. What shipped: `src/host/chatRollFeed.ts` is
  the Host side twin of the app's `core.chat.subscribe` block. A chat session prints no statusline and
  writes no limit record anywhere a probe can read, so the facts a pty chain gets from disk are pushed in
  from the adapter's own events instead: codex `ready` to `attachChat`; claude `ready` to `onChatMeta`,
  then a transcript lookup under the account's `configDir`, applied only while the session still names
  that thread; `status` to both coordinators, plus a claude lookup retry while none has landed;
  `rateLimit` to the claude coordinator's `onChatLimit`; `exit` to both `handleExit`, each call in its own
  try. `src/host/rolling.ts` routes a session to `chats` rather than a pty whenever `chats.has(id)` is
  true. `write` drops a bare `'\r'` (the Enter that follows a pty keystroke is a no-op for a turn already
  sent) and otherwise goes through `chats.deliver`, which picks the writer itself, the app's own
  `chatSend` when it is the writer and the Host's own adapter otherwise; a send the app's `chatSend`
  refuses is logged, not retried (known limit, below). `kill` goes to `chats.kill`. `mayAct` requires a
  live proc, `hostMayAct` over its holders, and no open request: spec §3.5's rule that while a prompt is
  open the chain neither resumes in place nor rolls, asked again on every tick, so a limit that arrives
  with a card open is simply dropped rather than queued; the CLI reports the same limit again on its next
  call once the prompt is answered (fix round 1, known limit). `rollSpawn` for a chat chain never opens a
  pty: it calls `chats.spawn` with `kind: 'chat'`, `rolledBy: 'host'`, `rolledFrom`, and the session's own
  bypass choice, never the settings file; with no `chats` configured it throws rather than falling back to
  the pty spawner (the Task 5 review's hard carry). A Host-spawned chat proc's note says
  `hostStarting: true` until its handshake and carry-on settle (P5): `HostChats.spawn` writes it, and
  `HostChats.started(id)`, awaited by the roll's push before it announces `session-rolled`, clears it
  directly through the proc note once the manager's own `started` chain resolves, so an app can never
  adopt a proc mid handshake and become its writer partway through a codex `thread/resume` (A94 on the
  bound). The push itself now carries `procId` (A93), for the app to adopt before it forwards the
  rekey, exactly as a pty roll's `ptyId` is adopted first, and is skipped with a log line if the new proc
  had already ended before it started. `hostMayAct` (`src/core/host/rollOwner.ts`) took an optional
  `yieldName`, so a chat chain's holders are asked for `HOST_YIELD_CHAT_TAKEOVER` rather than plain
  `HOST_YIELD_ROLLING` (P11): an app that yields rolling but not chat-takeover, and holds the proc, quiets
  the Host's chat chain the same way an older app quiets a pty chain, without touching its rolling of
  ptys. Pinned by `src/host/chatRollFeed.test.ts`, `rolling.test.ts` and
  `chatRolling.integration.test.ts`, the chat rig.
- **A90. The unattended permission policy (Task 7, plan P6, P12).** Spec §3.5 and C3: per session,
  `unattendedPermission` is `hold` (wait) or `deny-after-60s` (answer deny and let the turn continue), and
  it applies only while the Host is the writer. What shipped, `src/host/chatPolicy.ts`
  (`createChatPolicy`, `UNATTENDED_DENY_MS = 60_000`): a timer, keyed by session and request id, is armed
  for an open approval exactly when the policy is `deny-after-60s`, the Host is the writer, and the note's
  `answered` list does not already name it; `review` also cancels any armed timer whose conditions no
  longer hold. At the fire, every condition is asked again: the policy, the writer, whether the request is
  still open and still an approval, and the answered list, so an app that attaches at 59 seconds stops the
  deny even with no review call in between, and the 60 seconds the spec promises really are 60 seconds
  with nobody able to answer from Astera (P12: the clock starts at whichever is later, the request opening
  or the Host becoming writer). A deny that is rejected, or throws synchronously, is logged and never
  rejects its caller; because a rejected deny is not retried on a timer of its own, it is only picked up
  again at the policy's next review trigger, a request or status event, a writer change, or an adopt, not
  at once (known limit, below). `hostChats.ts` wires `review(id)` to every manager `request`/`status`
  event and `forget(id)` to `exit`; `holders.onChange` calls `reviewAll` over every session (P12, a writer
  change reviews them all); `adopt` calls `review` right after its replay and carry on. P6: only an
  approval can be denied this way. A question card is left alone by the policy entirely, since declining a
  question is not a permission decision, and `chats answer` on one is refused 409, "answer it in Astera"
  (A91), rather than silently denied. Pinned by `src/host/chatPolicy.test.ts` and `hostChats.test.ts`.
- **A91. `astera chats pending` and `astera chats answer`, and the Host's `HOST_CHATS` group (Task 8,
  plan P7, P10).** Spec §3.5: two new CLI commands, served by whichever process is a session's writer,
  with an answer forwarded to the app's adapter when the app is the writer. What shipped: `chats-pending
  [--session <id>]` lists every open prompt (session, prompt id, kind, tool and a one-line summary), and
  `chats-answer --id <promptId> --allow|--deny [--session <id>]` answers one. Both route through
  `HOST_CHATS` (`src/host/orchDeps.ts`): `chatPrompts` joins the Host's own list, the sessions it writes to
  itself, with an attached app's list, less any app entry for a session the Host writes (a proc has one
  writer, so the two lists can only overlap across a writer change, and the Host's own view of its own
  session wins); an app that cannot be asked degrades the answer to `complete: false`, logged, rather than
  failing the call. `chatAnswer` goes to the Host's own adapter when the Host is the writer, is forwarded
  to the app otherwise, and answers `not-held` with neither. P7: a prompt id is per process, since codex's
  request ids are small integers per app-server and two sessions can hold the same id `0`; an id open in
  more than one session is refused 400, "say which with `--session`", rather than guessed at. P10: with
  the Host as writer, `sessions send`'s turn and `sessions read`'s pending card go through the Host's own
  adapter rather than the raw pty-style write `chatSend` used before this, so a session with an open card
  refuses a send the same way the app does, naming the card, rather than typing behind it. `chats answer`
  is for a person (the controller's ruling, fix round 1): every caller inside an agent session, worker or
  coordinator alike, is refused 403, "run it from a shell, not from inside an agent session"; the shell
  (no `ASTERA_SESSION`, so an empty session id) and the app may call it. The check reads the caller's
  environment, and a chat CLI gets `ASTERA_SESSION` too since A94, so it is a guard against an agent
  answering by accident, not a boundary (known limit, below). `chats pending` stays open to
  every caller, as `sessions` does. An app holding the proc without the `chat-takeover` yield is not asked
  (fix round 1, Minor 2): forwarding to it would only fail as the Host's own generic error, after the
  funnel had already marked the answer as an effect, so it is refused `not-held` with "held by an Astera
  too old to be answered from the CLI, answer it in Astera" instead, and nothing is marked (known limit,
  below). The effect mark waits for the write (fix round 1, Important 2): `HostChats.send` and `answer`
  count the proc's writes around the synchronous part of the call and only fire their mark once that
  count actually grew, so a send or an answer that reached nothing leaves no receipt to retry against.
  Pinned by `src/core/orchestration/command.test.ts`, `src/host/orchDeps.test.ts`,
  `src/core/orchestration/cliPublic.test.ts` and `cliHuman.test.ts`.
- **A92. The app side: adopting a Host-rolled chat proc, and R8 for chats (Task 9).** What shipped,
  `src/main/chatAdopt.ts` (`chatAdoptPlan`) and its wiring in `src/main/ipc.ts`,
  `src/main/host/reattach.ts`, `hostRollView.ts` and `hostNativeGuard.ts`: a note marked
  `hostStarting: true` in front of a Host that speaks `chat-takeover` is left alone by the reattach sweep
  entirely, not adopted, not killed, no `proc-attach` sent (P5), and only picked up later once the Host's
  own roll clears the mark and pushes `session-rolled` with the new `procId` for the app to adopt before
  it forwards the rekey, exactly as it already adopts a pty roll's `ptyId` first. The rolling decision
  (R8, "ownership does not come back"): a note the Host marked `rolledBy: 'host'` in front of a Host that
  takes chats over stays the Host's; the app unregisters any chain it still held for it from before a
  socket drop and registers none of its own. Otherwise the app restores the chain from the note's
  snapshot, reported when the note is Host-marked in front of an older Host too, or registers fresh,
  exactly as the S6 pty adopter's three branches already do. The adapter is still `core.chat.adopt` either
  way, so the app stays the writer of turns and cards once it holds the proc; only who rolls the chain
  differs. The history guard (`hostNativeGuard.ts`) now also asks a chat proc's note for a native id it
  does not otherwise know, so a resume by history id is refused for a chat session the Host currently
  holds too, not only for a pty, but only for a chat the app itself already holds a live `SessionInfo`
  for; a Host chat proc the app has not adopted yet, deferred under P5 or simply never adopted, is found
  in the note but has no live session to return, so the resume goes ahead unguarded (known limit, below).
  The second tab (fix round 1, M1): if the reattach sweep's own `proc-list` lands before the Host's
  `session-rolled` push for the same roll, a race the sweep and the push do not otherwise order against
  each other, the app used to open a second tab for a chat session it already showed under its old id.
  What shipped instead: the sweep re-points the existing tab. `chatAdoptPlan` gains `repoint`, the note's
  `rolledFrom` when the note says `rolledBy: 'host'`, the app holds that old session, no push is already
  adopting this proc, and the app does not already hold the new id (a reconnect that re-adopts an already
  re-pointed chat must not rekey a second time); `announce`, whether `session:created` is sent for the new
  id, is false whenever `repoint` is set. `hostRollView.repointed` forwards the rekey through the same
  path a push uses, moves the roll-state banner onto the new id, and records the pair so that a
  `session-rolled` push which follows for the same roll adopts it and settles the old tab's exit as usual
  but does not forward the rekey a second time, so there is no duplicate Slack notice and no duplicate
  scheduler rekey. The re-point carries no codex `dest`, because the note does not keep one: for a codex
  chat roll, the rollout watcher's re-register falls back to its own search until the chat's own `ready`
  registers the path (known limit, below). Pinned by `src/main/host/reattach.test.ts`,
  `hostRollView.test.ts`, `hostNativeGuard.test.ts` and `src/main/chatAdopt.test.ts`.
- **A93. §7.2's additions.** The table has no chat-takeover rows. What shipped, none of it a protocol
  bump, `HOST_PROTOCOL` stays 3: the feature `chat-takeover` in the Host's hello, announced exactly when
  `rolling` is (`src/core/host/protocol.ts`, `src/host/features.ts`); the `hello.yields` value
  `chat-takeover`, from an app that defers a Host-starting chat proc, leaves a Host-marked chat chain to
  the Host, and answers `chatPrompts` and `chatAnswer`; `session-rolled` gains `procId?: string`, the new
  chat session's proc, for the app to adopt before it forwards the rekey, as `ptyId` already is; two new
  `orch-act`s, Host to an attached app, role app only, `chatPrompts` and `chatAnswer` (`HOST_CHATS`, A91);
  and the note keys `unattendedPermission`, `chosenModel`, `carryOn`, `carrySent` and `hostStarting` (A87,
  A89), read and written by whichever side is the writer. See the row added to §7.2's table below.
- **A94. After the final review and the end to end run.** What changed, each with a test that failed
  first:
  - *The start bound (I1).* `HostChats.started` no longer gives up after 45 s. A codex handshake is a
    chain of requests, each allowed `CHAT_REQUEST_TIMEOUT_MS` (30 s), so a slow machine could still be
    starting when the old bound cleared `hostStarting` and pushed the roll, and the carry-on was then
    left for a writer that never sent it. The bound is now `CHAT_START_PUSH_MS`, six request deadlines
    (initialize, the two lists, `thread/resume` and the carry-on's `turn/start`, plus one as margin).
    Until the start settles the mark stays and nothing is pushed; a start that has not settled by then
    is killed, the mark is left, and the roll is not announced.
  - *The app sends a carry-on the Host left (I1).* `ChatSessionManager.sendCarryOn` sends an adopted
    note's `carryOn` whose `carrySent` is false, not while `hostStarting`, by P4's rule: marked sent
    before the write, the mark taken back when no line reached the proc. The app calls it through
    reattach's `afterAttachProc`, right after its `proc-attach`, only for a Host-rolled note in front of
    a Host that speaks `chat-takeover` (`hostCarryOnIsOurs`).
  - *A Host roll reads the note (I2).* The respawn's unattended policy and `chosenModelOf` read the note
    first, as `unattendedOf` already did: while the app is the writer, the person's changes reach only
    the note.
  - *`ASTERA_SESSION` for chat CLIs (I3).* `ChatSessionManager.spawn` sets it to the session id in both
    the app and the Host, as a pty session has it, whether or not orchestration is on. Nothing relied on
    a chat agent reading as the shell.
  - *Takeover of a held, chainless proc (M1).* A proc the Host already holds an adapter on, with a chain
    it does not roll, gets the chain part again (mark and restore from the snapshot), without a second
    adopt. The restored chain starts from the snapshot alone, as a pty restore does.
  - *The answered filter (M2).* `HostChats.requests` and `hasOpenRequest` leave out the ids the note
    lists as answered, as `prompts` does.
  - *The app's `chatAnswer` failures (M3).* Only "no open request" is `not-open`; any other failure is
    `not-held` (`chatAnswerFailureOf`, shared with the Host).
  - *The chat roll push (M4).* A `session-rolled` carrying `procId` goes only to the sockets whose hello
    yields `chat-takeover`. An older app is not sent it.
  - *`chatSend` routes like `chatPending` (M5).* A session the Host writes to is sent through the Host
    adapter even with an app attached.
  - *`rolling.json` writes (E1).* One write at a time per file, a set made while a write waits rides along
    with it, and a rename refused with EPERM, EBUSY or EACCES is tried again up to five times.
  - *The unattended deny's words (E2).* The CLI is told that no one answered within 60 seconds and Astera
    denied the prompt automatically (`UNATTENDED_DENY_MESSAGE`), not "User declined in Astera". Codex's
    answer carries no text.

## Amendments (Slack in the Host, 2026-09-26)

The Slack in the Host plan (`docs/superpowers/plans/2026-09-26-slack-in-host.md`, rulings P1 to P18) and its
spec (`docs/superpowers/specs/2026-09-26-slack-in-host-design.md`, decisions S1 to S5) let Slack keep working
while Astera is closed: turn notices, rolling notices, replies that become the next turn or keystrokes, and
answers to permission cards, for a tab and a chat session alike. Its execution ledger is `progress.md`, and its
tasks' reports are `task-1-report.md` through `task-8-report.md`, all in
`.superpowers/sdd/2026-09-26-slack-in-host/` (Task 9 is this document, Task 10 the end to end run and CI).
Landed on `develop` from `ce533d36` through `633be4b5`. This list is the record, in A1's form.

- **A95. §3.1 moves, and the SDK split (Task 1, plan P1 to P3).** The spec's §2 read the three Slack files as
  importing no electron, true, but `slackTransport.ts` and `slackInbox.ts` import `@slack/web-api` and
  `@slack/socket-mode` statically (a contradiction, plan ruling P1): moved as they stood, the Host bundle would
  carry a top-level `require('@slack/...')`, and a Windows runtime shipped by an older build, whose node
  directory has no `@slack` and which a running Host locks against repair, would fail with MODULE_NOT_FOUND
  before the Host could log a line, no Host at all. What shipped: `git mv` of `src/main/slack.ts`,
  `slackInbox.ts`, `slackTransport.ts` and `codexRolloutWatcher.ts` (each with its test) to
  `src/core/slack/notifier.ts`, `inbox.ts`, `transport.ts` and `src/core/sessions/codexRolloutWatcher.ts`;
  `createWebClient` and `createSocketClient` carved out into new `src/main/slackSdk.ts`, the app's own static
  `@slack/*` imports, so no file under `src/core` imports the SDK. `slack.json`'s read half is carved into
  `src/core/slack/config.ts`'s `SlackConfigReader` (`load()`, a protected `read()`), and
  `src/main/slackConfigStore.ts`'s `SlackConfigStore extends SlackConfigReader` keeps `save()` and `patch()`
  (P2): the Host has no object that can write the file. With no `createPoster` a bot config selects no
  transport (P3): `applyConfig` logs `slack: no poster for bot mode` and calls `replaceTransport(null)` rather
  than defaulting to `createWebClient` as it used to. Pinned by `src/host/importFence.test.ts`'s new case (the
  moved files live in core, none imports `@slack/`), and the moved files' own tests, now
  `src/core/slack/*.test.ts`, `src/main/slackConfigStore.test.ts` and `src/main/slackSdk.test.ts`.
- **A96. §3.7's "resolved dependency closure" (Task 2, plan P14).** The design's own words undercounted:
  `@slack/*` declare `@types/node` and `@types/retry` as runtime dependencies, and `@types/node` pulls
  `undici-types`, none with runtime code, several MB together. What shipped: `scripts/host-runtime-scan.mjs`
  gained `dependencyClosure(root, names, { allowNative })`, replacing `scripts/host-runtime.mjs`'s old
  one-level-only copy: it resolves the way Node does, from each package's own directory up, skips `@types/*`
  and `undici-types` (P14), counts installed optional dependencies and non-optional peers, and throws on a
  required package that is missing or on a native module other than `node-pty` (a `binding.gyp`,
  `gypfile: true`, or a `.node` file outside its own nested `node_modules`). The copy keeps a package's nested
  `node_modules` exactly where npm put it, because a nested package is an entry of the closure in its own
  right. Measured for real: the runtime tree carries `@slack/socket-mode`, `@slack/web-api` and `undici`, with
  nested copies such as `@slack/web-api/node_modules/retry` and `p-queue/node_modules/eventemitter3` kept in
  place, and no `@types` directory anywhere. Pinned by `scripts/host-runtime-scan.test.mjs`.
- **A97. `slack-owner`, the `slack` yield, `slack-event`, `slackChatAnswer`, the SDK load and the API URL seam
  (Task 3, plan P4, P15, P17).** What shipped in `src/core/host/protocol.ts`: the feature
  `HOST_FEATURE_SLACK_OWNER = 'slack-owner'` (announced with `spawn`, and only by a Host whose SDK loaded), the
  hello yield `HOST_YIELD_SLACK = 'slack'` (P4: the Host holds its socket and posts only while
  `server.appsKeep(HOST_YIELD_SLACK)` is false, so an older app in front of a Slack-owning Host, a case §3.8
  left open, opens its own socket before its hello and briefly shares the token with the Host, known limit,
  below), the app-only orch-act `HOST_ACT_SLACK_ANSWER = 'slackChatAnswer'` (P10, answered beside
  `HOST_ACT_PATH_IN_USE`, not an `OrchServerDeps` name), and the client message
  `{ t: 'slack-event'; event: SlackForwardedEvent }` (P17, beside `blocks`: fire and forget, taken only from a
  greeted app, a malformed one ignored and logged once). `src/host/slackSdk.ts`'s `loadSlackSdk` loads the SDK
  once at Host start with literal `import('@slack/web-api')` and `import('@slack/socket-mode')` calls (so the
  runtime scan's `bundlePackages` sees both names, the `@xterm/headless` precedent) and never rejects: a
  failed import is logged by error name only, never the message, and the Host then runs with no Slack and
  announces no `slack-owner` (Review Focus 5). `slackApiUrlFrom` (`src/core/slack/apiUrl.ts`, P15) honours
  `ASTERA_SLACK_API_URL` only on `http:`/`https:` at `127.0.0.1`, `localhost` or `[::1]`, so a token can never
  be sent anywhere else; both SDK constructors, the app's and the Host's, pass it through, the socket client
  through `clientOptions.slackApiUrl`. `hostFeatures({ spawns, slack })` in `src/host/features.ts` appends
  `slack-owner` only when both hold, and `hostSpeaksSlackOwner` in `src/main/host/outdated.ts` reads it by
  `hostSpeaksRolling`'s own rule, so an unresponsive Host still owns Slack. `HOST_PROTOCOL` stays 3. Pinned by
  `src/core/slack/forwarded.test.ts`, `apiUrl.test.ts`, `src/host/slackSdk.test.ts`, `features.test.ts`,
  `src/main/host/outdated.test.ts`, `src/main/slackSdk.test.ts` and the widened `src/host/importFence.test.ts`.
- **A98. §3.5, threads in the note (Task 4, plan P8, P9).** The spec's "on a roll the entry moves to the new
  session id with the rest of the note" assumed a note is copied on a roll; none is, a rolled pty's or proc's
  note is built fresh from the spawn options, in two coordinators and two spawn paths (a contradiction, plan
  P8). What shipped: `src/core/slack/threadNote.ts`'s `NotedThread`, `notedThreadOf` and `threadNotePatch`;
  `SlackNotifier` gains a `channel`, a private `note()` and `seedNoted()`, and `register(info, { thread })`
  seeds the record from a noted thread in the current channel before opening a root, dropping a thread noted
  in another channel; `onRolled` notes the new id's thread once the inherited root resolves, one place for the
  app's rolls and the Host's alike. The thread keys are written by whoever owns Slack, ungated, through the
  registry's own note (P9): the Host with `registry.note`/`procs.note` directly, the app through
  `core.sessions.remember`/`core.chat.remember`; a note is storage, merged per key. Both app adopters (the pty
  and the chat adopter) now call `register(info, { thread: notedThreadOf(a.restore) })`. Pinned by
  `src/core/slack/threadNote.test.ts`, `src/core/slack/notifier.test.ts` and a text guard in
  `src/main/chatAdopt.test.ts`.
- **A99. §3.2 and §3.4, the Host's composition, the registries' `onMeta`, the read-only reader and
  `slack-reload` (Task 5, plan P7, P16).** The spec's "register/forget follow the Host's own session list"
  assumed the registries already announce a session; neither `PtyRegistry` nor `ProcRegistry` did (a
  contradiction, plan P7). What shipped: both gain an additive `onMeta(cb)`, fired at `open` with a note and
  after every `note` merge, isolated like `onData`; `src/host/slackSessions.ts`'s `createHostSlackSessions`
  registers a live entry whose note reads as a session with `slackNotify: true`, with its noted thread, renames
  a known one from its note, and holds a rolled entry's new record back while the notifier still holds the
  session its `rolledFrom` names, so the periodic `reconcile()` is the net that catches it once the old record
  is gone. Registration runs only while the Host is active, an addition beyond the brief: a record made while
  an app keeps Slack would hold `noted: null`, and the activation would post a second root, exactly Review
  Focus 4's failure, so `createHostSlackSessions` takes an `active()` gate and only the activation's own
  `reconcile` registers from the notes as they stand at that moment; output and exits are still fed while
  inactive. `src/host/slackWiring.ts`'s `composeHostSlack` serializes every ownership change through one
  `settle` queue, reading `server.appsKeep(HOST_YIELD_SLACK)` when it runs: active builds the config read,
  `applyConfig`, `inbox.apply`, then `reconcile`; inactive tears the transport and the inbox down.
  `hostSlackLog` writes `<profile>/slack.log`, lines prefixed `[host]` (P16, the twin of S6's shared
  `rolling.log`). `HostOrchDeps.slack` answers the app-only orch-call `slack-reload` beside `roll-journal`: 403
  to a non-app caller, 501 with no Slack, 400 with a request id, otherwise 200 `{ reloaded, active }`. Every R3
  wrapper the constraint asks for is in place (`getAccount`, `readStatusPayload`, `lang`, `log`, a throwing
  `createClient`, a throwing `appsKeep` read as "keeps"). Pinned by `src/host/registry.test.ts`,
  `procRegistry.test.ts`, `slackSessions.test.ts`, `slackWiring.test.ts` (including the two single-socket
  races, Review Focus 1's Host half) and `src/host/orch.test.ts`.
- **A100. §3.3, the Host's sources and the forwarded intake (Task 6, plan P6, P11 to P13).** What shipped: the
  exit of every session, terminal and chat, is the Host's alone (P6, the notifier already reads an exit only
  through `handleExit`, never `onChatEvent`), so the app forwards only the four chat events the notifier reads
  (`ready`, `status`, `request`, `error`, `isForwardedChatEvent`), never an exit. `src/host/slackSources.ts`'s
  `createHostSlackSources` feeds the notifier from the hook watcher (through a new `HostRollingDeps.hookTap`),
  the Host's own codex rollout watcher, `HostChats` events and the Host's own rolling chains'
  `roll-state`/`session-rolled`, and drops a forwarded event for a session the Host sources itself, so a notice
  is posted once whichever side saw it (Review Focus 2), pinned past the notifier's own 10 minute dedup window
  by a clock that moves 11 minutes between the two copies. A forwarded chat event carries its `accountId` and
  the transcript path the app already knows at forward time (P11), because the app's own path getter cannot be
  re-read from a forwarded snapshot; the Host resolves a missing claude path itself with
  `findClaudeTranscript`, retried on `status`. The Host's own codex rollout watcher watches only a codex
  terminal session with `slackNotify` (P12, the app's own watcher stays for its usage chips, which the Host
  has no use for), and, departing from the brief, only once the session's note names a `rolloutPath`, never
  from a `since: now` scan: such a scan cannot find a file created before a late registration and would race
  the Host spawner's own locate at spawn time, so `codexRolloutFromNote` moves to core with the watcher (P13,
  `src/main/ipc.ts` re-exports it) and the watch starts from the registries' new `onNoted` hook instead. Pinned
  by `src/host/slackSources.test.ts`, `rolling.test.ts`, `rolling.integration.test.ts` and
  `src/host/slackWiring.test.ts`.
- **A101. §3.4, inbox routing and the card answers (Task 7, plan P10, P18).** The spec's "the same writer rule
  as chats answer" shares the rule, not the payload (a contradiction, plan P10): `chats answer` answers
  approvals only, and `chatAnswer` carries `allow|deny`, but a Slack reply answers a question's numbers too, as
  the app's inbox does today. What shipped: `HostChats.answerCard(sid, requestId, ChatAnswer)`, refused "not the
  writer" with nothing written when the Host is not the writer, otherwise routed through `manager.answer` so
  the adapter's own `request` event reviews the unattended policy and the policy's timer re-reads the open
  list; `src/host/slackRoutes.ts`'s `hostInboxRoutes` types a terminal reply into its pty through the registry,
  and delivers a chat reply or a card answer through the Host's own adapter when the Host is the writer,
  otherwise through the app (`chatSend` for a turn, the new `slackChatAnswer` orch-act for a card), refused
  with "nobody holds this session right now" when no app is attached. Which card a reply answers (P18):
  `HostChats.requests` (less the note's answered ids) for a session with a Host adapter, otherwise the card the
  notifier last heard from a forwarded `request` event (`chatRequestOf`). `src/main/slackAnswer.ts`'s
  `answerSlackCard` never rejects, and answers `bad-args`, `not-held`, or `not-open` for "no open request"
  specifically. Beyond the brief: `answerCard` also refuses a card the note already lists as answered, so a
  second answer to one is never applied twice. Pinned by `src/host/hostChats.test.ts`, `slackRoutes.test.ts`,
  `src/main/slackAnswer.test.ts`, the widened `notifier.test.ts` (`chatRequestOf`) and `slackWiring.test.ts`.
- **A102. §3.2 and §3.6, the app's ownership and the offline gate (Task 8, plan P5).** What shipped:
  `src/main/slackOwnership.ts`'s `createSlackOwnership` replaces the start time
  `slackStore.load().then(...)`: the app applies no config until `hostSessionsTakenBack` settles, or yields at
  once to a `slack-owner` status seen before then, and after a Slack-owning Host stops being there it waits
  `SLACK_HANDBACK_MS` (15 s) before building its own socket, cancelled by a `slack-owner` handshake inside the
  wait (P5). Three intakes are gated on `owner() !== 'host'`: the codex turn callback, the hook fan-out's Slack
  tap, and the roll tap (which forwards instead, as `slack-event`, while the Host owns). `slack.setConfig` now
  sends the app-only `slack-reload` call after the file write, and the offline summary's Slack line is skipped
  while `hostPostsSlack()` (`src/main/host/offlineRolls.ts`), so the desktop aggregate still sends but Slack
  does not get a duplicate. The app's hello gains the yield `HOST_YIELD_SLACK` (`src/main/host/client.ts`),
  left out while the app itself keeps Slack, a fix beyond the brief, below. Beyond the brief, three carries:
  the chat bypass retry now carries the noted thread forward (`ChatSessionManager.remember` copies the thread
  keys, `THREAD_NOTE_KEYS`, into `live.retry`, a new `spawnNote(id)`), closing Task 4's own concern about a
  second root after a bypass respawn; an app's forwarded roll and its new pty's note are proven to land in
  either order with no second root, because the coordinators already send `session:rolled` synchronously right
  after the spawn; and `helloKeeps()`, an addition the brief did not carry, makes the app's hello omit the
  `slack` yield while the app itself still holds the socket, so a yield sent on every hello cannot make the
  Host open a second socket the instant before the app's own asynchronous teardown finishes (known limits,
  below). Pinned by `src/main/slackOwnership.test.ts` (Review Focus 1, the app half of the single-socket
  invariant), `offlineRolls.test.ts`, `client.test.ts`, `src/core/chat/manager.test.ts` and
  `slackWiring.test.ts`.
- **A103. §7.2's additions.** The table has no Slack-in-the-Host rows. What shipped, none of it a protocol
  bump, `HOST_PROTOCOL` stays 3: the feature `slack-owner`, announced with `spawn`; the `hello.yields` value
  `slack`, sent by a new app once its startup chain settles or it keeps Slack itself; the client message
  `{ t: 'slack-event'; event: SlackForwardedEvent }`, from a greeted app to a `slack-owner` Host only; the
  app-only internal `orch-call` `slack-reload` beside `roll-journal`; the internal `orch-act`
  `slackChatAnswer` (`HOST_ACT_SLACK_ANSWER`), Host to app, role app only; and the note keys `slackThreadTs`
  and `slackChannel`, read and written by whichever side owns Slack. See the row added to §7.2's table below.
- **A104. After the final review and the end to end run.** Not run as of this document: Task 9 (this document)
  lands before Task 10, the end to end pass with a fake Slack and CI on three OS. Recorded here, in A94's
  form, once Task 10 completes.
- **A105. The final review's fixes (report `final-fix-report.md`, same folder).** The whole-branch review
  found one critical, one important and four minor faults, and Task 10's run found a fifth notice fault. What
  shipped:
  - **The SDK's own reconnect is off, and the inbox reconnects itself.** Socket mode's auto-reconnect called
    its own `start()` from a timer and dropped the promise, so a reconnect that failed for good
    (`invalid_auth` after the app token was regenerated, `account_inactive`, or the SDK's network retries used
    up) was an unhandled rejection, and on the Host's node.exe that ends the process and every session in it.
    Both SDK constructors (`src/host/slackSdk.ts`, `src/main/slackSdk.ts`) now pass
    `autoReconnectEnabled: false`. `SlackInbox` (`src/core/slack/inbox.ts`) builds a fresh client after a
    drop or a failed start, waiting `reconnectDelayMs`: 1 s doubling to a cap of 5 minutes, reset by a
    connection. A start error Slack will never accept (`not_authed`, `invalid_auth`, `account_inactive`,
    `user_removed_from_team`, `team_disabled`) is logged and stops the retries until the config is applied
    again, a settings save in the app or the Host's `slack-reload`, which `SlackInboxController.apply` now
    rebuilds even with an unchanged key. Every start ends in a catch. A stop cancels a pending retry, and a
    start that resolves after a stop closes what it opened, so no socket outlives a deactivation. The
    controller no longer waits for the first start before it takes the next apply or stop, so a start that
    is slow to answer never holds a stop behind it.
  - **The WebClient inside the socket client retries nothing itself** (`SOCKET_WEB_CLIENT_OPTIONS` in
    `src/core/slack/inbox.ts`, passed as `clientOptions` by both constructors; found by the reconnect e2e run,
    report `reconnect-e2e-report.md`). Socket mode gives that WebClient `{ retries: 100, factor: 1.3 }` with
    no ceiling and no timeout, so an HTTP 500 or a network error on `apps.connections.open` was retried inside
    `start()` with waits that grow past an hour. The inbox's backoff and its 5 minute cap never ran, and a stop
    could not end that loop, so a client replaced by a token change kept calling with the old token. With
    `retries: 0` and a 10 s timeout, `start()` rejects at once and every retry is the inbox's.
  - **The Host logs a rejection nobody handled and keeps running** (`logUnhandledRejections` in
    `src/host/log.ts`, installed as soon as the Host log exists). This replaces the plan's constraint 5
    wording that the Host has no such handler. It is a belt only: every path still ends in its own catch.
  - **A fresh Host takes Slack only after the first app hello, or after `HOST_SLACK_START_GRACE_MS` (10 s)
    with no app** (`src/host/slackWiring.ts`). A Host that took Slack at start opened a second socket beside
    an app that held Slack (the upgrade path, or a respawn after an outage longer than the hand-back grace),
    and a reply Slack routed to it was answered "this session has ended". The app that spawned the Host says
    hello within milliseconds; a headless `astera host start` takes Slack when the grace ends.
  - **While the Host stays active, a hello, a close or a reload applies the config again only when it
    changed.** Applying it again built a new transport and reset every record's thread, so a root still in
    flight was lost. The inbox is still handed every reload, which is what retries a refused token.
  - **Nothing forwarded is lost while the Host is away.** In the app (`src/main/slackOwnership.ts`) a forward
    made while the Slack-owning Host is not connected is held (at most 200) and sent when it answers again,
    or told to the app's own notifier (`hearForwarded`, `src/core/slack/forwarded.ts`) when the hand-back
    grace ends and the app takes Slack. In the Host, a forward that arrives while a settle is still in the
    queue waits behind it, so a card forwarded while the Host is taking Slack reaches a registered record.
  - **A settings save made before a Slack-owning Host can hear it is owed to it.** A save while ownership is
    undecided, or while the Host is away, is sent as `slack-reload` the next time a Slack-owning Host answers,
    and every save is sent to a Slack-owning Host that is there, even one that is not active.
  - **The API URL seam takes only the literals `127.0.0.1` and `[::1]`.** `localhost` (still named in A97)
    resolves through the hosts file, so it is not a guaranteed loopback, and the seam is honoured in
    production builds.
  - **A chat limit that the rolling chain handles posts nothing from the chat path.** Task 10's run saw the
    switch notice followed by "turn failed" and "Response complete", both over the limit text. In a chain
    (`rollAccountIds`), the notifier's `onChatEvent` now stays quiet on an error that reads as a limit by the
    provider's own scanner, or a rejected `rateLimit`, and skips that turn's summary; the next turn is
    announced as usual. The terminal path's StopFailure already stayed quiet on the same rule, and a session
    outside a chain still posts both.
  Pinned by `src/core/slack/inbox.test.ts` (a reconnect whose start rejects leaves no unhandled rejection,
  the backoff grows and is capped, a stop during a retry builds nothing, a start that resolves after a stop
  is closed, `invalid_auth` halts until the next apply), `src/host/slackSdk.test.ts`,
  `src/main/slackSdk.test.ts`, `src/host/log.test.ts`, the index.ts guard in
  `src/host/driving.integration.test.ts`, `src/host/slackWiring.test.ts` (the start grace both ways, no
  re-apply, a forward during activation), `src/main/slackOwnership.test.ts`, `src/core/slack/forwarded.test.ts`,
  `src/core/slack/apiUrl.test.ts` and `src/core/slack/notifier.test.ts`.

## Amendments (remaining limits pass, 2026-09-26)

The plan `.superpowers/sdd/2026-09-26-limits-pass/plan.md` (Decisions L1 to L5, in that plan's own
numbering) closed five of the "Known limits" below that a person is most likely to hit, ranked
2026-09-26 by impact, effort and risk. Its execution ledger is `progress.md` in the same folder, and its
three tasks' reports are `task-1-report.md` through `task-3-report.md`. Landed on `develop` from
`ee46dd4d` through `68a2bfca`. This list is the record, in A1's form; the limits it closes point back
here.

- **A106. L1: a coordinator stop is retried until the session is gone, not asked once (task-1-report.md).**
  Confirmed first: `askedToStop` added a session before its stop and never removed it, so a failed or
  refused stop was never sent again by that process; `retireCoordinator` emptied the slot
  (`detachCoordinator`) even when `stopCoordinator` threw; and the Host's own `stopCoordinator`
  (`orchDeps.ts`) swallows its own failures, so "the stop failed" is often invisible to the command
  layer. What shipped: a new `JobRun.coordinatorStopPending?: string` (`types.ts`, hidden from the CLI's
  public run fields in `cliPublic.ts`; `detachCoordinator` and `attachCoordinator` drop it, a roll's rekey
  carries it). `retireCoordinator` no longer empties the slot in either caller (`run-coordinator-stop` and
  the fire's replacement in `run-spawn`): it writes `coordinatorStopPending` when the slot still names the
  session, and `paused` when asked; the exit release (`coordinatorReleaseOf`, the boot sweep) empties the
  slot once the stop is confirmed. With a pending mark, `run-coordinator-stop` skips the idle check only
  while the decision still stands: the Run was replaced and is still paused, or its work is finished.
  Otherwise it asks the idle check again, as for a fresh stop, and a busy answer drops the mark, since a
  Run neither paused nor finished is one a person or its coordinator has taken back (final review I2).
  `runs resume` drops the mark itself (`resumeRun`), since a replaced Run with no Tasks does not move and
  so never reaches that rule and would otherwise keep a coordinator a person just took back stopped about
  30 seconds later; the Run moving again still refuses the stop as before and the mark is dropped then too
  (`dropStopPending`). `dispatchLoop.ts` replaces `askedToStop` with an in-memory backoff map per session
  (`COORDINATOR_STOP_RETRY_MS` 30 seconds, doubling, capped at `COORDINATOR_STOP_RETRY_MAX_MS` 10
  minutes), pruned once a session leaves every slot. The new `tidyCoordinators` (stale marks, then stops;
  see A107) is guarded against overlap, asks `mayStart` before each step and each stop, and runs from the
  pass, in place of the old `stopFinishedCoordinators`, and from `nudge`, since the app runs the pass only
  on commits while its own timer calls `nudge`. A follow-up asks a new optional context member
  `sessionGone` before each stop: the Host answers from an ended pty in its own registry
  (`sessionExitCode`); the app answers from its session list, which must show the session exited with a
  real exit code. Once gone, the loop sends `run-coordinator-stop --gone <sessionId>`, which empties the
  slot and drops the mark with no stop sent, only while the slot still names that session; a
  replacement's `paused` mark, already written together with the pending mark, stays. A lost-sight exit,
  or a session this process never held, does not count as gone, so such a slot keeps being retried at the
  10 minute cap (see "Known limits after the limits pass"). Pinned by `dispatchLoop.test.ts` ("a
  coordinator stop is retried until the session is gone (L1)": a failed stop retried after backoff and
  succeeds, a refused stop retried, the slot kept pending, the exit release clears the mark and nothing is
  sent after, `nudge` retries, a non-driving process does nothing) and `command.test.ts` (five L1 cases,
  the last two added once `runs resume` and a retry's idle check were corrected (final review I2): `runs
  resume` on a replaced Run drops its pending stop, so the retry no longer stops that coordinator, and a
  pending stop on a Run neither paused nor finished asks the idle check again, dropping the mark when it
  answers busy; six existing U4 cases updated to the kept-then-released slot).
- **A107. L2: a stale `coordinatorStartingAt` marker is cleared by the driving loop's own pass
  (task-1-report.md).** `coordinatorStarting` already read a marker past `COORDINATOR_START_WINDOW_MS` as
  dead, so a ▶ or a later fire could try again, but nothing ever cleared the field itself, so the sidebar
  kept hiding ▶ until the Run's next commit. What shipped: a new internal command
  `run-start-marks-clear` (`COORDINATOR_ONLY`, a `SESSION` entry in `cliAgentContext.ts`, required by the
  `SwitchedCommand` compile check) drops every start mark past its window on the current state, from
  `tidyCoordinators`, the same pass and `nudge` call A106 added, so only the one process that may start
  something acts (`mayStart`). It answers in `astera agent-context` as a session command; harmless if
  called by hand. Pinned by `dispatchLoop.test.ts` ("a stale coordinator start mark is cleared by the pass
  (L2)": the pass and `nudge` clear a stale mark, a fresh one is kept).
- **A108. L3: a parked or unresponsive Host tells the app so, and the Jobs sidebar says why nothing moves
  (task-2-report.md).** Both were already true with nothing surfacing them: `driverOf` parks on gate
  `not-migrated` or `unreadable`, and the driving in `src/host/driving.ts` starts parked with
  `lastGate === null` until its first settings read, but the driver was reachable only through the
  `status` orch-call, which the app never asked, and `HostStatus.unresponsive` already reached the
  renderer (`host.status`, the `host:status` push, held in `App.tsx` as `hostStatus`) with nothing in the
  Jobs sidebar reading it. What shipped, additive and feature-gated, `HOST_PROTOCOL` stays 3: a new
  feature `HOST_FEATURE_DRIVER = 'driver'`, announced with `dispatch` (spawner only, exactly when the
  driving exists), and a new `HostMessage { t: 'driver', driver, gate }` (`HostDriverReport` in
  `core/types.ts`; `gate` is the last settings gate read, `null` before the first one). `createHostDriving`
  gets `onReport`, told on each change of driver or gate, a throw only logged, and `report()`;
  `composeHostDriving` broadcasts it to every greeted app that yields dispatch, and exposes
  `appGreeted(send)`, wired beside the rolling's in `index.ts`'s `onAppGreeted`, so a newly greeted app
  gets the current report at once. The app's new `src/main/host/hostDriver.ts` reads `driver` only from a
  Host that announced the feature, validates it, forgets it when the connection is gone, not merely
  unresponsive, and tells `ipc.ts` on each change, which pushes `host:driver` and answers `host.driver`
  (preload and `CoreApi`/`CoreEvents` extended). The renderer's `jobsStall({ hostStatus, driver })`
  (`src/core/orchestration/jobsView.ts`, beside the pure `jobsViewScreen`) answers
  `{ kind: 'unresponsive' }` when the Host does not answer, which wins over a stale parked report, but
  only for a Host the app hands Jobs to, meaning one that announces `dispatch` (final review M1): a Host
  with no spawner, or an older Host, leaves the app driving by itself, so Jobs keep moving and saying they
  do not would be false. `{ kind: 'parked', gate }` when parked with a read gate, and `null` while parked
  with no gate yet, with no host, with no app, or with an older Host that sent no report. `App.tsx` reads
  `host.driver` once and listens on `host:driver`, and passes the result to `JobsView`, which draws one
  warning line (`.jobs-stall`) at the top of both the empty and the list screens. New i18n keys, ko and en:
  `jobs.stall.parked`, `jobs.stall.gate.unreadable`, `jobs.stall.gate.notMigrated`,
  `jobs.stall.unresponsive`; `catalog.test` does not force ja or es, so a partial catalog falls back to ko
  and those were left. Pinned by `jobsView.test.ts` (`jobsStall`'s cases: parked gives a reason,
  unresponsive gives a notice, unresponsive beats parked, an app driving by itself draws nothing even from
  an unresponsive Host with no `dispatch` in its features (final review M1), host or app missing gives
  none, parked with no gate and no report gives none), `driving.test.ts`, `driving.integration.test.ts`
  (the composition broadcasts to dispatch-yielding apps only, `appGreeted` sends the current one, repair
  reports the host once), `features.test.ts`, `hostDriver.test.ts` (the feature gate, dedupe, malformed
  drops, forget on disconnect but keep on unresponsive, never throws) and `rolling.integration.test.ts`
  (its `onAppGreeted` source check loosened to the new block form).
- **A109. L4: merge records are kept per project, within the shared total (task-3-report.md).**
  `HOST_MERGES_KEPT` moves from 200, the whole total, to 1000, and a new
  `HOST_MERGES_KEPT_PER_PROJECT = 100` caps each project's own share, so one busy project's merges no
  longer push another project's out of `src/host/mergeRecords.ts`. A record only has to survive until the
  app's next look at that folder after the merge (`sinceMs`), so 100 covers a long unattended run; 1000 in
  all lets 10 such projects keep their own 100, at about 250 KB per rewrite. The new exported
  `keptHostMerges(records, { total, perProject })` walks newest to oldest, keeps the newest `perProject`
  records of each `comparablePath(projectPath)`, the same key the reader's `isSamePath` uses, stops at
  `total`, and returns them in file order; readers are unchanged. `createMergeRecorder` takes an optional
  `kept`, used only by tests. The flaky 203 cycle test, "keeps the newest HOST_MERGES_KEPT records in
  all", is rewritten to seed `merges.json` once and run one begin and end cycle, asserting the exact kept
  ids and order; it runs in 55 ms in place of its old 30 second override, and still passes on the pre-fix
  code, as a rewrite should. Pinned by that rewritten test and three new ones: a busy project does not
  push out another's records, a project keeps only its newest `HOST_MERGES_KEPT_PER_PROJECT`, and the rule
  holds over seven real begin and end cycles with small caps.
- **A110. L5: the codex rollout search reads more than just today and yesterday's date folders, the
  newest ones it is allowed (task-3-report.md; final review I1).** `findRollout`
  (`src/core/rolling/codexLocate.ts`) no longer reads only today's and yesterday's date folders. The new
  `scanDays(since, now, bornBefore)` walks calendar days, DST-safe, over the window from `since` minus a
  day to `end`, `min(now, bornBefore + 1 day)`, capped at `ROLLOUT_SCAN_DAYS_MAX = 14` folders. A first
  version counted the cap forward from `since`, so a caller whose window ran longer than 14 days, an old
  `since` with no `bornBefore`, stopped short of `end` and never reached today's folder; the final review
  (I1) caught this, since that caller is exactly a `/new` opened weeks into a rolled codex tab, and such a
  tab needs its search to still reach today's folder.
  The cap now counts backward from `end` instead, keeping the newest folders: among the files born after
  `since`, the newest one wins anyway, so the folders nearest today are the ones worth reading. A live
  locate, `since` near `now`, still reads 2 folders, as before; a restore with
  `bornBefore = locateSince + 60 seconds` reads 3 folders however many days later the takeover happens,
  since `end` sits close to `since` either way and the cap never bites. If `since` is ahead of the clock,
  so the window is empty, the old today and yesterday folders are read instead. The `since` and
  `bornBefore` filters themselves are unchanged, so an older rollout is still not claimed. The rollout
  watcher's own rescan (`src/core/sessions/codexRolloutWatcher.ts`) bounds the `since` it passes to at most
  a day before now (`Math.max(entry.mappedAt, now - DAY_MS)`, `DAY_MS` now exported from `codexLocate.ts`
  for this), so a tab mapped long ago rescans only today's and yesterday's folders on every pass rather
  than walking up to 14 of them every few seconds. A caller whose `since` sits further back than the cap
  and passes no `bornBefore`, such as a limit probe of a long-started worker, no longer reaches the day its
  own rollout was born in (see "Known limits after the limits pass"). Pinned by the `locateSince 로부터 며칠
  뒤의 인계 (L5)` block in `codexLocate.test.ts`: a takeover 5 days later finds the rollout; an old `since`
  with no `bornBefore`, further back than the cap, now finds a rollout born today instead of reading
  forward from its own folder, and such a `since` no longer reads the date folder that far back;
  born-before-`locateSince` and born-after-`bornBefore` stay unclaimed, regression guards the old code
  also happened to pass, since it found nothing at all. And by `codexRolloutWatcher.test.ts`: a tab mapped
  more than two weeks ago still moves to the rollout `/new` opens today, and a rescan of a tab mapped days
  ago reads only the recent folders (at most 3 `readdir` calls, not the cap).

## Amendments (left-over limits pass, 2026-09-26)

The plan `.superpowers/sdd/2026-09-26-leftovers/plan.md` (Tasks 1 to 5, in that plan's own numbering)
closed limits from a fresh triage of 76 open entries: fixed what was feasible, guarded against old apps
where it was cheap, and reaped the node-pty conhost leak this document already named. Its execution
ledger is `progress.md` in the same folder, and its five tasks' reports are `task-1-report.md` through
`task-5-report.md`. Landed on `develop` from `0b85d7dc` through `1c8e0ba0`. This list is the record, in
A1's form; the limits it closes point back here.

- **A111. Task 1: an app's pid rides its `hello`, and a registry write during a Host replacement waits
  and retries once (task-1-report.md).** `hello.pid` is additive (`HOST_PROTOCOL` stays 3);
  `src/main/host/client.ts` sends `process.pid`, and `src/host/server.ts` keeps it as `lastAppPid()` from
  any `role: 'app'` hello with a positive integer pid, past that socket's close. The new
  `liveAppPid(profileDir, fallbackPid?)` (`src/core/host/pidFile.ts`) reads the pid file and, when it is
  missing, junk or names a dead pid, falls back to the given pid, both probed with a guarded
  `process.kill(pid, 0)` (EPERM counts as alive); `driving.ts`, `rollingWiring.ts`'s app-gone watch and
  `worktrees.ts`'s detached-app refusal all pass the server's `lastAppPid` as that fallback. One app-left
  rule now backs both watchers: `createAppLeftGrace` in the new `src/host/appGone.ts`, run by `driving.ts`
  with `attachCancels: false` and by `createAppGoneWatch` with `attachCancels: true` (A69's own difference
  kept as a parameter); `APP_LEFT_GRACE_MS` moved there, and `driving.ts` re-exports it. Separately,
  `src/main/host/worktreeRoute.ts`: a write whose call rejects with `NO_HOST_CONNECTION` (it never left
  the app, so a retry cannot apply twice) now waits for the next switch to host mode, up to
  `REPLACE_WAIT_MS = RETIRE_SETTLE_MS + 5 s`, and retries once, with no local write; any other failure is
  not retried, as before. Pinned by `pidFile.test`, `server.test`, `client.test`, `driving.test`,
  `worktrees.test`, `appGone.test` (one table of 9 scenarios through both watchers) and
  `worktreeRoute.test`. This closes "An app whose `app.pid` is missing or unreadable... cannot be told
  from a new instance" below, "A missing `app.pid` makes a live app look gone" under "Known limits after
  S6", and "A registry write during a Host replacement window fails rather than falling back to local"
  under "Known limits after S3". An Astera from before S3, which writes no `app.pid` and sends no `pid`
  in its `hello` either, is unchanged and stays a separate, open limit. After the final review, the Host
  forgets the pid from the app's last hello once a probe finds it dead, and the driving tick probes it
  while no app is attached, so a pid Windows reuses after a quit cannot keep a gone app alive. A socket
  close alone forgets nothing, so an app that closed its socket but never wrote `app.pid` stays alive.
- **A112. Task 2, S45-11: a Job `cwd` that is the filesystem root or the home folder opens nothing
  (task-2-report.md).** `hostPathGuard` (`src/core/run/hostPathGuard.ts`, not the brief's
  `src/host/hostPathGuard.ts`, which does not exist) adds `tooBroadJobCwd`, with `home` injectable and
  defaulting to `os.homedir()`; only the Job list is judged, so a Run's own `cwd` and the registered
  worktrees are unchanged. `checks.ts` keeps the default home. Pinned by `hostPathGuard.test.ts` (root,
  home, home with a trailing separator, a folder below home still allowed, the default home). Closes "A
  broad Job `cwd` allows its whole subtree to the path guard" under "Known limits after S4+S5".
- **A113. Task 2, LP-1/2: a coordinator stop retried at the ten minute cap gives up after six tries
  (task-2-report.md).** `dispatchLoop.ts` adds `COORDINATOR_STOP_RETRY_CAP_TRIES = 6`; once a slot has
  been stopped six times at the cap it logs one `gave up stopping its coordinator ...` line and is not
  asked again, in memory only, so a restart or a new driver asks again from the start. `sessionGone`'s
  release still runs before the backoff check, so a slot given up on is released the moment the session
  is confirmed gone by whichever process can see that (the Host from its own registry, the app from its
  own session list with a real exit code). Pinned by `dispatchLoop.test.ts` (gives up once past the cap;
  a given-up slot is still released once `sessionGone` answers true). Narrows both "A stop the live
  session always refuses is retried every 10 minutes, forever" and "A slot this process never held can be
  retried even once the session is actually gone, because liveness cannot be told" under "Known limits
  after the limits pass": the endless part is gone, and what is left is that giving up itself does not
  survive a restart (see "Known limits after the left-over pass").
- **A114. Task 2, S6-11: the Jobs sidebar says the Host is still reading its settings
  (task-2-report.md).** `jobsStall` takes optional `parkedSinceMs`/`nowMs` and answers
  `{ kind: 'reading' }` for `parked` with `gate: null` once `JOBS_STALL_READING_MS = 10_000` has passed;
  `jobsStallRecheckInMs` tells the caller when to ask again. `App.tsx` times the parked-unread report and
  arms a one-shot timer 50 ms past the threshold; `JobsView` draws the new `jobs.stall.reading` line (en,
  ko; es and ja have no `jobs.stall` keys yet and fall back as before). Pinned by `jobsView.test.ts` (the
  reading threshold and its precedence, and the recheck delay). Narrows "The Jobs sidebar stays silent
  while the Host's first settings read hangs" under "Known limits after the limits pass" to just the
  moment before that first read has even started.
- **A115. Task 2, LP-3: a rollout search whose window is longer than 14 days also reads the folders
  around `since` (task-2-report.md).** `codexLocate.scanDays`: with no `bornBefore` and a window past
  `ROLLOUT_SCAN_DAYS_MAX`, the three folders anchored at `since` (the day before, its day and the day
  after) replace the oldest three of the newest folders the cap otherwise keeps; the cap still reads 14
  folders in all, and the folders between the two ends are not read. `limitProbe.ts` needed no change,
  since it benefits through `findRollout`. Pinned by the rewritten `codexLocate.test.ts` case (a `since`
  20 days back now finds its rollout; 14 folders read, `since`'s own folder and today's both among them).
  Narrows "The codex rollout search no longer reaches a worker's own birth folder..." under "Known limits
  after the limits pass": a limit probe of a worker over 14 days old now reads that worker's own birth
  folder again, but a window wider than 14 days still skips whatever sits between the two anchors (see
  "Known limits after the left-over pass").
- **A116. Task 2, LP-4: `locateSince` is written at every codex locate, not only a blank-slate roll
  (task-2-report.md).** `codexCoordinator.startLocate` now writes `chain.locateSince` for a fresh spawn
  (via register), a blank-slate roll and a restore alike, so a fresh codex session that dies before its
  rollout is found is restored mapped instead of stuck. The snapshot still carries the field only while
  `rolloutPath` is null, and a hit clears it, as before. Pinned by two new `codexCoordinator.test.ts`
  cases (a fresh spawn's snapshot carries `locateSince` and restores mapped; a found rollout still drops
  it). Closes "A codex chain snapshotted before its rollout was found, with no `locateSince`, is restored
  unmapped and cannot roll" and "Only a blank-slate respawn records `locateSince`" under "The snapshot and
  the takeover".
- **A117. Task 3, CT-8: the codex adapter writes `answered` ids too (task-3-report.md).**
  `src/core/chat/codexAdapter.ts`'s `doAnswer` adds the request id to an `answered` list, the same 32-id
  bound claude's adapter keeps, and calls `proc.remember({ answered })` only after `takeRequest` wrote the
  answer; a write that throws notes nothing. On adopt it starts from `mode.answered` and rewrites the
  whole list each time. codex's replay already carries `serverRequest/resolved`, so the adapter does not
  itself skip a replayed id; only the Host reader's own views (`openOf`, `prompts`, the deny policy) need
  the list. A roll's new proc gets a fresh note, so an id cannot leak from an old proc into a new one.
  Pinned by `codexAdapter.test.ts` and the wider `src/core/chat` suite (234 tests). Closes "A codex answer
  writes no `answered` id, so for codex the echo is the only thing that clears it" under "Known limits
  after the chat takeover".
- **A118. Task 3, CT-9: a failed auto-deny retries itself at 5, 15 and 60 seconds
  (task-3-report.md).** `src/host/chatPolicy.ts` adds `DENY_RETRY_MS = [5_000, 15_000, 60_000]`; a deny
  that rejects arms its next retry in the same `armed` map, so review, forget and dispose cancel it like
  any other timer, and `fire` asks every condition again on each try (writer, policy, open, answered).
  Once the retries run out the log says so, and the next review trigger arms a fresh 60 s timer with a
  full set of retries again; a success, a drop, or a request no longer covered resets the count. Pinned by
  `chatPolicy.test.ts` (13 tests, fake timers). Closes "A failed auto-deny is retried only on the next
  review trigger, not on a timer of its own" under "Known limits after the chat takeover".
- **A119. Task 3, CT-16: a re-pointed tab keeps the codex `dest` (task-3-report.md).** The Host
  (`src/host/rolling.ts`'s `send`) writes `{ rollDest: dest }` into the new proc's note through the new
  `HostChats.note(sessionId, patch)`, before the push, whenever the roll carries a `dest`; `note` is
  optional on `HostChatsForRolling`, so existing fakes still fit. A separate key from `rolloutPath` was
  chosen on purpose, since a blank-slate roll's own `ready` writes that one too. The app's `chatAdoptPlan`
  returns the note's `rollDest` alongside a re-point, and `hostRollView.repointed(oldId, info, dest)`
  forwards it the same way a push forwards its own `dest`; in `ipc.ts` only the adopter line changed.
  Pinned by the updated `chatAdopt.test.ts` guard and `rolling`/`hostChats`/`hostRollView` tests (105).
  Closes "A re-pointed tab after a reconnect carries no codex `dest`" under "Known limits after the chat
  takeover".
- **A120. Task 3, CT-11: the history guard refuses a Host chat the app has not adopted
  (task-3-report.md).** `src/main/host/hostNativeGuard.ts` adds `findHostHeld`, returning
  `{ id, kind: 'session' | 'chat' }` (`findHostHeldNative` stays a wrapper around it), and
  `hostHeldLive(found, liveOf, refusal)`; for a Host chat proc with no live session held here it throws
  the new i18n key `session.resume.hostChatNotAdopted` (en, ko, ja, es), which the renderer's spawn catch
  shows through `worktree.error.raw`. Only `liveByHostNative` and its import changed in `ipc.ts`; the Host
  proc list was already being asked, the gap was only that nothing was handed back. Pinned by
  `hostNativeGuard.test.ts` and the i18n suite (50). Closes the chat half of "The history guard only
  returns a chat the app holds" under "Known limits after the chat takeover". The pty guard's own version
  of the same limit is untouched on purpose, out of this task's scope.
- **A121. Task 4, S6-17 and S6-20: a rekey reaches the renderer only once the adopt succeeded, and the
  exit composition is a tested function (task-4-report.md).** `src/main/host/hostRollView.ts`: after
  `adopt`, the view decides whether the app now holds the new session, from `isAdopted` when the caller
  gives one, otherwise from whether `adopt` itself failed; `ipc.ts` always passes `isAdopted`. When it
  does not hold the session, the rekey is still forwarded, with
  `{ orchestration: false, renderer: false }`, so the app's own taps (the Work Unit fork, the schedule
  rekey, the codex watcher, Slack) still run, but `fanOutRollEvent` (`src/main/index.ts`) skips only the
  `win.webContents.send`, so the renderer does not re-point the old tab at a session with nothing behind
  it; the held exit still releases, the old tab closes, and the next sweep's adopter announces the new
  session. `pendingFork` now follows the same verdict. Separately, the new
  `installHostRollExit(view, managers, handler)` wraps the handler once with `withHostRollHold`, sets it
  as `onExit` on every manager given, and returns it; `ipc.ts` calls it with `[core.sessions, core.chat]`
  in place of its own two assignment lines. Pinned by `hostRollView.test.ts` (24, including one function
  set on both managers and each roll kind's own exit waiting for its own adoption). Closes "A rekey is
  forwarded to the renderer even when adopting the new pty failed" and "The ordering hold's wiring in
  `ipc.ts` is not pinned by a test" under "The app beside a Host that rolls".
- **A122. Task 4, S6-22 (the CA half): the Host adds the OS certificate store to its default CAs
  (task-4-report.md).** New `src/host/systemCa.ts` `trustSystemCa(tls, log)`, with an injectable
  `TlsCaSeam`, reads Node 24's `'default'` and `'system'` certificate stores, appends whatever the system
  store has that the default does not, and calls `setDefaultCACertificates` only when something is new;
  it returns `added`, `nothing-new`, `unsupported` or `failed` and never throws, logging on any error and
  leaving the defaults in place. `src/host/index.ts` calls it right after `logUnhandledRejections`, before
  any HTTPS. On the built Windows binary the OS store added 99 roots to the default 145, and a real
  usage-endpoint `fetch` still completed after the swap. Pinned by `systemCa.test.ts` (6). Narrows "The
  Host's usage lookup goes without the system proxy and the OS certificate store" under "`runs wait` and
  the usage lookup": the OS store is now trusted at start; the system proxy itself is unchanged and stays
  open (see "Known limits after the left-over pass"). System certificates are checked one by one, and a
  malformed one is skipped rather than blocking the rest. The APIs need Node 22.19 or 24.5.
- **A123. Task 5, part A: a role-less `hello` is a `legacy-app`, Astera 1.3.25 or older
  (task-5-report.md).** Checked first: `git show v1.3.25:src/main/host/client.ts` sends
  `{ t: 'hello', protocol, app }` with no role and no `yields`; role arrived in `c8e86a00`, after v1.3.25,
  and the only CLI hello (`core/host/connect.ts`) always sends `role: 'cli'`. In `src/host/server.ts`,
  `roles` gains `'legacy-app'`: a missing `role` means one, any other value that is not `'app'` means
  `'cli'`. `hasApp()` counts both kinds of app; the new `hasCurrentApp()` counts only `role: 'app'`.
  `appsKeep(duty)` and `appKeeps(duty)` both count a legacy app, which yields nothing, so it keeps every
  duty, closing S6-6 (the Host no longer drives beside it) and SL-11 (the Host no longer opens its own
  Slack socket beside it: `slackWiring.ts`'s `want()` reads `!appsKeep(slack)`). `act()` still goes only
  to a `role: 'app'` socket, so with only a legacy app attached it rejects at once with
  `AppUnreachable("APP_REQUIRED: <name> needs a newer Astera app: Astera 1.3.25 or older is attached;
  update it")`; `onAppGreeted` does not fire for it, and it never records `lastAppPid`. The Host logs
  `LEGACY_APP_NOTICE` once per attach, and the hello reply carries `legacyApp: true` while one is
  attached, additive in `protocol.ts`; `connectHost` passes it through, and `hostStatus` adds
  `legacyApp: true, warning: LEGACY_APP_NOTICE`, which `--human` prints (`astera host status`, and
  `docs/cli.md`). Toward the command layer and the hooks a legacy app is still `'cli'`, so the doors only
  an app may use stay closed to it; no `protocol-mismatch` path was touched, and `HOST_PROTOCOL` stays 3.
  Every `roles`, `hasApp`, `appsKeep` and `appKeeps` consumer was audited (server.ts, index.ts, orch.ts,
  driving.ts, drivingWiring.ts, appGone.ts, takeover.ts, rollingWiring.ts's journal, rollOwner,
  slackWiring.ts, slackRoutes.ts, orchDeps.ts, worktrees.ts's `askApp`, spawner.ts's `appKeepsWorktrees`);
  `rollingWiring.ts`'s journal now reads `hasCurrentApp?.() ?? hasApp()`, since a legacy app cannot read
  `session-rolled`. Pinned by a rewritten `server.test.ts` and two new tests, `connect.test.ts`,
  `cli/host.test.ts` and a new `rolling.integration.test.ts` case. Closes "A role-less older app (v1.3.17
  to v1.3.25) counts as `cli`, so `hasApp()` is false while it is attached and a takeover can run beside
  it" under "Known limits after S6" (applies only to Astera 1.3.25 and older; the pty-list race in the
  same bullet's last sentence is untouched) and "A role-less app from before this feature (v1.3.17 to
  v1.3.25) is not seen by `appsKeep`, and counts as a CLI" under "Known limits after Slack in the Host"
  (applies only to Astera 1.3.25 and older).
- **A124. Task 5, part B: the Host reaps the conhost it leaks, on Windows (task-5-report.md).** Measured
  first on a Windows 11 machine: after `cmd /c exit 0` in a pty, a `conhost.exe` stays a child of the
  spawning node process even though the parent and a later pty both keep working;
  `powershell.exe Get-CimInstance Win32_Process -Filter "ParentProcessId=<pid>"` (about 0.6 s) replaces
  the deprecated `wmic`. New `src/host/conhostReaper.ts`:
  `createConhostReaper({ platform, hostPid, livePtys, listChildren, kill, log, now?, after?, debounceMs?
  })` is fully injectable. `spawned()` records the last spawn's return time and cancels an armed reap.
  `exited()`, on win32 only, once at least one spawn has happened and live ptys are at zero, arms one
  debounced reap (`CONHOST_REAP_DEBOUNCE_MS = 10 s`); the reap re-lists the Host's children, checks the
  live count again and aborts if it is no longer zero, then kills only rows whose `parentPid` is the
  Host's own, whose name is `conhost.exe` or `OpenConsole.exe` (case-insensitive), and whose creation time
  falls between the reaper's own creation and the last spawn, which protects the Host's own console host
  when it runs as a console program; listing and kill failures are logged, the reap never rejects, and
  `dispose()` stops it. `listWindowsChildren(pid, exec?)` runs the query and refuses a pid that is not a
  positive integer. `index.ts` wires `registry` to call `spawned()` after `pty.spawn` returns, `exited()`
  from `registry.onExit`, and `dispose()` from `leave()`. On other platforms this does nothing. Pinned by
  `conhostReaper.test.ts` (9, the module did not exist before) plus new cases in `server.test.ts`,
  `connect.test.ts`, `cli/host.test.ts` and `rolling.integration.test.ts` from part A. Closes "One
  `conhost.exe` leaks per pty that exits on its own" under "Known limits after S3", and the matching
  clause of A63's own carry list. What is left: a `conhost.exe` that exits between the listing and the
  kill could, in theory, have its pid reused within that sub-second window before the kill checks it
  again, and a Host that always holds at least one live pty keeps its leaks until every such tab closes
  (see "Known limits after the left-over pass"). After the final review the listing and the kill run in
  one PowerShell pipeline that filters by parent, name and creation window, which closes most of that
  window. Ending a leaked console host also ends any process a worker left attached to it, as
  `ClosePseudoConsole` would.

## Amendments (Host journal, 2026-09-26)

The plan `docs/superpowers/plans/2026-09-26-host-journal.md` (Tasks 1 to 8) carried out the spec
`docs/superpowers/specs/2026-09-26-host-journal-design.md` (decisions J1 to J7): the long-lived Host now
writes the Job Journal, and the app only reads it. Its rulings are P1 to P15 in the plan, its execution
ledger is `.superpowers/sdd/2026-09-26-host-journal/progress.md`, and each task's report is
`task-N-report.md` in the same folder. Landed on `develop` from `c55dcf05` through `17ab4c08` and the
commit of these docs. This list is the record, in A1's form; the limits it leaves are under "Known
limits after the Host journal".

- **A125. D8 reversed: the Host writes the journal, the reconciler stays in the app (J1, J3).** The
  journal and its recorder moved unchanged to `src/core/continuity/` (Task 1), so the Host builds the
  same recorder over the same file, `<profile>/orch/continuity.sqlite`. `src/host/hostJournal.ts` (Task 4)
  records at the Host's three commit points (`depsFor().setState`, `statePut`, the load's restart
  cleanup) and at the prompt writes of the workers it starts (Task 5). The reconciler still runs in the
  app, which reads the file through a read-only `JournalReader` and sends its own rows to the Host
  (Task 7, A132). What shipped: Task 4 (`hostJournal.test.ts`, "records a commit with its actor and its
  Host-life stamp"), Task 5 (`orch.test.ts`, "hands the load's restart cleanup to the journal once"),
  Task 7 (`appJournal.test.ts`, "reads the rows the Host wrote, through a read-only connection"), and the
  end to end tests in `src/cli/cliHost.integration.test.ts`, "the Job Journal with Astera closed (Host
  journal)".
- **A126. One writer, and the `journal` feature and yield (J2, P6, P9).** At most one process appends to
  the file. The Host writes while it announces `journal`, Job Continuity is on in `app-settings.json`,
  and every attached app yields `journal` (or none is attached): `writer: () =>
  !server.appsKeep(HOST_YIELD_JOURNAL)` in `index.ts`. An app writes only when the Host it last greeted
  does not announce `journal`, and that answer is sticky per greeting (P8), so a dropped socket never
  makes it a second writer. Every Host announces the feature, spawner or not (P6), since every Host
  commits. An older app that yields nothing holds the Host off, legacy role-less apps included (P9).
  What shipped: Task 4 (`features.test.ts`; Review Focus 1, `hostJournal.test.ts`, "writes nothing while
  an attached app keeps the journal, and writes again once it leaves", plus the same rule through a real
  server and real sockets), Task 7 (Review Focus 2, `appJournal.test.ts`, "after the socket drops in
  front of a journal Host, the app still writes nothing locally"), and Task 8 ("an older app attached
  holds the Host off; once it leaves the Host journals again (J2, P9)").
- **A127. Schema v3: who acted, and a read-only reader (J4, P4, P13).** `SCHEMA_VERSION` is 3 and
  `journal_events` gains `actor_json`. A v2 file is migrated in place in one transaction, and its rows
  read as actor null; nothing is inferred (P4). Checkpoints and recovery actions are not reshaped: each
  has an event twin that carries the actor. A v3 step that fails leaves the file where it was, readable,
  with journaling off for that profile (Task 3's carry). `JournalReader` opens the file read-only, never
  creates it, never runs the schema step, reads a v2 file as it is, and answers a missing file with no
  rows (P13). What shipped: Task 2 (`journal.test.ts`, "migrates a v2 file in place: its rows stay, read
  as actor null, and new rows carry one"; `journalReader.test.ts`, "reads a v2 file without migrating
  it: actor null, and the file stays at version 2" and "refuses to write: the connection is read-only";
  `actor.test.ts`).
- **A128. The actor rule (P5).** `actorOf({ sessionId, role, state })` judges each call on the state it
  found, after `ready()` and before `handleCommand`. The Host's own caller is `host`; the app (its caller
  id, or a hello with `role: 'app'`) is `desktop`; a session naming an open Dispatch or a Run's
  coordinator is `agent` with that session; anything else is `cli`. Fixed actors: `state-put` and every
  `journal-append` row are `desktop`; the load cleanup, the exits, the driving, the checks and the Host's
  prompt writes are `host`; a report the load drains is `agent` with the report's session. What shipped:
  Task 3 (`actor.test.ts`), Task 5 (Review Focus 3, `orch.test.ts`, "a worker_done that closes its own
  Dispatch is recorded as agent"; "a shell is cli, the Host's own command is host, the app's state-put is
  desktop, each under a new version"; "a queued report the load drains is recorded as the agent that
  wrote it"), and Task 8 (the question test below checks `cli` and `host` on real rows).
- **A129. `GATE_RESOLVED` (J5, P3).** An answered question is its own row, derived for every Gate that is
  resolved in the next state and was not in the previous one (a Gate made and answered in one write
  counts). Its key is `GATE_RESOLVED:<gateId>`, its `at` the Gate's `resolvedAt`, its payload `{ gateId,
  kind, question, resolution }`, and it comes after the Task rows of the same write. What shipped: Task 3
  (`events.test.ts`, "an answer is its own row" and its two neighbours) and Task 8 ("a question answered
  from the CLI lands one GATE_RESOLVED row, and says the CLI did it", which also checks that a second
  answer adds none).
- **A130. Keys name the Host life and the version (J6, P1, P2).** The rows derived from a commit are
  keyed on `commitStamp(hostStartedAt, version)`, that is `<hostStartedAt>#<version>`, and the load's
  cleanup on `<hostStartedAt>#load`. The version alone restarts at 0 with every Host, so it would drop a
  real transition after a restart. Rows that are not a commit keep their keys (P2): `CONTINUITY_ENABLED`,
  the reconciler's `RECOVERY_*`, prompt writes and checkpoints. What shipped: Task 3 (Review Focus 4,
  `recorder.test.ts`, "the same version in two Host lives lands twice, the same commit recorded twice
  lands once").
- **A131. A19 lifted: the Host's workers' prompt writes are journaled.** `HostSpawnerDeps.onPromptWrite`
  reaches the Host's coordinator, and `index.ts` wires it to `hostJournal.promptWrite` (actor `host`). A
  listener that throws costs the row, never the start. Recovery of a Host-started worker now finds the
  prompt rows it reads instead of reporting `promptNeverLeft`. What shipped: Task 5 (`spawner.test.ts`,
  "reports each prompt write of a worker it starts" and "a prompt-write listener that throws costs the
  row, never the start"; the `index.ts` guard in `driving.integration.test.ts`).
- **A132. `journal-append` and `journal-reload`, and the toggle read from `app-settings.json` (J3, P7,
  P14).** Both are app-only orch-calls: 403 to any other caller, 501 on a Host with no journal, and both
  refuse a request id. `journal-append` takes `{ ops }` (1 to 64) and answers 200 `{ applied, failed }`,
  all in one transaction, where one failing op costs only itself; the Host stamps every row `desktop` and
  keys it under `app:`. It answers 409 `{ error, enabled, writer }` when Job Continuity is off there or
  the Host is not the writer, and the app logs and drops the rows (P14). The app mints the recovery
  action id, so the later finish names the same one. The Host reads `jobContinuityEnabled` and
  `resumeStrategy` from `app-settings.json` at start (missing or damaged reads as off) and again on
  `journal-reload`, which the app sends after its continuity toggle and its resume strategy change. A
  reload that turns journaling on writes the baseline as `desktop`; one that turns it off closes the
  handle and keeps the file (P7). A baseline owed while an older app held the journal is paid at the
  Host's first write as the writer. What shipped: Task 5 (`orch.test.ts`, "journal-append and
  journal-reload are the app's alone, need a journal, and take no request id"; `hostJournal.test.ts`, the
  append and reload tests and the owed baseline tests), Task 7 (`appJournal.test.ts`, "sends the
  reconciler's rows in order, the finish under the id the app minted (J3, P14)" and "writes each
  reconciler row exactly one way: locally in front of an older Host, through the Host otherwise").
- **A133. `runs follow` shows the journal's rows (J7, P10).** The Host read call is the existing
  `runs-follow`: its answer merges the Host journal's timeline rows (a worker lost, a recovery decision)
  through the optional `OrchServerDeps.journalTimeline`, in the timeline's own order, and `count`
  includes them so a row landing mid-window wakes the poll. A read that throws costs its rows, never the
  follow. The Host reads its rows in English, and the recovery row's localized body is hidden by the
  public field filter. What shipped: Task 6 (`commandRunsFollow.test.ts`, "merges the journal rows into
  the timeline and counts them" and "a journal read that throws costs its rows, never the follow";
  `follow.test.ts`), Task 8 ("a worker the restart lost is a journal row written by the Host, and runs
  follow prints it").
- **A134. §7.2's additions.** The feature `journal` (Host hello), the `hello.yields` value `journal` (app
  to Host, sent by the app from Task 7 on and not before), the internal orch-calls `journal-append` and
  `journal-reload` (app to Host, role app only), and the optional `OrchServerDeps.journalTimeline`, which
  puts `JobEvent`s of the existing kinds `runtime-lost` and `recovery` in a `runs-follow` answer. None is
  a protocol change: `HOST_PROTOCOL` stays 3, and nothing in `src/core/host/protocol.ts` was renamed or
  removed.

## Known limits after S3

- **`refresh()` does not retry a Windows rename-busy read.** (resolved in S4+S5, see Amendments A60)
  `WorktreeRegistry.refresh()` reads through
  `readForWrite()`, a plain `fs.readFile`; the rename-busy retry only guards `save()`'s write path. A
  read racing a rename can hit a transient sharing violation, which `refresh()` surfaces as a rejection
  rather than riding out. Safe, because nothing is wiped, but the app's mirror stays stale until the
  next local write or refill (task-9-report.md).
- **A registry write during a Host replacement window fails rather than falling back to local.**
  (resolved in the left-over limits pass, see Amendments A111: the write waits for the new Host's hello
  and retries once, with no local write) For about `RETIRE_SETTLE_MS` (2s) around a Host's
  `retire({announce:true})` → `stop()` → `restart()`, the app's write-through route still reads
  `mode: 'host'`, so a write in that window answers "there is no connection to the Host" instead of
  writing the file itself. Nothing is lost silently; the caller sees the error (task-9-report.md, M1).
- **One `conhost.exe` leaks per pty that exits on its own.** (resolved in the left-over limits pass, see
  Amendments A124: the Host reaps `conhost.exe`/`OpenConsole.exe` children of its own process once no
  pty is live) node-pty 1.1.0 closes the pseudo console only when a live pty is killed (A17). S3 makes
  Hosts that live long with the app closed more common, and so this leak more common with them, but does
  not change the underlying behaviour.
- **A later `jobs run` of a coordinator Job starts a run that nothing drives.** (resolved in S4+S5, see
  Amendments A57: a later run starts its coordinator; the loop was never the fix) Only the first run of a
  coordinator Job works headless in S3 (its coordinator starts, and the Host makes its worktree). A Job
  that runs again has no scheduler in the Host to place its workers, until S4 moves the dispatch loop.
- **A Host merge made while the app was closed may read as an outside change on the Work Unit screen.**
  (resolved in S4+S5, see Amendments A61; one residue is under "Known limits after S4+S5")
  A28's answer for this slice: there is no persisted Host git-op journal, so the app's next open
  compares its stored snapshot to HEAD and records the move as external if that project had one. S4's
  per-merge record is the fix.
- **An Astera from before S3 does not write `app.pid`.** The detached-app guard (A31) only sees an app
  that writes the file, so a removal is not refused while a pre-S3 Astera runs unattached, the mixed
  version case in final review m1. Rare: it needs a downgrade, or a newer CLI's `host start`, while the
  older app stays open.

## Known limits after S4+S5

Each was found while building or reviewing S4+S5 and left as it is, with its reason. Checked at
`d80492c`.

- **A review whose verdict file is missing counts as no issues** (§8.2, kept by ruling). The final
  review's C1 removed the cause it found (the spec sweep deleted an open review's `<spec>.review.json`);
  any other loss of that file would still read a blocking finding as passed.
- **A Task nobody checks stays `validating` or `reviewing` while any app is attached.** The Host opens
  its restart Gate for it only once the last app has left (final review I1), and the app does not
  recover it either: in front of a Host that drives, its resume sweep is off and it gates only at a
  Host load it caused. The Gate comes within about 5 to 20 s of the last app closing.
- **A parked Host is silent in the app.** (resolved in the limits pass, see Amendments A108: the Host
  reports its driver and gate, and the Jobs sidebar draws one line naming why nothing moves) The app
  yields to any Host that announces `dispatch`, parked or not, so while the Host is parked nothing
  dispatches, and nothing in the app says why (A38). A settings file damaged while the app runs parks
  the Host until Astera restarts and repairs it.
- **A hung Host that keeps its pipe open stops every Job.** (resolved in the limits pass, see Amendments
  A108: the Jobs sidebar now says so too, in the same line the status bar uses) The app keeps yielding
  to it (A52). Jobs do not move until it answers, dies, or is restarted from Settings, Info. The status
  bar shows that the Host is not answering; the Jobs sidebar does not say why nothing moves.
- **A Task a closed app left mid-check, outside a convergence Job, is gated, not restarted.** The resume
  sweep restarts only a convergence Run's `validating` and `reviewing` Tasks (A54). Any other Task left
  so with nothing checking it is armed at the handover, when the last app leaves, and again on every
  tick that drives with no app attached. It gets the restart Gate on a later tick at least 5 s after
  it was armed, still unchanged, and a person decides. A tick that briefly does not drive drops the
  arming, and the next tick that drives arms it again. The same holds for an S5 start a yielding app refused (A53).
  A Task a leaving Host left (A50) is gated by its successor's load. While any app is attached nothing
  is gated: that app may be checking the Task itself. If the Host's own store write between a
  `worker_done` commit and its check's start took longer than 5 s, such a Task could be gated beside
  its starting check; the check then finds it no longer `validating` and skips.
- **The app-left grace covers only the app-left steps.** An app whose socket drops is told from a new
  instance by `app.pid` (A54), so a live app that reconnects keeps what it left, however long it takes.
  If that app quits without reconnecting, the first tick with no app attached after `app.pid` stops
  naming it runs the steps it kept. Three things are outside that guard. First, an app whose
  `app.pid` is missing or unreadable (a profile it could not write) cannot be told from a new
  instance (resolved in the left-over limits pass, see Amendments A111: the Host's own record of the
  app's `hello` pid, `lastAppPid`, stands in when the file cannot be read). If it reconnects within the
  grace, the steps run at that attach, at once and beside it;
  if it stays away, they run when the grace ends. Either way, if the Host is starting a repair the
  app was starting too, two agents can land on one Dispatch. Second, the tick's own no-app
  steps do not wait for the grace: the lost-worker Gate, the spec sweep and the restart Gate's arming
  (`driving.ts:345,401,407`) run on any tick with no app attached, a dropped socket included. Third,
  at a handover, an older app that keeps dispatch and drops its socket hands the drive to the Host at
  once, with no grace. In the first and the third, the Host kills that app's leftover checks, and the
  app, once reconnected, may read the kill as a failed check.
- **An older app that attaches beside a running Host check can start a second one.** Its own "the Host
  attached" sweep (the S3 app's `ipc.ts`) restarts a convergence Run's `validating` Tasks from its
  mirror, and knows nothing of a check the Host is already running in the same folder. The Host cannot
  stop it: the old app does not ask. The second check may interfere with the first. It needs an app
  from before S4 attached to a Host that drives. The other direction, an older app leaving mid-check,
  is handled (A54).
- **R21 is false with a new and an old app both attached** (A53). The forwarded S5 starts may reach the
  new app, which refuses them. Two apps on one profile need a downgrade past the single-instance lock.
- **A lost worker is gated even when the app journalled it** (A51, N5). While the Host drives with no
  app attached, a worker lost in a Run with no coordinator gets a Gate, including one the app's
  reconciler could have resumed at its next start.
- **A worker at its usage limit with no app open stalls** (A58). (resolved in S6, see Amendments A67
  and A68: the Host rolls it, and `runs wait` ends `limited` when every worker waits for a reset) `runs wait` ends at its deadline with 7,
  and the app rolls the worker when it opens. Rolling stays in the app until S6.
- **A `--terminal` start waits up to about 30 s before its Dispatch commits.** Repair's same-session
  branch and a coordinator's `--terminal` start await `waitUntilIdle` (`DEFAULT_IDLE_WAIT_TIMEOUT_MS`,
  `src/core/orchestration/exec/coordinator.ts:124`) and the Enter delay first. A terminal that dies
  inside that wait leaves its exit matched to the older Dispatch, and the new one is committed onto a
  dead session until the next load's cleanup; the lost-worker Gate cannot see it, since the Dispatch is
  not ended. The same in the app; not new (Task 12 review m3).
- **The `pending:` session window.** A started worker's or reviewer's Dispatch holds a `pending:` id
  until the commit that records the real one, and exits are matched by session id after
  `EXIT_DEFER_MS` (3 s, `src/core/orchestration/exec/exitOwner.ts:21`). On a fresh spawn the window
  cannot exceed 3 s in the Host: `sessions.spawn` is synchronous, the steps after it are synchronous,
  and the store sets its state before its first await (Task 12 carry 3). The `--terminal` path above is
  the exception.
- **A superseded settings read during the migration marker's write can drain on the migrating change.**
  If the read that saw `not-migrated` was superseded, it never became the previous gate
  (`src/host/driving.ts:170-176`), so the applied `migrated` read compares against nothing and drains
  (A40, N4). The effect is reports applied early, not unsafe work (Task 12 re-review).
- **The 200 merge records are shared by all projects** (`HOST_MERGES_KEPT`,
  `src/host/mergeRecords.ts:64`). (resolved in the limits pass, see Amendments A109: each project now
  keeps its own newest 100, within a total of 1000) A busy project can push another's records out, and
  a HEAD move that only a dropped record explained then reads as an outside change (Task 3 review m2).
- **A broad Job `cwd` allows its whole subtree to the path guard** (A45,
  `src/core/run/hostPathGuard.ts:20-21`). (resolved in the left-over limits pass, see Amendments A112:
  `hostPathGuard` refuses a Job `cwd` that is the filesystem root or the home folder) A Job whose `cwd`
  is a drive root lets a validation or review run anywhere below it (Task 9 review m4).
- **A worktree removal already in flight when the drive moves still finishes.** The loop asks
  `mayStart` before each removal (`driving.ts:191-197`), but one already started goes on. It asks the
  attached app first, two removals of one folder make one of them fail, and a removal never throws
  (Task 12 review m2).
- **Carried from S3:** a pre-S3 app that writes no `app.pid` (A63), unchanged. The ~2 s replacement
  window for the app's worktree writes and A17's conhost per self-exiting pty are resolved in the
  left-over limits pass (see Amendments A111 and A124).

## Known limits after S6

Each was found while building or reviewing S6 and left as it is, with its reason. Checked at
`2d426dcb`. The names in parentheses are the S6 pre-flight findings and plan rulings (see the
Amendments (S6 as shipped) preamble).

**Who rolls, and who is told**

- **Block knowledge is per process** (the S6 design's §4.8). (resolved in the S6 limits follow-up, see
  Amendments A75 and A76: the two `BlockRegistry`s exchange records over the wire) The app's chains and
  the Host's did not share a `BlockRegistry`. A tab rolling off an account did not tell the Host's
  workers, so each side paid one kill and respawn per account to learn a block the other knew. It cost
  efficiency, not correctness. A takeover carries the chain's own accounts' blocks in its snapshot.
- **An older app's sessions are not taken over.** An app from before S6 writes no snapshot, so its
  sessions stall at a limit once it is gone, as before (the S6 design's §3A.2). So does a session an
  older app rolled away from a Host chain: its respawn is the app's, and nobody rolls it once that app
  leaves.
- **Chat sessions are not taken over.** (resolved by the chat takeover, see Amendments A85 to A93: the
  Host runs the same protocol adapters the app does, one writer at a time) They are line processes whose
  protocol adapter lives in the app, so with the app gone nothing can drive a turn (plan R20).
- **A Host roll is silent in Slack and in desktop notices until an app attaches.** (resolved in the S6
  limits follow-up, see Amendments A77 and A78: the Host journals a roll made with no app attached, and
  the app announces it, one Slack summary per session and one desktop notice, once it starts or
  reconnects) Both live in the app. An attached app forwards the Host's pushes to them; a roll made with
  no app attached announced nothing there, then or later.
- **A tab the Host respawns runs in D4's environment**, the Host's own minus the strip list, not the
  app's (the S6 design's §3A.6). It keeps its title, Slack choice, permission choice and rolling
  accounts. Its schedules do not fire until the app returns (D2). With Smart Resume on, the Host never
  rolls a taken-over tab blank-slate. It has no tab briefing (`resumeText` answers null for a session
  with no Dispatch), and `roll()` makes no blank-slate respawn without a briefing, so the tab always
  respawns with `--resume`. That is safe, but it differs from the app, which can brief a tab (the S6
  final review, M2).
- **The app-gone rule has two watchers**, `driving.ts` for the app-left steps and `appGone.ts` for the
  takeover (plan R25). They share `APP_LEFT_GRACE_MS` and `liveAppPid` and differ on purpose in one
  point (A69), but a change to one must be made to the other by hand.
- **A missing `app.pid` makes a live app look gone** (preflight R11). (resolved in the left-over limits
  pass, see Amendments A111: the Host's own `lastAppPid`, kept from the app's `hello`, stands in for the
  file) `markAppRunning` swallows a failed write, so a live app whose socket stays down past the 5 s grace
  is judged gone, and its sessions are taken. That is safe because the drop already disposed its chains
  (A69, preflight R10); the chain in the next entry is the exception.
- **A chain that was mid-roll when its app's socket dropped is not disposed by the drop** (preflight
  R10). It finishes its roll inside the app. If the Host then owns the pty, the adopter's unregister belt
  drops that chain when the app returns (A69, preflight R11).
- **A role-less older app (v1.3.17 to v1.3.25) counts as `cli`** (preflight C17), so `hasApp()` is false
  while it is attached and a takeover can run beside it. (Resolved in the left-over limits pass, see
  Amendments A123: a role-less `hello` is now a `legacy-app`, counted by `hasApp()`, so the Host no longer
  drives or takes over beside one. Applies only to Astera 1.3.25 and older.) The holders check protects
  every pty it has attached; a pty it is about to attach, with its `pty-list` answer still in flight, is
  not protected, unchanged.
- **An older app that attaches while a Host roll is past its last gate sees that roll finish beside
  it** (the residue of preflight B1). The gate in `roll()` is asked last after `prepareSpawn`, just before
  the kill. A roll past that point kills and respawns, and the older app's own chain for the old pty dies
  with the kill.
- **If the app dies after a roll decision and before the kill, a claude roll in flight can be lost.**
  There is never a second action, and the fallback trigger recovers it on the Host's side (the Task 6
  review, parked).

**The snapshot and the takeover**

- **A snapshot one change stale can type a carry-on prompt twice** (preflight C16): `awaitingPrompt: true`
  was written at the spawn and the later `false` write was lost. It is a second prompt, not a second
  roller.
- **A briefing longer than 16 KB is not stored in the snapshot** (`MAX_SNAPSHOT_PROMPT_CHARS`), so a
  takeover asks for it again. For a tab session the Host has no tab briefing, so that yields the plain
  carry-on line.
- **A codex chain snapshotted before its rollout was found, with no `locateSince`, is restored unmapped**
  and cannot roll (preflight R6, the Task 6 review). (resolved in the left-over limits pass, see
  Amendments A116: `locateSince` is now written at every codex locate, not only a blank-slate roll) Only
  a blank-slate respawn records `locateSince`.
- **If the first accounts read fails, the takeover is held until a read succeeds**, which is up to one
  15 s tick later (the Task 16 review). A takeover with no accounts would map nothing.
- **A Dispatch the app started and the Host rolled after a takeover** gets a Host tail from that roll on
  (A70). `worker-read` then answers from the Host with only the output since the roll; the earlier
  output stayed with the app's tail.

**Codex rollouts**

- **A codex blank-slate respawn's own locate does not exclude rollouts other notes claim** (preflight
  R7). Two fresh codex sessions in one folder and account at the same instant could swap, as A16's case
  can.
- **A rollout search skips only rollouts claimed within the same coordinator.** Two blank-slate rolls of
  one account in one folder within 60 s may cross, the same as they can live.
- **A codex rollout search that times out keeps `locateSince`**, and the search scans only today's and
  yesterday's folders. So a takeover days later finds nothing for a blank-slate codex respawn, and that
  chain stays unmapped. (The folder window is resolved in the limits pass, see Amendments A110: the
  search now scans forward from `locateSince`, bounded. A search that still times out keeps `locateSince`
  as before, and the new window is itself capped, see "Known limits after the limits pass".)

**The app beside a Host that rolls**

- **A rekey is forwarded to the renderer even when adopting the new pty failed.** (resolved in the
  left-over limits pass, see Amendments A121: the renderer is told only once the app holds the new
  session; the app's own taps still run either way) The renderer catches up at the next sweep.
- **A history resume that misses the app's local indexes while the Host rolls costs one `pty-list`
  round trip**, up to 5 s (`hostNativeGuard.ts`).
- **The app holds the old session's exit for up to 15 s** until its orchestration mirror shows the rekey
  (`HOST_ROLL_SETTLE_MS`). After 15 s it delivers the exit anyway.
- **The ordering hold's wiring in `ipc.ts` is not pinned by a test.** (resolved in the left-over limits
  pass, see Amendments A121: the composition moved into `installHostRollExit`, which is itself tested)
  The `withHostRollHold` wrapper is tested alone; the swap that puts it in front of the exit handler
  needs a `registerIpc` harness (the Task 14 re-review).

**`runs wait` and the usage lookup**

- **A coordinator's own wait is not a `limited` ending.** (resolved in the S6 limits follow-up, see
  Amendments A74: the coordinator's stop now counts, on the Run's `coordinatorStop`) The rule looked at
  open Dispatches only, and a coordinator is a Run's slot, not a Dispatch, so such a Run waited to its
  deadline (7).
- **`runs wait` ends `limited` only when no Task of the Run is ready to start and no check is running.**
  The reset it names is the earliest among the waiting workers (A68), and, since A74, among the
  coordinator's own stop too; a ready Task no longer holds `limited` back in a Run a coordinator drives,
  since only that stopped coordinator can start it.
- **The Host's usage lookup goes without the system proxy and the OS certificate store.** (resolved in
  part in the left-over limits pass, see Amendments A122: the Host trusts the OS certificate store at
  start, so a TLS-inspecting proxy no longer fails the lookup on its own; the system proxy itself is
  unchanged, see "Known limits after the left-over pass") Node's `fetch` honours neither by default, so
  behind a corporate proxy the lookup fails, and a failed lookup accepts the limit (Q4): detection is
  kept, and the brake against a false roll is weaker, as in the app when its lookup fails.
- **The Host's usage lookup under plain Node is unmeasured.** Task 18 does not measure it with a real
  account: the standing rule forbids copying a person's accounts or credentials into a scratch profile.
- **The Host's usage gate reads the claude credentials file or Keychain for the usage lookup**, the same
  as the app does (preflight R1, plan R28, the S6 design's §2.1).

## Known limits after the S6 limits follow-up

Each was found while building or reviewing the S6 limits follow-up and left as it is, with its reason.
Checked at `5338222f`.

- **A Slack offline summary can repeat.** (task-5-report.md; Amendments A78) When a sweep's Slack sends
  fail partway through, the ack is withheld, so the next sweep or reconnect fetches the journal again and
  resends every line that sweep did not confirm, not only the one that failed; a whole app restart
  forgets the in-memory `postedThrough` mark too, so the next attach can resend a session's line again
  even though it once went out. What bounds a repeat is the journal itself (A77), not the summary: 7
  days old, the newest 64 entries per roll chain, the newest 1024 overall, so it can echo at most that
  much, never a session's whole history. This is accepted (at least once), not a defect to fix.
- **A damaged roll journal resets `lastSeq` to 0.** (task-4-report.md; Amendments A77) There is nothing
  to salvage a sequence counter from once the file cannot be parsed, so the next entries start again from
  `seq` 1. An app that remembered an ack across its own restart could then think it has already seen the
  new low `seq`s and skip them, but the app never persists an ack (A78), so this is harmless as shipped;
  a future caller that does persist one would need to treat a `lastSeq` drop as "read the journal from
  the start again".
- **A same-account respawn with no `switching` entry stays silent.** (the controller's ruling,
  progress.md, Task 5 review; Amendments A78) `journalEntryOf` keeps a `rolled` link for every session
  rekey, including one a coordinator's in-place fallback causes with no account change, but `chainText`
  says nothing for a bare roll link on its own. By ruling, a `rolled` link alone is not evidence of an
  account switch, so the offline summary a person reads only ever names a wait, a switch or a resume,
  never the respawn underneath one. The desktop notice does not count it either.
- **A roll event between an app's hello and its adoption sweep reaches neither Slack nor the journal.**
  (final review M2) Once the hello lands, the Host sees an app attached and stops journaling, but the
  sweep has not yet registered the session's Slack record, so `SlackNotifier.onRollState` drops a
  `waiting` pushed in that gap. The gap is short, and S6 already had it for live pushes.
- **The coordinator's stale-stop rule is ten minutes, and covers only the coordinator.** (Amendments A74)
  A coordinator's stop is ignored by `limitedUntil` once its `resetsAt` is more than
  `STALE_COORDINATOR_STOP_MS` (10 minutes) in the past, so a missed clear cannot leave every wait on that
  Run ending `limited` forever. A worker Dispatch's own stop carries no such staleness check, unchanged
  from A68.
- **A person can still start a ready Task by hand while its Run is `limited`.** (Amendments A74) `limited`
  means nothing moves on its own before the reset, not that nothing can: the same as `waiting` and
  `paused`, a person may start a ready Task from RunDetail or `worker-start`, and that does not end the
  `limited` state early or contradict it.

## Known limits after the control plane follow-ups

Each was found while building or reviewing the control plane follow-ups and left as it is, with its
reason. Checked at `bf479b4e`.

- **The Host's tick waits for a coordinator start before it moves to the next due schedule.**
  (Amendments A79, A82) `orchFireTick` calls its due fires one at a time, in order, and
  `handToCoordinator`'s own start is a long await, so a second schedule due in the same tick sits behind
  the first's coordinator start rather than firing alongside it. If the driving process changes while
  that await is in flight, the fire loop drops the later fire in the same tick rather than retry it, on
  the same reasoning as the rest of the loop: losing one fire is safer than two processes firing the same
  schedule at once.
- **A stale `coordinatorStartingAt` marker is ignored, but nothing clears it from the state.**
  (Amendments A82) (resolved in the limits pass, see Amendments A107: the driving loop's own pass clears
  every marker past its window) Past `COORDINATOR_START_WINDOW_MS` the marker is read as a start that
  died with its process, so a ▶ or a later fire is free to try again, but the field itself stays on the
  Run until something else writes over it, a later hand-over or a failure. The sidebar reads it live, so ▶
  reappears only on the first commit after the window has passed, not the moment it does.
- **The window can be outlived by a start that is still genuinely running.**
  (Amendments A82) `COORDINATOR_START_WINDOW_MS` is two minutes, bounded by the spawn deadline plus the
  Run worktree the hand-over makes first; a very large repository's worktree creation can still take
  longer than that. So can, on a Host with no local spawner of its own, a `startCoordinator` call that
  Host forwards to an attached app whose own reply never comes. Either way the marker goes stale while
  its start is still in flight, and a second start can then be begun beside the first.
- **A coordinator stop that fails leaves the session alive, with no slot.** (Amendments A84) (resolved
  in the limits pass, see Amendments A106: the slot is kept, pending, until the stop is confirmed, not
  emptied on a mere attempt) The stop is best effort: a Host that does not hold the pty and has no app
  attached cannot stop it, and logs that. The slot is emptied anyway, so nothing asks again. The session
  then loops on `check --wait` on a finished Run until someone closes it.
- **The loop asks each finished coordinator to stop once per process.** (Amendments A84) (resolved in
  the limits pass, see Amendments A106: a refused or failed stop is retried, backing off from 30 seconds
  to 10 minutes, until the session is confirmed gone) A refused or failed `run-coordinator-stop` is not
  sent again by that process, so a transient failure waits for the Job's next fire, which stops the
  coordinator of a finished latest Run it finds still attached, or for a restart.
- **A Run with only its coordinator left is replaced only while that coordinator is parked.**
  (Amendments A84, the idle rule) A fire that finds the coordinator between two `check --wait` calls, or
  thinking, skips. Whichever process drives, a coordinator that parks in `check --wait` between turns
  is replaced at the first fire that meets it parked: the Host reads its own record, and the app asks
  the Host. An app in front of a Host too old to announce `coordinator-idle`, or one that does not
  answer within the orch-call deadline, reads the answer as unknown and skips, so there an objective-only
  scheduled Job whose coordinator never ends is skipped at each fire, as before U4, until its Run is
  stopped by hand. The same goes for `run-coordinator-stop` on a Run with no Tasks.
- **`jobs run` does not ask the idle rule.** (Amendments A83, A84) A Run with only its coordinator left
  does not count as running whether or not that coordinator is busy, so `jobs run` starts the next Run
  beside a coordinator that may still be doing the work itself. It stops nothing, so nothing is lost,
  but two Runs of one Job can then be going at once.

## Known limits after the chat takeover

Each was found while building or reviewing the chat takeover and left as it is, with its reason. Checked
at `3db032df`.

- **A session held on a permission prompt under `hold` waits for someone** (spec §4). With nobody there
  to answer, the turn does not go on until a person answers it from the CLI, with `astera chats answer`,
  or opens Astera.
- **Slack does not see a chat turn the Host owns**, until an app attaches (spec §4). (resolved by Slack in
  the Host, see Amendments A100: the Host feeds its notifier from its own `HostChats` events for every chat
  whose adapter it holds, whichever process owns Slack) The offline journal (Amendments A77, A78) covers
  rolls, not a chat session's own turns; while no app is open its conversation reaches Slack not at all.
- **The conversation view rebuilds from a 1 MB replay buffer** (spec §4), the same buffer a pty replay
  already used. A very long unattended stretch can exceed it, as it can today.
- **A carry-on lost between its mark and its write is not re-sent** (Amendments A87, A88; plan P4).
  `carrySent: true` is written before the send and put back to `false` when nothing reached the proc
  during that call, but a crash between the mark and the send itself, with nobody left running to notice,
  leaves the mark true over a prompt nobody ever typed.
- **A codex carry-on after a takeover of a proc whose `thread/resume` never finished fails, and is
  logged.** `HostChats.adopt` replays and sends the carry-on right after the takeover; for codex that
  assumes the thread already exists, true for a proc whose handshake finished. One the app left mid
  handshake has no thread yet, so the send is refused and left for the next writer.
- **An older app that attaches inside a Host-spawned proc's handshake breaks that handshake** (plan
  P11), the chat counterpart of the S6 older-app residue under "Known limits after S4+S5" (Amendments
  A69). The app becomes the proc's holder mid handshake, the Host's chain for it goes quiet, and a codex
  `thread/resume` left half finished never completes. Accepted, the same way the pty case is.
- **A few milliseconds separate the app's chat adopter from its `proc-attach`.** In that window the app
  has already adopted the proc locally, but the Host has not yet been told the app holds it, so both could
  write if a person acted right then.
- **A resume in place forwarded to the app is not retried if the app refuses it.** `chats.deliver` logs
  that the app's `chatSend` did not deliver the turn and does not resend it; the same session's next roll
  or reset still resumes normally.
- **A prompt the app answered while the Host was a reader stays in the Host adapter's queue until its
  echo.** Every Host view of it (`prompts`, `requests`, `hasOpenRequest`, the deny policy) filters the
  note's `answered` ids, which claude's adapter writes on every answer (A94). The queue itself clears
  only on the CLI's own echo, a `tool_result` line for claude or `serverRequest/resolved` for codex.
  (resolved in the left-over limits pass, see Amendments A117: the codex adapter writes `answered` ids
  too) A codex answer writes no `answered` id, so for codex the echo is the only thing that clears it.
- **A failed auto-deny is retried only on the next review trigger** (Task 7 review), not on a timer of
  its own: a request or status event, a writer change, or an adopt, not immediately. (resolved in the
  left-over limits pass, see Amendments A118: a failed deny now retries itself at 5, 15 and 60 seconds)
- **A limit that arrives while a prompt is open is dropped, not deferred** (Task 6 fix round 1). The
  chain simply does not act on it; the CLI reports the same limit again on its next call once the prompt
  is answered.
- **The history guard only returns a chat the app holds.** (resolved in part in the left-over limits
  pass, see Amendments A120: a Host chat proc the app has not adopted now refuses the resume instead of
  going ahead unguarded) A Host chat proc the app has not adopted yet, deferred or simply never adopted,
  is found in its note, but there is no live `SessionInfo` to hand back, so a resume by history id goes
  ahead unguarded. The pty guard has the same limit, unchanged, out of that task's scope.
- **`chats answer` is for a person; an agent session gets 403, by its environment** (the controller's
  ruling, Task 8 fix round 1; A94). A worker, a coordinator or a chat agent calling it from inside its own
  session is refused; only the shell and the app may call it. `chats pending` stays open to every caller.
  The check reads `ASTERA_SESSION`, which every terminal and chat session gets, so it stops an agent from
  answering by accident but is not a boundary: an agent that clears its own environment
  (`ASTERA_SESSION= astera chats answer ...`) reads as the shell and gets past it, as it can past every
  role check in this CLI. A real boundary needs a secret the agent cannot read, which is out of scope.
- **A Host-spawned chat proc whose start outlives the bound is ended, not handed over** (A94). Every step
  of a start has its own deadline, so this takes a start that hangs past all of them; the roll's new
  session is then gone and the chain is left with it, as after any failed respawn.
- **The Host inherits handles the app marked inheritable** (the end to end run). The app starts the
  Host with Node's `spawn`, `detached`, `stdio: 'ignore'` and `windowsHide` (`src/core/host/spawn.ts`).
  On Windows, libuv's process spawn passes `bInheritHandles` as true, as it must to hand any stdio over,
  and Node offers no way to name the handles a child may take, so every handle the app holds marked
  inheritable goes to the Host and lives as long as it does. Node's own handles are not (libuv creates
  its sockets, pipes and files non-inheritable); the one seen was Electron's DevTools socket: after an
  app started with `--remote-debugging-port=9451` quit, the port stayed listening until the Host it had
  started stopped, so the next app on that port had no DevTools. No other leak was looked for, and a
  packaged app never opens that port. A spawn with a handle allow list, or through a launcher that does
  not inherit, needs native code or a shell hop the app does not have; not done. Relaunch a debug app on
  a fresh port.

- **An app without the `chat-takeover` yield is not forwarded an answer.** Such an app has no
  `chatAnswer` to answer with, so the call is refused `not-held`, "answer it in Astera", instead of being
  forwarded to fail there.
- **A re-pointed tab after a reconnect carries no codex `dest`.** (resolved in the left-over limits pass,
  see Amendments A119: the Host notes `rollDest` on the new proc, and a re-point reads it back) The note
  the re-point reads from keeps none, so a codex chat roll's rollout watcher falls back to its own search
  after a re-point, until the chat's own `ready` registers the path.

## Known limits after Slack in the Host

Each was found while building or reviewing Slack in the Host and left as it is, with its reason. Checked at
`633be4b5`, and again after the final review's fixes (Amendments A105).

- **An installed build and a dev build that share one Slack app token still split replies** (spec §4). Slack
  delivers each socket-mode event to one of the connections sharing an app token, and the other only hears
  that the session has ended. The dev profile's own Slack intake stays off for this reason (project memory
  `dev-slack-intake-disabled`).
- **Right after a Host restart, a terminal session's pending tool is unknown** (spec §4). The hook event
  watcher starts at the Host's own start, not before, so a reply typed into a fresh Host's Slack thread types
  plain text into the pty rather than the choice key a known pending tool would pick (`pendingChoiceShape`);
  that is today's own fallback, not a regression (Task 7).
- **Webhook-only setups have no threads and no inbox**, as today (spec §4). A webhook posts one message per
  notice with no thread to reply into, and opens no socket-mode connection, whichever process holds Slack.
- **The Slack tokens are readable by a second long-lived process of the same user** (spec §4). `slack.json` is
  already plain JSON in the profile folder; the Host reading it too is no new exposure.
- **An older app in front of a Slack-owning Host briefly opens a second socket** (plan P4). Its socket opens
  before its hello does, so for the moment between the two, both the Host's socket and the older app's socket
  exist on the same token.
- **The app takes up to 15 seconds with no Slack intake after a Slack-owning Host goes away**
  (`SLACK_HANDBACK_MS`, plan P5). Its own sessions went with the Host anyway, so nothing that mattered was
  listening in that window.
- **A Host started with no Astera open takes Slack about 10 seconds after it starts**
  (`HOST_SLACK_START_GRACE_MS`, Amendments A105). Until then no notice is posted and no reply is read. The
  wait is what keeps a fresh Host from opening a second socket beside an Astera that holds Slack.
- **After Slack refuses the app token, intake stays off until the Slack settings are saved again**
  (Amendments A105). A regenerated token, an uninstalled app or a disabled workspace ends the socket for
  good, and retrying would only hammer Slack; the refusal is written to `slack.log`. Notices still post
  through the bot token while it is valid.
- **After a network outage, intake can take up to 5 minutes to come back** (Amendments A105). The reconnect
  wait doubles with each failure up to that cap, and resets once a connection holds.
- **At most 200 forwarded events are held while a Slack-owning Host is away** (Amendments A105). A grace is
  15 seconds, so this is far more than one holds; past it the oldest go first, and the log says so once.
- **A role-less app from before this feature (v1.3.17 to v1.3.25) is not seen by `appsKeep`, and counts as a
  CLI** (the S6 pre-flight finding this document already carries, preflight C17). (Resolved in the
  left-over limits pass, see Amendments A123: a role-less `hello` is now a `legacy-app`, counted by
  `appsKeep`, so the Host no longer opens its own Slack socket beside one. Applies only to Astera 1.3.25
  and older.) Such an app opens its own Slack socket beside a Host that, seeing no attached app keep
  Slack, believes itself active too.
- **The first roll event a Host misses because it was not yet running leaves its new session to the next
  tick's reconcile, briefly a new root.** The deferral that holds a rolled session's new pty back (Amendments
  A99, plan P7) works only while the notifier already holds the session its `rolledFrom` names; a Host that
  starts after the roll happened holds nothing, registers the new entry at once, and only a later active
  settle's `reconcile({ fromNotes: true })` (Amendments A100) can pull the thread back from the note, once
  something has written it there.
- **A codex terminal session adopted with no rollout path yet noted is watched only from a new file.** The
  Host's own rollout watcher starts a session's watch from its note's `rolloutPath` rather than a backward
  scan (Amendments A100), so turns already written to an existing rollout before the note named it are never
  read; only a file written from that point on is seen.
- **An inactive Host still updates its own notifier records, but posts nothing.** Hook events, the Host's
  rolling chains and its codex turns keep reaching the notifier while an app keeps Slack, so a record's dedup
  window and chat state keep moving with no transport behind them (Task 6). Harmless while the app is the one
  actually posting.
- **After a Host outage longer than 15 seconds, the app keeps Slack until it quits**, even once a new
  Slack-owning Host attaches (Task 8). S1 still holds, because Slack still moves to the Host the moment Astera
  closes; a clean mid-connection handover back to the Host would need an additive yields-update message, not
  built.
- **A Host that takes a yielding hello and then stays silent for longer than a full grace can briefly overlap
  the app's own socket**, until its reply arrives and the app yields at once (Task 8). The same class of
  window as the older-app case above.
- **Sessions spawned while the Host owned Slack get new roots if Astera takes ownership back mid-run.** The
  app's notifier still registers every spawn and adopt with no transport and no posts while the Host owns
  Slack, but such a session has no noted thread in the app's own record; per plan P5 those sessions went with
  the Host, and a hand-back finds nothing noted to resume (Task 8).

## Known limits after the limits pass

Each was found while building or reviewing the remaining limits pass and left as it is, with its reason.
Checked at `68a2bfca`.

- **A stop the live session always refuses is retried every 10 minutes, forever** (Amendments A106).
  (resolved in the left-over limits pass, see Amendments A113: after six tries at the cap the loop gives
  up and logs once, in that process) A finished Run that `runMoves` still counts as moving, or any other
  stop a session keeps refusing for good, used to be asked once; now the backoff caps at
  `COORDINATOR_STOP_RETRY_MAX_MS` and the loop keeps asking, with a log line each time, since nothing
  tells it the refusal is permanent.
- **A slot this process never held can be retried even once the session is actually gone, because
  liveness cannot be told** (Amendments A106). (resolved in the left-over limits pass, see Amendments
  A113: bounded by the same give-up-after-six-tries rule, though liveness still cannot be told any
  sooner) `sessionGone` only answers from what this process itself can see: the Host from an ended pty in
  its own registry, the app from its own session list, which must show a real exit code. A lost-sight
  exit, or a session spawned or adopted by a different process, answers `false` either way, so such a
  slot keeps being retried at the 10 minute cap instead of being confirmed and released.
- **The Jobs sidebar stays silent while the Host's first settings read hangs** (Amendments A108).
  (resolved in the left-over limits pass, see Amendments A114: after about 10 s of a parked Host with no
  gate read yet, the sidebar now says it is still reading its settings) Parked with no gate read yet, the
  moment before the Host has ever read its settings, answers `null` from `jobsStall`; if that first read
  itself hangs, the sidebar says nothing until it lands, the same silence as before this pass, now
  narrowed to just that one moment.
- **The codex rollout search no longer reaches a worker's own birth folder once that folder is more than
  14 days behind today or `bornBefore`** (`ROLLOUT_SCAN_DAYS_MAX`, Amendments A110). (resolved in part in
  the left-over limits pass, see Amendments A115: the folders around `since` are read too, so this caller
  reaches its own birth folder again; a window wider than 14 days still skips what sits between the two
  anchors, see "Known limits after the left-over pass") The cap keeps the newest folders, ending at today
  or at `bornBefore`'s next day, not the ones nearest `since`, so a live locate and a restore, whose
  window sits close to `now` or to `bornBefore` either way, are unaffected. A caller with an old `since`
  and no `bornBefore` is the one this bites: a limit probe asked about a worker started more than 14 days
  ago no longer reads the date folder that worker's rollout was actually born in, since the folders read
  now run backward from today instead.

## Known limits after the left-over pass

Each was found while building or reviewing the left-over limits pass and left as it is, with its reason.
Checked at `1c8e0ba0`.

- **The Host's usage lookup still goes without the system proxy** (Amendments A122). The OS certificate
  store is trusted now, so a TLS-inspecting proxy no longer fails the lookup on its own, but Node's
  `fetch` still does not read the system proxy, so a corporate proxy that requires one still fails the
  lookup the same way it always did (Q4).
- **On Windows, the Host inherits the app's DevTools socket** (see "Known limits after the chat
  takeover"). Unchanged: a dev build started with `--remote-debugging-port` leaves that port listening
  in the Host after the app quits, so the next dev build on the same port has no DevTools. Dev only;
  relaunch on a fresh port.
- **The conhost reaper runs only when no pty is live, and a pid it is about to kill could in theory be
  reused** (Amendments A124). A Host that always holds at least one live pty keeps its leaks until every
  such tab closes, and the sub-second window between the reaper's last look and its kill could, in
  theory, see an unrelated process take the same pid; nothing checks the name again at kill time.
- **Giving up on a stop lasts only for the process** (Amendments A113). The six-tries give-up is in
  memory: a Host restart or a new driving process asks that coordinator to stop again from the start,
  at 30 seconds, so a permanent refusal is quiet for a while and then noisy again after any handover.
- **A rollout search window longer than 14 days skips its middle folders** (Amendments A115). The cap
  still reads only 14 date folders; reading `since`'s own neighbourhood as well as the newest ones means
  whatever sits between the two, on a search that spans weeks, is not read.
- **`jobs run` beside an idle coordinator stays as it is (user decision, 2026-09-26).** The user chose
  not to make a manual `jobs run` replace a Run whose coordinator only waits, as a fire does. Kept as a ruling, not changed
  by this pass (`.superpowers/sdd/2026-09-26-leftovers/plan.md`, "Kept as they are"; see also "`jobs run`
  does not ask the idle rule" under "Known limits after the control plane follow-ups"). A Run with only
  its coordinator left does not count as running whether or not that coordinator is busy, so `jobs run`
  can start a new Run beside one still doing the work itself; nothing is lost, but two Runs of one Job
  can then be going at once, and closing that gap needs a person's call on which Run should win.

## Known limits after the Host journal

Each was found while building or reviewing the Host journal and left as it is, with its reason.

- **A crash between the state save and the journal append can drop that change's rows** (spec, A125).
  The Host journals after the commit lands, as the app did (F56). A crash in between keeps the state and
  loses the rows for that change.
- **An older app that opened the file before the v3 bump keeps writing for that session** (spec). It
  opened a v2 file it could use, so it goes on appending until it restarts, while the Host holds off
  because that app does not yield `journal`.
- **The reconciler runs only while the app is open** (spec, A125). Recovery decisions are still the
  app's. A worker the Host lost is journaled with Astera closed, but nothing recovers it until Astera
  opens.
- **While an older app is attached to a v3 file, nobody journals** (P9, A126). The Host holds off because
  the app does not yield `journal`, and the older app refuses a file at version 3. Once it leaves, the
  Host journals again.
- **Reconciler rows made while the app's socket is down are lost** (P8). With a journal Host last seen,
  the app writes nothing locally, so a row that cannot reach the Host is logged and dropped.
- **The owed baseline lives in the Host's memory** (A132). A `journal-reload` that turned journaling on
  while an older app held the journal owes a `CONTINUITY_ENABLED` baseline. If the Host restarts before
  it becomes the writer, that baseline is never written.
- **A failed v3 migration leaves journaling off for that profile until the file is fixed** (A127). The
  file stays where it was, readable, and every start logs that it could not be upgraded.
- **The Host's validation diff base stays null** (P11). The spec did not move it; it is a one line
  follow-up now that the Host holds the journal.
- **A `state-put` taken before the Host held any state is not journaled** (P15). Only an older app sends
  one, and the Host logs and skips it rather than journal the whole state as new.
- **A toggle turned on while the app has no orchestration handle reaches the Host only at the next
  change.** The app sends `journal-reload` from its toggle handler only when it holds that handle, which
  it normally does. Otherwise the running Host learns of it at the next settings change or its next
  start.
- **A corrupt journal cannot be moved aside on Windows while an app holds its reader open.** The rename
  fails, so the Host logs that it could not open the journal and journals nothing for the rest of its
  life.
- **The Host prints Node's one `ExperimentalWarning` for `node:sqlite` on stderr.** It lands in the
  Host's log once per start and means nothing is wrong.

## 0. The problem, measured

The goal is: `astera host start`, `astera jobs run --id <job>`, `astera runs wait --id <run>`, and the
wait ends `completed` with no Astera window ever opened.

Today it cannot, for four separate reasons, each at a specific line.

1. **Nothing dispatches.** `jobs run` goes to `run-start` (`command.ts:937`), which for a Job with no
   coordinator account only releases `pendingStart` and commits (`command.ts:1286`). The Job
   keeps `autoDispatch` (`command.ts:856`), and the only thing that reads it is the app's
   `runScheduler` (`src/main/ipc.ts:3513-3911`), reached from the app's commit hook
   (`ipc.ts:4006`, `src/main/orchestration/commitHook.ts:114`). With no app, the Run sits `running`
   and `runs wait` holds for its hour. This is audit item 1 (`cli-spec-audit.md:140`, #99).
2. **Nothing spawns.** Even a coordinator-driven Job (one with `coordinatorAccountId`) fails:
   `startCoordinator`, `startWorker`, `makeRunWorktree` are PROPAGATES (`src/host/orchDeps.ts:28-37`)
   and are refused with CONFLICT when no app is attached (`orchDeps.ts:395-402`).
3. **Nothing notices a worker die.** `handleExit` runs only in the app: session exit reaches
   `OrchRollTap.onExit` (`ipc.ts:1498`, `src/main/orchestration/rollTap.ts:88-104`). A worker that
   dies with the app closed leaves its Dispatch open until the Host's next `store.load`.
4. **Nothing validates.** `startValidation`, `startReview`, `startRepair` are FIRE_AND_FORGET
   (`orchDeps.ts:126-128`): with no app they are logged and dropped (`orchDeps.ts:470-477`). The Task
   stays `validating`; the app's resume sweep re-drives it when an app attaches (ruling F27,
   `ipc.ts:4807`, `ipc.ts:2494`). `runs wait` holds meanwhile.

What already moved toward the Host and is reused here: accounts and run configs read from the
profile when no app is attached (`orchDeps.ts:150-167`, `src/host/orch.ts:399-402`); sessions list,
read and send answered from the Host's own registries (`orchDeps.ts:184`, `src/host/sessions.ts`);
hook event state read from the profile (`src/host/sessions.ts:216-220`); a chat turn written by the
Host when no app is attached (`orchDeps.ts:217`). Track A is making the idle exit count running Runs
through `liveCounts` (working tree, `src/host/index.ts:194-197`), which this design depends on.

## 1. Scope and order

### 1.1 Which slices the goal needs

| Slice | Needed for "Jobs advance with no app"? | Why |
|---|---|---|
| S2 session spawn | **Yes** | Every worker, reviewer, repair worker and coordinator is a session. |
| S3 worktrees | **Yes** | An app-driven Run gets its worktree lazily from the scheduler (`ipc.ts:3669-3722`); a concurrency-2 Run puts each Task in `worktree: 'new'` (`ipc.ts:3855-3866`); a coordinator Run gets its worktree at `run-start` (`command.ts:1290-1306`). All of it is `forkWorktree` (`ipc.ts:2634-2657`). |
| S4 dispatch loop | **Yes** | Reason 1 above. |
| S5 validation, review, repair | **Yes, or the refuse rule** | Reason 4 above, and the §2 trap. |
| S5 recovery reconciler | **No** | It only acts on attempts the Continuity journal witnessed (`src/main/recovery/reconciler.ts:117-122`). An attempt made with no app has no rows, so the reconciler leaves it alone. That is the conservative direction. See D8. |
| S6 rolling and limits | **No** | A worker that hits a limit with the app closed stalls; nothing is corrupted. See §6. |

### 1.2 The sequence

Four merges, the first three shippable on their own, the goal reached at the fourth.

1. **S2: the Host spawns orchestration sessions.** Opens: `worker-start` from a shell or a
   coordinator with the app closed, for placements that need no new worktree (`--worktree current`,
   an explicit path, or a Run that already has one). Coordinator-driven Jobs whose Run worktree
   already exists advance with no app.
2. **S3: the Host owns Job worktrees and the git that merges them.** Opens: `worktree: 'new'`,
   `run-start`'s worktree, `run-merge`, `run-delete --merge/--remove-worktrees` with no app.
   Coordinator-driven Jobs advance with no app in every placement.
3. **S4 + S5 together: the Host drives.** The dispatch loop, schedule firing policy (D2), coordinator
   nudges, the unattended-question net, the pending-report drain, **and** validation, review and
   repair move in one merge. Opens: the goal.

**The S5 trap is resolved by moving S5 with S4** (recommended, D1). The alternative, if S4 must ship
first, is the precise refuse rule in §5.4. Either way nothing ships where a validation-bearing Task
reads as done without having been validated.

S6 follows later, independently.

### 1.3 What each slice moves, measured

`bootOrch` in `src/main/ipc.ts` runs from line 2289 to 4977: **2,689 lines**, the whole of the
orchestration wiring. Its sections, and which slice takes each:

| `ipc.ts` lines | Size | What | Slice |
|---|---|---|---|
| 2306-2335 | 30 | CLI entry, skills path, specs dir, `LAUNCH_FORBIDDEN` check | S2 (paths travel in the Host's env, §2.2) |
| 2337-2367 | 31 | the store facade over the mirror | stays |
| 2368-2600 | 233 | continuity open, pending queue read, mirror fill, boot log lines | drain moves in S4; continuity stays (D8) |
| 2552-2569 | 18 | stale spec file sweep | **S2** (the Host writes spec files; §2.7 race) |
| 2602-2657 | 56 | `forkWorktree` | S3 |
| 2680-2723 | 44 | `preTrustWorkspace` | S2 |
| 2725-2821 | 97 | `OrchCoordinator` construction and its `spawnSession` adapter | S2 |
| 2823-2948 | 126 | `TaskValidator` construction, runner, `onSettled`, `onCannotRun` | S5 |
| 2950-3133 | 184 | `reviewGate`, `startReview` | S5 |
| 3135-3167 | 33 | `gateSlot` | S4 |
| 3169-3502 | 334 | `Integration`, `reapWorktree`, `integrateWorktrees` | S3 |
| 3504-3911 | 408 | `runScheduler` | S4 |
| 3913-3964 | 52 | nudge threshold, `orchFireTick` | S4 |
| 3966-4009 | 44 | the commit hook wiring | stays (its `schedule` becomes a no-op, §4) |
| 4011-4044 | 34 | `firstImplDispatch`, `changedFilesSince` | S5 |
| 4046-4547 | 502 | the `OrchServerDeps` literal | split across S2, S3, S5 (§1.4) |
| 4549-4625 | 77 | `repairDeps`, `resumeSweep`, `buildRecovery` | S5 (repair, sweep); recovery stays |
| 4627-4670 | 44 | the always-on migration (F62) | stays; the Host gates on its marker (§4.6) |
| 4672-4807 | 136 | shuttle, `orch` assignment, drain, first scheduler run, sweeps | S4 |
| 4810-4845 | 36 | `releaseCoordinator` | S2 (exit handling, §2.6) |
| 4847-4877 | 31 | `nudgeSleepingCoordinators` | S4 |
| 4879-4977 | 99 | timers, stubs, rolling taps | timers S4; stubs and rolling stay |

Electron-free modules that move whole (measured, `wc -l`): `src/main/orchestration/coordinator.ts`
954, `tail.ts` 124, `release.ts` 32, `limitProbe.ts` 154 (S2); `validator.ts` 303, `repair.ts` 239,
`reviewGate.ts` 127, `resumeSweep.ts` 56, `src/main/run/prepare.ts` 171, `src/main/runManager.ts` 373
(S5); `src/main/statusline.ts` 390 (S2). Each imports only `node:*` and `src/core/*` (checked by
reading their import lines). They move to a new `src/core/orchestration/exec/` (statusline excepted,
amended 2026-09-24, see Amendments A13) so both the app and the Host bundle can import them, which keeps one literal of each while both processes still use them
(§7.3).

### 1.4 The orchDeps classification per slice

`hostOrchDeps` classifies all 34 keys and fails the build on an unclassified one
(`orchDeps.ts:228-334`). Each slice moves names into a new group, `HOST_LOCAL`: answered by the Host
itself whether or not an app is attached.

| Name | Today | After |
|---|---|---|
| `startWorker`, `startCoordinator`, `releaseWorker`, `readWorker` | PROPAGATES | HOST_LOCAL in S2, per call (amended 2026-09-24, see Amendments A4, A5) |
| `probeLimit` | SWALLOWED | HOST_LOCAL in S2 (pure file reads, `limitProbe.ts:17-23`) |
| `readReviewFile` | SWALLOWED | HOST_LOCAL in S2 (a read of the Host's own specs dir) |
| `makeRunWorktree`, `mergeWorktrees`, `removeWorktrees` | PROPAGATES | HOST_LOCAL in S3 |
| `resolveProjectRoot` | SWALLOWED | HOST_LOCAL in S3 (worktree list plus Job cwds; still degrades) (amended 2026-09-25, see Amendments A66: it stayed SWALLOWED through S4+S5, and is HOST_RESOLVES now) |
| `startValidation`, `startReview`, `startRepair` | FIRE_AND_FORGET | HOST_LOCAL in S5 |
| `repairTargetFor`, `repairOnce`, `lang` | DEGRADES | HOST_LOCAL in S5 (`lang` from `app-settings.json`) |
| `listRunConfigs` | LOCAL_WHEN_ABSENT | unchanged |
| `unregisterRolling`, `onDispatchLost` | FIRE_AND_FORGET | unchanged (rolling and recovery stay, S6/D8) |
| `browserEnabled`, `browserRun` | PROPAGATES | unchanged forever (needs an Electron window) |
| `handoffEnabled`, `handoffs.*`, `trackingEnabled`, `sessionTasks.*`, `chatPending`, `chatSend` | as today | unchanged |

**F58 must be honoured when `repairTargetFor` leaves DEGRADES** (`orchDeps.ts:65-72`): its `null`
fallback is what makes a swallowed `startRepair` safe. In S5 both become local in the same commit, so
there is no state in which `startRepair` is swallowed while `repairTargetFor` answers a real target.
The comment at both ends is rewritten in that commit.

## 2. S2: session spawn in the Host

### 2.1 What moves, what stays, what the app becomes

**Moves.** The orchestration spawn path only:
- `OrchCoordinator` (`coordinator.ts`, 954 lines) and its deps adapter (`ipc.ts:2725-2821`).
- The `startWorker` wrapper: rolling chain choice, login lookups, tail start (`ipc.ts:4191-4278`,
  88 lines). Its body becomes one shared function, `startWorkerWithChain(ctx, args)`, called by both
  processes.
- `startCoordinator` (`ipc.ts:4139-4190`, 52 lines), `releaseWorker` (`ipc.ts:4279-4290`),
  `readWorker` (`ipc.ts:4308-4312`), `preTrustWorkspace` (`ipc.ts:2680-2723`).
- `WorkerTails` (`tail.ts`), fed from `PtyRegistry.onData` in the Host.
- `makeLimitProbe` (`limitProbe.ts`) with the statusline payload read from the profile.
- Worker exit handling while no app is attached (§2.6), including `releaseCoordinator`
  (`ipc.ts:4819-4845`). (amended 2026-09-24, see Amendments A1: the owner is per pty)
- The stale spec file sweep (`ipc.ts:2562-2569`).

**Stays.** Every session a person opens: `spawnSession` (`ipc.ts:1717-2022`, 306 lines) is not
touched. Rolling and codex rolling registration, Slack, schedules, the codex rollout watcher, the
renderer's tabs, backpressure acks.

**The app becomes, for orchestration sessions, an adopter and a display.** It learns of each
Host-spawned session from a push (§2.3), adopts it through the exact adopter the reattach sweep uses
(`ipc.ts:7151-7275`), and from then on treats it as it treats any session it took back after a
restart: tab, rolling, Slack, schedule, codex rollout. The app keeps its own copy of the spawn path
for one purpose only: a Host that does not announce `spawn` (§7.2). (amended 2026-09-24, see
Amendments A4: in S2 the app also spawns its scheduler's starts and every `worktree: 'new'` start)

### 2.2 Environment assembly in the Host

The Host builds the same environment the app builds. The pieces, and where each comes from:

| Piece | App today | Host in S2 |
|---|---|---|
| Base env | `process.env` of the app (`src/core/sessions/manager.ts:162`) | `process.env` of the Host, minus a strip list (below). D4. |
| Config-dir variable, cleared managed and inherited keys | `cliEnvFor` (`src/core/sessions/cliEnv.ts:61-89`) | the same function |
| `CLAUDE_CODE_GIT_BASH_PATH` | `findGitBash` (`manager.ts:167-170`) | the same code: `SessionManager` is electron-free and is constructed in the Host |
| `ASTERA_STATUSLINE_OUT`, `ASTERA_STATUSLINE_ORIGINAL`, `ASTERA_HOOK_OUT` and `--settings` | `StatusLineManager.spawnConfig` (`src/main/statusline.ts:359-370`) | the same class, constructed on the profile, **without `init()`** (below) |
| `ASTERA_CLI`, `ASTERA_PROFILE_DIR`, `ASTERA_SKILLS`, `ASTERA_SESSION`, PATH prepend | `orchEnvOf` (`ipc.ts:1291-1298`) into `manager.ts:176-203` | paths from new Host env variables (below) |
| `--add-dir` for the screenshot folder | `sessionReadDirs` (`src/main/core.ts:241`) | `previewShotsDir(profileDir)`, the same function |
| Account | `core.accounts.get` | `readAccountEntries(profile/accounts.json)` (`src/host/index.ts:177`), read only |
| Permission mode | `core.appSettings.getAgentPermissionMode()` (`ipc.ts:2754-2755`) | read from `app-settings.json`, read only, the same pattern `src/cli/skills.ts:86` uses; default `yolo` as the store's (`src/main/appSettingsStore.ts:118`). D12. (amended 2026-09-24, see Amendments A10: a damaged file refuses the spawn) |

**The strip list.** The Host's own environment is not a clean base. `hostSpawnPlan` sets
`ELECTRON_RUN_AS_NODE=1`, `ASTERA_HOST_PROFILE_DIR`, `ASTERA_HOST_LOG`, `ASTERA_HOST_VERSION`
(`src/core/host/spawn.ts:50-56`). A worker inheriting `ELECTRON_RUN_AS_NODE=1` turns any Electron
binary it runs, this repository's own dev app included, into plain Node. So the Host's base is its
env with `ELECTRON_RUN_AS_NODE` and every `ASTERA_HOST_*` removed, then handed to `cliEnvFor`. The
list sits beside `NOT_INHERITED` (`spawn.ts:8`) as one exported constant with a test.

**Three paths the Host cannot compute, carried in its env.** The shuttle and the skills folder are
properties of the app build, not the profile, and the Host in a packaged install runs on the prepared
Node runtime (`scripts/host-runtime.mjs:50`), which cannot run a script inside `app.asar`.
- `ASTERA_HOST_CLI_EXEC` and `ASTERA_HOST_CLI_ENTRY`: the Electron executable and `out/main/cli.js`.
  The app passes `process.execPath` and `cliEntryPath()` (`ipc.ts:2284-2287`); `astera host start`
  passes its own `process.execPath` and `process.argv[1]` (`src/cli/host.ts:352-354`), which are the
  same pair because the CLI already runs as `ELECTRON_RUN_AS_NODE` Electron. The Host writes the
  shuttle into `profile/orch` with `writeShuttle` (`src/main/orchestration/shuttle.ts:54`, moved to
  core) if it differs, exactly as `ipc.ts:4679` does.
- `ASTERA_HOST_SKILLS`: the skills folder (`ipc.ts:2307-2309`); the CLI already resolves it
  (`resolveSkillsDir`).

A Host that was started without these (an older app or CLI) answers every Host-local spawn with the
refusal it answers today, `APP_REQUIRED`, and logs which variable was missing. It does not guess a
path.

**Statusline init is split.** `StatusLineManager.init()` does two different things
(`statusline.ts:204-330`): it writes the capture scripts and settings files, and it deletes the hook
events folder as app-start cleanup ("a queue the app drains"). The Host must do the first and never
the second, because the second would erase the events of sessions it is running. `init()` becomes
`ensureFiles()` plus `startupCleanup()`; the app calls both, the Host only `ensureFiles()`. The
scripts are written with `writeScript`'s skip-identical and busy-rename retry (`statusline.ts:85-131`),
so two processes writing the same content is already safe (ruling from e127640).

### 2.3 How the app learns about a Host-spawned session

**One new push, `pty-opened`**, broadcast by the Host when **it** opens a pty (not when a client
asks it to with `pty-spawn`):

```text
host -> clients   { t: 'pty-opened', entry: PtyEntry }
```

`PtyEntry` is the shape `pty-listed` already carries (`src/core/host/protocol.ts:85-93`), so the
app's handler is the reattach sweep's per-entry body (`src/main/host/reattach.ts:97-132`) applied to
one entry: `heldLive` guard, `attach`, adopter, `pty-attach` replay (amended 2026-09-24, see
Amendments A6: a queued sweep of that one pty over a fresh `pty-list`). The adopter is the existing one
(`ipc.ts:7151-7275`), which already registers rolling from `rollAccountIds`, Slack, the schedule, the
codex rollout watcher, and sends `session:created` so the renderer builds the tab.

**The note is the one `SessionManager.spawn` writes** (`manager.ts:209-228`): `kind: 'session'`,
`id`, `restore: { accountId, cwd, title, resumeSessionId?, rollAccountIds?, rollPrompt?,
bypassPermissions? }`. Because the Host constructs the same `SessionManager`, the note is byte-for-byte
the note an app-spawned worker has. That is what makes this version-safe: an older app that ignores
`pty-opened` (unknown message types reach no subscriber; the app's handlers filter on `m.t`,
`ipc.ts:6831`, `ipc.ts:6856`) still adopts the session at its next reattach sweep, because the note is
one it can read. The kill-on-unreadable rule (`reattach.ts:104-109`, `reattach.ts:120-125`) can never
fire on a Host-spawned worker.

**The race with the reattach sweep** (a `pty-opened` arriving while the app is mid-sweep over a
`pty-list` that already contains the same pty) is closed by `heldLive`, which both paths consult
before adopting (`reattach.ts:62-63`, `ipc.ts:7143-7149`). The two paths share one queue
(`takeSessionsBack`, `ipc.ts:7101-7106`), so the second one to run sees the first one's record.

**No app attached**: nothing to tell. The next app adopts at its reattach sweep, the same way it takes
back any session that outlived it.

### 2.4 Folder trust

Same rule, new place: only orchestration spawns pre-trust, never a person's tab (the reasoning is at
`ipc.ts:2680-2699`, measured 2026-09-22). The Host calls `markClaudeProjectTrusted` with
`claudeConfigFileFor({ configDir, homeDir: os.homedir(), ambient })` or `markCodexProjectTrusted`
(`ipc.ts:2703-2719`), both in `src/core/accounts/claudeTrust.ts` (129) and `codexTrust.ts` (200),
both electron-free. `app.getPath('home')` becomes `os.homedir()`; for one OS user these are the same
folder. Best-effort as today: a config it cannot write is logged and the spawn goes on. The trust
decision stays keyed on the worker's `cwd` (memory note on Claude folder trust, `f5982a0`).

### 2.5 Codex versus Claude

- **Claude.** Statusline plus hooks. Every worker carries `rollAccountIds`, so `wantToolHooks` is true
  (`manager.ts:147`) and it gets the tool-hook settings file; that is today's behaviour, recorded at
  `ipc.ts:2665-2679`. Limit probing reads the statusline payload the capture script writes under the
  profile.
- **Codex.** No statusline and no hooks (`usesStatusLine` false); `sessions list` reports its state
  `unknown` today and still will. Its rollout file is found by the app's `CodexRolloutWatcher`
  (`src/main/codexRolloutWatcher.ts`, 400 lines), which writes `rolloutPath` and `codexSessionId` into
  the note. A Host-spawned codex worker with no app attached would have no mapping, which costs the
  limit probe (`limitProbe.ts:20` uses `findRollout`) and, later, rolling. So the Host runs the same
  locate once per codex worker it spawns (`src/core/rolling/codexLocate.ts`, 116 lines, `since` = the
  spawn moment, which is the safe case the adopter's comment describes at `ipc.ts:7198-7205`) and
  writes the mapping with `registry.note`. The adopter then takes the mapped branch
  (`ipc.ts:7219-7227`) and never scans.
- Trust differs per provider, as above.

### 2.6 Exit handling: one owner, and it follows rolling

`handleExit` (`command.ts:2646`) is what closes a Dispatch whose worker died. Today the app calls it,
deferred by `EXIT_DEFER_MS` so that a roll's kill is not read as a death (`rollTap.ts:32-104`). The
roll's rekey (`rollTap.ts:130-`) is app-side and stays app-side until S6.

**Rule: while an app is attached, the app handles session exits; while none is, the Host does.**
(amended 2026-09-24, see Amendments A1 and A3: the owner is the socket that spawned or attached the
pty, whatever its role, and the Host owns every other session pty) The
reason is that the only exits that must not close a Dispatch are the ones a roll makes, and rolls only
happen where rolling runs. With no app there is no roll, so the Host can call `handleExit` on every
`kind: 'session'` exit with the same 3-second defer and be right. With an app attached, the app
already sees the exit (it adopted the pty) and already defers it correctly.

**The handover sweep.** Ownership changes when the app attaches or detaches. An exit that lands in
the gap (the app quits inside its own 3-second defer, `rollTap.ts:88-104`) would otherwise be lost
until the next `store.load`. So each time ownership passes to the Host, the Host runs one sweep: every
open Dispatch whose `sessionId` is not alive in its registry goes through `handleExit` (amended
2026-09-24, see Amendments A2: only after a socket that held a pty closes, and only for sessions the
registry holds as ended). Ids starting
`pending:` are skipped (a spawn in flight, §8.1). `PTY_LOST_SIGHT_EXIT_CODE` never arises inside the
Host: it is the app's code for losing the socket (`src/main/host/ptyFactory.ts:74-82`).

`releaseCoordinator` (`ipc.ts:4819-4845`) follows the same owner: a coordinator session's exit with no
app attached detaches the coordinator slot in the Host. (amended 2026-09-24, see Amendments A1: the
exit of a coordinator no app holds)

### 2.7 Spec files and the sweep race

After S2 the Host writes worker spec files into `profile/orch/specs` (`coordinator.ts` via
`specsDir`, `ipc.ts:2800`). The app's boot sweep deletes spec files not named by an open Dispatch in
the state it read (`ipc.ts:2562-2569`). A Dispatch the Host opens between the app's `state-get` and
its `readdir` has its spec file deleted under a live worker. So the sweep moves to the Host, at
`ready()` after `store.load` (`src/host/orch.ts:331-363`), where the Host is the only writer and the
set is exact. The app stops sweeping when the Host announces `spawn`.

### 2.8 Busy signal

`OrchCoordinator.isBusy` gates typing into a reused terminal (`coordinator.ts:655-670`,
`coordinator.ts:881-885`). The app answers it from its `BusyScanner` (`ipc.ts:2139-2150`,
`src/core/terminal/busy.ts`, 51 lines, core). The Host feeds a `BusyScanner` per `kind: 'session'`
pty from `registry.onData`, and uses the same `busyTitleReliable` gate. The hook state the Host
already derives (`sessions.ts:216-220`) is the second opinion: `working` counts as busy. (amended
2026-09-24, see Amendments A9: the scanner alone)

### 2.9 Chat sessions

Out of S2. Orchestration never spawns a chat session (every worker is a pty; `adopt` refuses anything
but `kind: 'session'`, `manager.ts:322`). The Host already reads and writes chat sessions it holds
(CLI phase D4). `sessions create` (audit #28) would be the first Host spawn of a person's session and
is a separate decision (it would change the rule in §2.10).

### 2.10 What must not change for sessions a person opens

1. They are spawned by the app's `spawnSession` (`ipc.ts:1717-2022`), never by the Host.
2. They are never pre-trusted (`ipc.ts:2684-2688`).
3. Smart resume, blank-slate resume, transcript copy across accounts, the chat fork, schedule, Slack,
   rolling and codex rollout registration all stay exactly where they are (`ipc.ts:1769-2020`).
4. Their notes are unchanged, so an older Host and an older app read them as before.
5. The Host's exit handling ignores them: `handleExit` finds nothing for a session id no Dispatch
   names, and `releaseCoordinator` finds nothing for a session id no Run names.
6. `StatusLineManager.startupCleanup()` still runs at app start, as today.

## 3. S3: worktrees and the git the Host runs

### 3.1 What moves

- `forkWorktree` (`ipc.ts:2634-2657`): repo probe, `symbolic-ref --quiet --short HEAD`,
  `workerBaseFailure`, `createWorktree`, warnings logged.
- `reapWorktree` (`ipc.ts:3207-3245`) and `WORKTREE_CLOSE_TIMEOUT_MS` (`ipc.ts:3191`).
- `integrateWorktrees` and its `Integration` type (`ipc.ts:3169-3502`).
- The three deps: `mergeWorktrees` (`ipc.ts:4088-4100`), `removeWorktrees` (`ipc.ts:4103-4117`),
  `makeRunWorktree` (`ipc.ts:4124`).
- `isPathInUse` for these paths. The app's version (`ipc.ts:5096-5105`) reads its own sessions and
  runs; the Host answers from its registry, which holds every pty of every kind with its cwd in the
  note, so it is at least as complete.

Core modules already used, unchanged: `src/core/worktrees/create.ts` 98, `remove.ts` 188, `git.ts`
230, `registry.ts` 88, `base.ts` 98, `include.ts` 135, `naming.ts` 79; the pure judgements in
`src/core/orchestration/integrate.ts` 292.

### 3.2 The safety rules the move carries, all of them

These are the rules of the only automatic path that writes into a person's repository
(`ipc.ts:3184-3187`). They move verbatim and each keeps its test or gains one.

1. **Never merge into a folder that is not a reachable repository.** `gitDir(mergeInto)` first
   (`ipc.ts:3295-3302`); human Gate if absent. Asked before `symbolic-ref`, because the latter fails
   the same way on a missing repo (`ipc.ts:3291-3294`).
2. **Never merge onto a detached HEAD** (`ipc.ts:3303-3312`): covers bisect and rebase, which git
   itself does not block (measured, `ipc.ts:3269-3276`).
3. **Never merge in the middle of another operation**: `rebase-merge`, `rebase-apply`, `BISECT_LOG`,
   `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `MERGE_HEAD` in the real git dir (`ipc.ts:3314-3331`).
4. **Never merge over tracked uncommitted changes**: `status --porcelain --untracked-files=no`
   (`ipc.ts:3347-3360`). Untracked files are allowed because git refuses before touching the tree
   (`ipc.ts:3339-3343`).
5. **Branch per worktree from `git worktree list`**, compared with `isSamePath`; an unknown branch
   goes to an agent, never treated as absent (`ipc.ts:3362-3387`).
6. **No pre-check, no merge**: git older than 2.38 has no `merge-tree --write-tree`, so the work goes
   to an agent (`ipc.ts:3392-3398`).
7. **Probe then merge, one at a time**, because each merge moves HEAD (`ipc.ts:3400-3404`); full refs
   `refs/heads/<b>` against tag shadowing (`ipc.ts:3430`); a probe's stderr separates "conflicts"
   from "could not run" in the agent's spec (`ipc.ts:3432-3449`).
8. **`merge --no-edit`**, because an editor would hold the merge half-done until the 30 s git timeout
   (`ipc.ts:3450-3452`).
9. **On failure: abort, then check that the abort worked, and say so in the Gate**
   (`ipc.ts:3461-3477`).
10. **Uncommitted changes in the source worktrees are counted before merging and reported**
    (`ipc.ts:3416-3428`), because the merge does not carry them and reaping would delete them.
11. **Reap only with `reap`, only app-registered worktrees, only when no held or working session is in
    them; close sessions first and poll for their exit** (`ipc.ts:3207-3245`, `ipc.ts:3248-3258`);
    `removeWorktree` is the one removal function (`ipc.ts:3486-3490`).
12. **Integration Tasks never integrate themselves** (`ipc.ts:3736-3739`), and no second integration
    Task is made for one that already exists (`ipc.ts:3741-3751`).
13. **No merge while a worker works in the Run root** (`ipc.ts:3752-3760`, `integrate.ts:223`).
14. **A worker never runs in the project folder of an app-driven Run** (`command.ts:1758-1766`).

### 3.3 The one rule that is new with a second process

**The Work Unit collector must hear about a Host merge.** The app wraps each merge in
`workUnitCollector.beginGitOperation('job-merge', mergeInto)` so that its git watcher does not record
Astera's own merge as an outside change (`ipc.ts:3453-3480`). With the Host merging, the app cannot
wrap it. An additive broadcast closes this:

```text
host -> clients   { t: 'git-op', op: string, phase: 'begin' | 'end', kind: 'job-merge', cwd: string }
```

The app calls `beginGitOperation`/`endGitOperation` on it. A Host that crashes between the two leaves
an open operation; the app ends every open one when the socket drops, which is the same `finally`
discipline `ipc.ts:3455-3457` states for the in-process case.

### 3.4 Who owns `worktrees.json`

This is the one real two-writer problem in S3. `WorktreeRegistry` holds its list in memory, loads once
and rewrites the whole file on every change (`src/core/worktrees/registry.ts:36-87`). The app loads it
at start (`src/main/core.ts:276-282`). If the Host adds an entry while the app is open, the app's next
write erases it; if the Host adds one while the app is closed, the app loaded before and still erases
it. Being listed is what authorises deletion (`registry.ts:26`), so a lost entry is a worktree nobody
may remove again. D3 has the options; the recommendation is that **the Host owns `worktrees.json`**
and the app's registry becomes a mirror whose `add`, `removeEntry` and `setRoot` are internal
`orch-call`s answered only for `role: 'app'`, the same pattern as `state-put` (`src/host/orch.ts:426-440`).
(amended 2026-09-24, see Amendments A20 and A21: the mechanism needs two more pieces, a `worktree-list`
fill and a `worktrees-state` push, and every write on both sides is read-modify-write)

### 3.5 What the app becomes for worktrees

A client. Its Explorer worktree panel keeps its buttons; they go to the Host. `run-merge` (the detail
view's merge button) already goes through `handleCommand` with `mergeWorktrees`, so it becomes
Host-local with no UI change.
(amended 2026-09-24, see Amendments A24: only the three deps and `--worktree new` move; the
scheduler's own fork, merge and reap stay the app's, in `src/main/ipc.ts`, until S4)

## 4. S4: the dispatch loop

### 4.1 Where it runs and what triggers it

**In the Host**, as a `HostDriver` built beside `createHostOrch` in `src/host/index.ts`. Its body is
`runScheduler` (`ipc.ts:3513-3911`) moved to `src/core/orchestration/exec/dispatchLoop.ts` with its
dependencies injected; the logic is already pure at its core (`slotsToFill`, `tasksMissingAccounts`,
`src/core/orchestration/schedule.ts:58-120`; `unattendedQuestions`, `src/core/orchestration/inbox.ts`;
`pendingMerges` and friends, `integrate.ts`; `reapableChildRuns`, `src/core/orchestration/reap.ts`).
It keeps `orchHandleCommand` as its one door (`ipc.ts:3509-3510`), now the Host's own `handleCommand`
with the Host's deps.

**Triggers, the same set as today, re-homed:**
1. **After every commit the Host makes**: the `setState` inside `depsFor` (`src/host/orch.ts:385-398`)
   and every accepted `state-put` (`orch.ts:463-468`). This is the rule `ipc.ts:3504-3507` gives
   (seven paths make a Task ready; the commit is the only door they share). It also retires F54's
   whole class of bug: the scheduler runs where the commit happens, so no push has to wake it.
2. **At load**, after `store.load` and the pending-report drain (§4.4), the way `ipc.ts:4783` runs it
   at app boot. (amended for S4+S5, see Amendments A39: the Host never loads eagerly; the pass runs
   after whichever load happens, and on the first in-memory state while it drives)
3. **At every ownership change to the Host** (§4.3), after the exit sweep (§2.6).
4. **A 15-second tick** (`ipc.ts:3914`) for `nudgeSleepingCoordinators` (`ipc.ts:4856-4877`, with the
   Host's busy signal from §2.8) and, subject to D2, `orchFireTick` (`ipc.ts:3928-3964`).

The re-entrancy guard, the per-activation `attempted` set and the `finally` (`ipc.ts:3511-3536`,
`ipc.ts:3905-3910`) move with it; they are what stop a failing spawn from spinning.

### 4.2 What the app becomes for dispatch

A display of Host events. It keeps receiving `orch-state`, keeps its commit hook for the sidebar,
the journal and the finished-Run record (`commitHook.ts:31-115`), and its `schedule` dependency
becomes a no-op when the Host announces `dispatch`. The renderer's own commands (`orch.command`:
pause, resume, delete, task-update) still run `handleCommand` in the app and write with `state-put`,
as in S1. Moving them to `orch-call` is S8 and not needed here; the F56 version check keeps them safe
meanwhile.

### 4.3 One owner, and the handover

**The owner is a value the Host computes, not a lease anyone holds.**

```text
driver = 'app'   if a role:'app' client is attached and its hello did not say yields: ['dispatch']
driver = 'host'  otherwise (no app attached, or the attached app yields)
```

The new app says `yields: ['dispatch']` in its `hello` (an additive field, §7). An app that predates
this says nothing, and the Host takes that to mean "this app will dispatch", because it will: its
`runScheduler` runs on every push (`ipc.ts:2483`, `ipc.ts:4006`). (amended for S4+S5, see Amendments
A37: `'app'` when **any** attached app keeps dispatch, and A52: the app keeps yielding to a Host that
announced `dispatch` and stopped answering)

**The handover is synchronous in the Host's event loop.** `driver` is recomputed in the same turn that
the server records a `hello` role (`src/host/server.ts:232`) or removes a closed socket
(`server.ts:342`). The dispatch loop checks `driver === 'host'` on entry and **again before each
slot**. A slot already inside `worker-start` finishes, because a spawn cannot be taken back halfway;
no new slot starts.

**Why nothing dispatches twice even inside that window.** Every door that starts a session commits its
Dispatch before it spawns: `worker-start` (`command.ts:1811-1828`), `startReview` (`ipc.ts:3014-3036`),
repair (`repair.ts:98-`, `openRepairDispatch` first), recovery (`src/main/recovery/execute.ts`,
`openDispatch` first). The app's commit is a `state-put` carrying the version it built on, and the
Host refuses a stale one with 409 before anything is written (`orch.ts:450-461`, ruling F56). So if a
legacy app and the Host both pick the same ready Task in the same instant, one Dispatch commits and the
other side's commit is refused **before its spawn**. The cost is a log line and, on the app side, a
`gateSlot` attempt that `createGate` refuses because the Task now has an open Dispatch
(`ipc.ts:3158-3163`). F56 is therefore the safety net and `driver` is the policy; neither alone is the
design.

**Everything that is a door into starting work follows `driver`**: the dispatch loop, the pending-report
drain, validation, review and repair starts (S5), the resume sweep, coordinator nudges, the
unattended-question net, schedule firing. The exception, stated so it is not mistaken for a leak, is
the recovery reconciler, which stays in the app (D8): it is journal-gated, obeys `hasRoom`
(`reconciler.ts:75-84`) and commits before it spawns.

### 4.4 The pending-report drain moves

The Host already reads the queue at load but does not apply it, because applying reached session
spawning (`orch.ts:352-356`). After S2 it can. So the drain (`ipc.ts:4733-4774`) runs in the Host at
`ready()`, right after `store.load`, under the worker's own session id, with the `writeOff` half
(`ipc.ts:4752-4768`) against the Host's own `heldOnlyByReport` set. The app stops draining when the
Host announces `dispatch`. That also removes the two-process queue read described at
`ipc.ts:2374-2391`. (amended for S4+S5, see Amendments A40: only when the Host drives at its load,
otherwise once at its first handover, and never on the not-migrated to migrated change)

### 4.5 `holdsWork` and the idle exit

A Host started by `astera host start` must stay while a Run is in flight. Track A is making the idle
timer ask `liveCounts` (sessions plus `runningRunCount`, working tree `src/host/index.ts:194-197`),
which is exactly the rule S4 needs. S4 adds nothing here, and deliberately does **not** add Jobs to the
replacement holdings (`hostReplaceDue`, `ipc.ts:551-562`): replacing a Host between two workers is
safe, because the next Host loads the file and continues, and a long-running schedule must not pin an
old Host forever. §8.4 covers the one moment that is not safe.

### 4.6 The always-on migration gate

Ruling F62 pauses work a profile had parked under the old toggle, in the app, once
(`ipc.ts:4652-4670`, `src/core/orchestration/alwaysOn.ts`). A Host that dispatches at load would act
on that parked work before any app has run the migration, which is the exact spend F62 exists to
prevent. So the Host's `driver` has a third value:

```text
driver = 'parked'  if profile/app-settings.json exists and does not carry orchAlwaysOnMigrated: true
```

read only, with the same test the app uses (`appSettingsStore.ts:321-331`; amended for S4+S5, see
Amendments A38: a file that cannot be read or parsed parks too, and the app shows nothing). A profile with no
settings file (a fresh CI profile) was never "off" and is not parked, matching the app's own rule
(ruling F64's correction, ledger line 1282-1288). A parked Host dispatches nothing, drains nothing,
fires nothing, and says so in `status` (§7.4) and in its log, until an app attaches, migrates, and the
Host re-reads the file on that app's next commit. (amended for S4+S5, see Amendments A38: the file is
re-read at every kick and every 15-second tick, not only on a commit)

## 5. S5: validation, convergence, recovery

### 5.1 Recommendation: move validation, review and repair with S4

Once S2 exists, review and repair are wiring: a reviewer is `startWorker` with `worktree: 'current'`
(`ipc.ts:3091-3107`), and repair is `performRepair` over `RepairDeps` whose `startWorker` is the same
wrapper (`ipc.ts:4552-4561`). Validation is the heavier half: it runs a run configuration in a pty.

**Moves:**
- `TaskValidator` (`validator.ts`, 303) and its runner (`ipc.ts:2832-2891`): `prepareRun`
  (`src/main/run/prepare.ts`, 171) and a `RunManager` (`src/main/runManager.ts`, 373) in the Host,
  constructed with the registry's pty factory. Validation runs already carry `validation: true` in
  their note (`runManager.ts:123-128`) and the app's run adopter keeps it (`runManager.ts:206-230`),
  so a Host-run validation appears in the app's run panel through `pty-opened` exactly as a session
  does.
- `onSettled` and `onCannotRun` (`ipc.ts:2892-2945`), `startValidation` with the policy fingerprint
  and suspicious files (`ipc.ts:4441-4484`, `ipc.ts:4011-4044`). (amended for S4+S5, see Amendments
  A46: in the Host the suspicious files fall back to `filesModified`, and A44: the run starts from the
  stripped environment)
- `startReview` and `reviewGate` (`ipc.ts:2953-3133`, `reviewGate.ts` 127), `pickReviewer`
  (`src/core/orchestration/reviewer.ts`).
- `repairTargetFor`, `startRepair`, `repairOnce`, `repairDeps` (`ipc.ts:4516-4534`, `ipc.ts:4552-4561`,
  `repair.ts` 239).
- `resumeSweep` (`resumeSweep.ts`, 56), run by the Host at load and at every change of `driver` to
  `host`, instead of by the app on attach (`ipc.ts:2494`, `ipc.ts:4807`). (amended for S4+S5, see
  Amendments A54: also when a yielding app leaves, after the app's orphaned validation runs are
  killed)
- `knowledgeIn` (`coordinator.ts:284`) comes with the coordinator in S2.

**The path guard.** The runner calls `assertAllowedPath(cwd)` before starting a pty
(`ipc.ts:2848`). The app's guard allows session cwds, registered worktrees and every project the
history index knows (`ipc.ts:5255-5265`). The Host has no history index. Its guard allows: Job cwds
(the `allowingJobCwds` rule, `src/core/run/runConfigsFile.ts:36`), registered worktrees (the Host
owns the registry after S3, D3), and Run worktrees. A Dispatch cwd is always one of these, so the Host
guard is narrower and still sufficient. A cwd outside it is `onCannotRun`, which is a Gate
(`ipc.ts:2845-2847`). (amended for S4+S5, see Amendments A45: the three lists as built, and a broad
Job `cwd` allows its whole subtree)

**The one new message: a person stops a validation run.** The app's run panel stop button marks a
validation run stopped so its exit reads as "could not prove it" rather than a failure
(`ipc.ts:6019`, `validator.ts:53-55`). With the Host validating, the app forwards that as an internal
`orch-call` `validation-stop {runId}` (role app only) and the Host's validator calls `markStopped`
(amended for S4+S5, see Amendments A48: the Host marks and then kills, and the app does not kill it too).
An older Host does not know the command and the stop degrades to today's "exit read as a result".

### 5.2 Recovery stays in the app, on purpose

The reconciler (`reconciler.ts`, 304; `execute.ts`, 277) reads the Continuity journal
(`src/main/continuity/journal.ts`, 508 lines, `node:sqlite`). The journal is written by the app's
commit hook from pushes (`commitHook.ts:62`, ruling F54), so while the app is closed nothing is
journalled, and the reconciler refuses to act on an attempt with no rows (`reconciler.ts:108-122`).
That is the safe direction: no replacement agent is ever started on missing evidence. What it costs:
an attempt lost while the app was closed is never recovered automatically. Moving the journal would
make SQLite a two-process file or make the Host its owner; that is D8. Reversed by A125: the Host
writes the journal.

### 5.3 What the app becomes for validation

A display. It shows Host-run validations in its run panel (adopted `run` ptys) and forwards the stop
button. It no longer owns a validator queue when the Host announces `dispatch`.

### 5.4 The refuse rule, stated precisely, if S4 ships before S5

If D1 goes the other way, S4 ships with this rule and S5 follows:

> **R-S5.** When the Host would call `startValidation`, `startReview` or `startRepair` and no attached
> app has announced that it will run them, the Host does not drop the call. In the same turn it
> commits a Gate on the Task through the existing transitions: `blockForValidation`
> (`ipc.ts:2939`) for a validation, the `reviewGate.gate` rule (`ipc.ts:2966`) for a review, and the
> `repairFailed` Gate the pure layer already opens when `repairTargetFor` answers `null` (F58) for a
> repair. The Gate's question names the reason: "This Task's checks run in the Astera app, which is
> not open. Open Astera and resolve this Gate to validate it." The Task moves to `blocked`, so no
> dependent becomes `ready` and the Run does not complete. `runs wait` ends `waiting` with the Gate's
> id (`command.ts:484-494`), which the CLI maps to exit 8. When an app that runs validation is
> attached, the three calls are forwarded as today.

This rule never lets a validation-bearing Task read as validated, never spends a turn on a Task whose
result cannot be judged, and ends the wait instead of holding it for an hour. Its cost is that CI Jobs
with `--validate` or convergence never complete headless until S5 ships.

## 6. S6: rolling and usage limits

(amended for S6, see Amendments A67: S6 shipped, and this section was wrong in four places; and A68,
which replaces D7's Gate)

**Not needed for the goal, and it should follow later.** It is the largest slice by far:
`src/main/rolling.ts` 2,273 lines, `src/main/codexRolling.ts` 1,704, `rollTap.ts` 359, the
coordinator wiring in `src/main/index.ts:572-1040` (about 470 lines), `codexRolloutWatcher.ts` 400.
None of it is needed to dispatch, run, merge or validate.

**What happens to a worker that hits a limit while the app is closed.** Measured by reading, not by
running:
1. The agent CLI shows its limit message and stops taking turns. The pty stays alive.
2. The Dispatch stays open and the Task stays `dispatched`. Nothing is closed, so nothing is
   misread as a failure, and the circuit breaker does not move.
3. `runs wait` keeps waiting, because `outcomeOf` is still `running`, until its timeout.
4. When an app opens, the adopter registers the session with its rolling coordinator from
   `rollAccountIds` (`ipc.ts:7164-7189`), which detects the stall and rolls or nudges as it does for
   any session.

That is a stall, not a corruption. What is worth adding in S4 without S6 is making the stall visible
(D7): the Host already runs the limit probe locally after S2, and can open a Gate "the worker hit its
usage limit; it resets at <time>; open Astera to roll it to another account" when a worker's
statusline shows a limit and no app is attached. `runs wait` then ends `waiting` with a reason instead
of timing out. (D7 left out of S4+S5 by the user; S6. See Amendments A58. Replaced in S6 by the
`limited` ending, see Amendments A68)

## 7. Protocol

### 7.1 Stays 3

Every change below is a new feature name, a new optional field or a new message type, which is the
pattern `HOST_FEATURE_PROC`, `_PING`, `_ORCH`, `_REQUESTS` already follow
(`src/core/host/protocol.ts:15-53`). A bump puts the new app on a new pipe name and leaves an old
Host's terminals invisible to it (`protocol.ts:17-20`), and every running worker would die with that
Host. No change here needs a bump:
- an older app ignores unknown message types (subscribers filter on `m.t`);
- an older Host logs unknown messages and carries on (`src/host/server.ts:329`);
- an older Host that does not announce a feature is never asked for it.

### 7.2 Additions

| Slice | Addition | Direction |
|---|---|---|
| S2 | feature `spawn` | Host hello |
| S2 | `{ t: 'pty-opened', entry: PtyEntry }` | Host to all greeted clients |
| S2 | env `ASTERA_HOST_CLI_EXEC`, `ASTERA_HOST_CLI_ENTRY`, `ASTERA_HOST_SKILLS` | spawner to Host (not the wire) |
| S3 | feature `worktrees` | Host hello |
| S3 | `{ t: 'git-op', op, phase, kind, cwd }` | Host to all greeted clients |
| S3 | internal `orch-call` `worktree-add`, `worktree-remove`, `worktree-root` (D3 option A) | app to Host, role app only |
| S4 | feature `dispatch` | Host hello |
| S4 | `hello.yields?: string[]` (`['dispatch']`) | app to Host |
| S4 | `status` body gains `driver: 'host' \| 'app' \| 'parked'` and `appAttached: boolean` (only from a Host that announces `dispatch`, Amendments A42) | orch-result |
| S5 | internal `orch-call` `validation-stop` | app to Host, role app only |
| chat takeover | feature `chat-takeover` | Host hello |
| chat takeover | `hello.yields` value `chat-takeover` | app to Host |
| chat takeover | `session-rolled` gains `procId?: string` | Host to all greeted clients |
| chat takeover | internal `orch-act` `chatPrompts`, `chatAnswer` (`HOST_CHATS`) | Host to app, role app only |
| chat takeover | note keys `unattendedPermission`, `chosenModel`, `carryOn`, `carrySent`, `hostStarting` | proc note (not the wire) |
| Slack in the Host | feature `slack-owner` | Host hello |
| Slack in the Host | `hello.yields` value `slack` | app to Host |
| Slack in the Host | `{ t: 'slack-event'; event: SlackForwardedEvent }` | app to Host, role app only |
| Slack in the Host | internal `orch-call` `slack-reload` | app to Host, role app only |
| Slack in the Host | internal `orch-act` `slackChatAnswer` (`HOST_ACT_SLACK_ANSWER`) | Host to app, role app only |
| Slack in the Host | note keys `slackThreadTs`, `slackChannel` | session/proc note (not the wire) |
| Host journal | feature `journal` | Host hello |
| Host journal | `hello.yields` value `journal` | app to Host |
| Host journal | internal `orch-call` `journal-append`, `journal-reload` | app to Host, role app only |
| Host journal | `runs-follow` answer gains `JobEvent`s of the kinds `runtime-lost` and `recovery` (optional `OrchServerDeps.journalTimeline`) | orch-result |

(amended 2026-09-24, see Amendments A20: the S3 rows are not the whole mechanism; an internal
`orch-call` `worktree-list` (app to Host, role app only) and a push `{ t: 'worktrees-state', seq, file
}` (Host to all greeted clients) are additive too)

(amended for S6, see Amendments A71: the S6 additions, none of which bumps the protocol)

(amended for the chat takeover, see Amendments A93: the feature, the yield, `procId`, the two `orch-act`s
and the note keys above, none of which bumps the protocol)

(amended for Slack in the Host, see Amendments A103: the feature, the yield, `slack-event`, `slack-reload`,
`slackChatAnswer` and the note keys above, none of which bumps the protocol)

(amended for the Host journal, see Amendments A134: the feature, the yield, the two calls and the optional
dependency above, none of which bumps the protocol)

### 7.3 Version skew

| App | Host | What happens |
|---|---|---|
| new | new | The Host spawns, owns worktrees, drives. The app yields, adopts, displays. |
| new | old (no `spawn`/`dispatch`) | The app keeps today's code path: its own spawn, worktrees, loop, validator. **This is why the app's copies are kept, not deleted, in S2 to S5**: the shared `exec/` modules make that a second construction, not a second implementation. The automatic replacement (`hostReplaceDue`) swaps the old Host the first time it holds nothing. |
| old | new | The old app sends no `yields`, so `driver = 'app'`: the Host parks its loop and every other door into starting work while that app is attached, and the old app dispatches as today. Host-local spawns for commands the Host answers (a coordinator's `worker-start`) still happen in the Host; the old app ignores `pty-opened` and adopts them at its next reattach sweep (amended 2026-09-24, see Amendments A18: its Stop button before that sweep; and A22: an old app keeps its own worktree work too, because it never says `yields: ['worktrees']`). When the old app detaches, `driver` becomes `host` and the handover sweep runs. |
| old | old | Today. |

One subtle case in row 3: the old app also handles exits (it is attached, §2.6; amended 2026-09-24,
see Amendments A1: only of the ptys it spawned or attached), runs its own resume
sweep, and may validate a Task the Host started validating a moment earlier. `TaskValidator` answers
`skip` for a Task that has left `validating` (`ipc.ts:2842`), and a second result for the same round is
refused by `applyValidationResult`. The waste is one duplicate run; nothing is recorded twice.

### 7.4 A CLI talking to a Host without `dispatch`

`jobs run` still succeeds (the state transition is the Host's since S1), but with no driver it would
wait forever. Until S4 ships, `jobs run` with no app attached and no `dispatch` feature adds a
`details.note` and `nextSteps` saying workers start when Astera is open (the audit's interim proposal,
`cli-spec-audit.md:140`). After S4, `status.driver` tells a script which case it is in. (amended for
S4+S5, see Amendments A42: moot for a Host that announces `dispatch`; the interim note was not built)

## 8. Failure modes

### 8.1 The Host crashes mid-dispatch

| Moment | On disk | Next Host's `store.load` | Result |
|---|---|---|---|
| after `openDispatch` commit, before the pty opens | Dispatch open, `sessionId: pending:…` (`command.ts:1811`) | not alive, so `outcome_unknown` (`src/core/orchestration/store.ts:310-318`) | Task left `dispatched` with a lost attempt. D6. |
| pty open, real session id not yet committed | same | same | same; the pty is expected to die with the Host (to be measured in S2, §9.1; amended 2026-09-24, see Amendments A15: measured, it dies) |
| worker running | Dispatch open with the real id | `outcome_unknown` unless a queued report speaks for it (`store.ts:316`) | a worker that finished and could not reach the Host wrote its report to the queue; the drain applies it (§4.4) |
| inside `integrateWorktrees`, between `merge` and its abort | the repo may be mid-merge | nothing | the next merge attempt meets `MERGE_HEAD` and opens a human Gate (`ipc.ts:3314-3331`). The repo is never merged over. |
| inside `worker-start` after spawn, before the patch commit | spec file written, session gone | spec swept at load (§2.7) | clean |

A caller holding `runs wait` sees its socket drop and exits 3 (design §8 table). Nothing is killed by
PID (S1 rule).

### 8.2 The app opens while the Host is dispatching

1. `hello` with `yields: ['dispatch']`: `driver` stays `host`. Nothing changes hands.
2. `state-get {boot: true}` fills the mirror (`ipc.ts:2432-2462`). The Host's load findings go to the
   first app as before.
3. The reattach sweep adopts every live session, including workers the Host spawned while no app was
   open; a worker spawned during the sweep arrives as `pty-opened` and meets `heldLive`.
4. The app does **not** run at boot: `runScheduler` (`ipc.ts:4783`), the drain (`ipc.ts:4733`), the
   resume sweep (`ipc.ts:4807`), the spec sweep (`ipc.ts:2562`). It still runs the F62 migration
   (`ipc.ts:4652`) and `recovery.reconcileAll` (`ipc.ts:4793`).
5. Exit handling passes to the app (§2.6; amended 2026-09-24, see Amendments A1 and A3: only for
   the ptys it attaches). Any exit the Host deferred and has not handled yet is
   handled by whichever side's timer fires; `handleExit` on an already closed Dispatch is a no-op
   (`rollTap.ts:9-10`), so the overlap is harmless.

### 8.3 Two apps

The single-instance lock allows one app per profile, and the dev and installed apps use different
profiles, so different Hosts (`src/main/index.ts:68`). The Host does not enforce it: it takes the first
`role: 'app'` socket (`server.ts:164-167`), and S1 recorded a second one as "two mirrors and two
writers on top of F56" (ledger line 178-180). With S4 a second app matters more, because it decides
`driver`. **Recommendation (D9): the Host refuses a second `role: 'app'` hello while one is attached**,
answering it as a CLI and logging it. The refused app sees no `orch-act` and no `features` it can drive
with, so it degrades to the S1 "unreachable" state rather than splitting ownership.

### 8.4 The Host is upgraded while workers run

The Host outlives an app update by design. The prepared runtime is versioned per build
(`scripts/host-runtime.mjs:32`, `:122`), so the old Host keeps running its own `host.js`.
- **Old Host is pre-S4, new app arrives.** Row 2 of §7.3. The new app drives until the old Host holds
  nothing and is replaced.
- **Old Host is S4, newer app arrives.** The newer app yields, and the old Host drives with its own
  code. That is correct as long as the state schema is forward-readable, which `migrateLoadedState`
  already requires (`store.ts:290`).
- **Replacement mid-spawn.** The one unsafe moment: `hostReplaceDue` sees zero sessions while a
  `worker-start` has committed its Dispatch and not yet opened the pty. The app retires the Host with
  `reason: 'protocol'`, which is never refused (`protocol.ts:106-115`). **Rule: the Host's retire
  handler waits for spawns in flight to settle, bounded by the spawn deadline (20 s,
  `ptyFactory.ts:45`), before leaving**, and does not start new ones once retire has arrived.
  (amended 2026-09-24, see Amendments A14: the refusal is a 409 with `retry`, new connections are
  dropped, and `host stop` waits 35 s)
- **Workers spawned by the old Host run the new CLI.** Their `ASTERA_CLI` names the profile's shuttle,
  which the new app rewrites at boot (`ipc.ts:4679`) to the new `cli.js`. The CLI's messages are
  additive, so an old Host answers them.

### 8.5 The Host cannot spawn

Missing `ASTERA_HOST_CLI_*` or a half-deleted node-pty (`src/host/index.ts:80-84`): `startWorker`
throws, `worker-start` rolls its Dispatch back and restores the Task (`command.ts:1861-`), and the
dispatch loop's `gateSlot` opens a Gate with the reason (`ipc.ts:3149-3167`), so `runs wait` ends
`waiting` with a sentence rather than hanging.

## 9. Tests and verification per slice

All bug-fix tests in these slices follow the standing rule: shown failing on the commit before the fix
(memory: fix tests must fail on the pre-fix commit).

### 9.1 S2

**Pure.** The strip list over a Host env. `startWorkerWithChain` with a fake context, both processes'
construction of it. `ensureFiles` never removes the hook events folder. The Host path guard.
The exit owner rule as a function of `(appAttached, exitCode)`. (amended 2026-09-24, see Amendments
A1 and A13: the rule is a function of `(kind, heldByApp)`, and S2 has no Host path guard)

**Host in process** (the rig style of `src/host/orch.test.ts` and `procHost.integration.test.ts`).
A fake registry: `worker-start` with no app attached spawns locally, writes a note equal to
`SessionManager.spawn`'s, broadcasts `pty-opened`, starts a tail that `worker-read` answers. A pty exit
with no app attached closes the Dispatch after the defer; with an app attached it does not. (amended
2026-09-24, see Amendments A1: with an app attached, the Host still closes it when no app holds the pty) The
handover sweep closes a Dispatch whose session died in the gap. A codex spawn writes the rollout
mapping into the note.

**App in process.** `pty-opened` goes through the reattach adopter; a `pty-opened` arriving during a
sweep does not double-adopt (`heldLive`).

**Hand run with the dev app** (memory: CDP verification procedure, process isolation, `ASTERA_*`
cleared first). App open: a coordinator's `worker-start` from a shell makes a tab appear, seen on
screen (memory: verify on screen). App closed: the same command spawns, `sessions list` shows it, the
next app launch shows its tab. **Measure** what happens to a Host-spawned worker when the Host process
is ended (only the Host PID we started): does the agent process die with the ConPTY? §8.1 assumes it
does. (amended 2026-09-24, see Amendments A15: measured, it does)

### 9.2 S3

**Pure and git.** Every rule in §3.2 against temporary repos (`src/core/worktrees/testRepo.ts` exists
for this): detached HEAD, each marker file, tracked dirt, untracked file allowed, unknown branch, old
git, probe conflict versus probe failure, merge failure with a verified abort, uncommitted count.
These tests exist in spirit today only as comments ("이 자리에는 테스트가 없다", `ipc.ts:3269`); the
move is the moment to add them, because the function stops living in an untestable closure.

**Registry ownership.** A Host `add` while the app mirror holds an older list: the app's next write
does not drop the Host's entry (the D3 test that fails on today's code).

**Hand run.** App closed: a concurrency-2 Job's two Tasks run in their own worktrees and are merged
into the Run worktree; `git log` shows both merges; the worktrees are gone from disk and from
`worktrees.json`. App open during a merge: the Work Unit screen does not record an outside change.

### 9.3 S4 and S5

**Pure.** `driver` as a function of `(attached apps, yields, settings file)`, all combinations,
including `parked`. The retire-waits-for-spawns rule.

**Two-process rig** (the F54 rig's shape, `commitHook.test.ts`: the real `handleCommand` on one side,
the real loop on the other). The Host drives a two-Task chain to `completed` with no app. A legacy app
(no `yields`) attaches mid-run: the Host starts no new slot; the app's `worker-start` for a Task the
Host already opened is refused by the version check before spawning; the list of spawns equals the
number of Tasks. Validation pass, validation fail with repair, review with a second provider, all
headless. R-S5 (if D1 is option B): the wait ends `waiting` with the Gate.

**The end-to-end hand run: the app closed, a scratch profile, one real Claude turn at most.**

Setup, once:
1. `npx electron-vite build`. Clear every `ASTERA_*` variable in the shell (memory: the CLI is hijacked
   by `ASTERA_INFO`-era variables of the installed app's sessions).
2. `ASTERA_PROFILE_DIR=<scratchpad>\e2e\profile`, a fresh folder. Never `%APPDATA%\astera` or
   `-dev`, never delete `%LOCALAPPDATA%\astera` (memory).
3. A scratch git repo with one commit and a `package.json` whose `test` script is
   `node -e "process.exit(0)"`, so `seed:npm:test` is a run configuration.
4. **Fake agent first, zero turns.** A `claude.cmd` placed first on the Host's PATH. The worker is
   launched as `cmd.exe /c claude …` (`src/core/sessions/commands.ts:44-47`), so it resolves to the
   fake. The fake reads the spec path out of its last argument, creates the file the spec names,
   commits, and runs the `astera send` line the spec's report section gives it. `accounts.json` in the
   scratch profile names a fake account.

Run, fake agent:
1. `astera host start`; `astera status` shows `driver: host`, `appAttached: false`.
2. `astera jobs create --cwd <repo> --objective "e2e"`; two `tasks add`, the second depending on the
   first, the first with `--validate seed:npm:test`; `--concurrency 2` for the merge path.
3. `astera jobs run --id <job>`; `astera runs wait --id <run> --timeout 10m`. Expect exit 0,
   `completed`.
4. Check: both commits merged into the Run worktree; worktrees reaped; Host log shows one
   `worker-start` per Task and one validation run; no Electron process with our profile (by the PIDs we
   launched, never by name).
5. Variants: a failing `test` script (repair then `convergence-exhausted` Gate, wait ends `waiting`);
   Host killed mid-worker then restarted (D6's behaviour); app opened mid-run with the dev app on a
   debug port, tab seen on screen, closed with a normal quit (memory: a force kill hides quit bugs),
   Job continues; an old app build from a worktree attached mid-run (memory: remove the node_modules
   junction before `worktree remove`).

Run, one real turn: the same Job with one Task, a real Claude account's configDir in the scratch
`accounts.json` (with the user's approval, as in phase E3; credentials never read), spec "create
hello.txt containing hi and commit it". Expect `completed`. This is the only real turn.

## 10. Decisions that need the user

Each changes the design. Recommendation first.

**D1. How the S5 trap is resolved.**
- (a) **S5 moves with S4 in one merge** (validation, review, repair; recovery stays per D8).
  Recommended: CI Jobs with checks complete headless on the first release that has the goal.
- (b) S4 ships first with R-S5 (§5.4), S5 follows. Smaller first merge; `--validate` Jobs end
  `waiting` headless until S5.

**D2. Scheduled Jobs with the app closed.**
- (a) **Fire only while an app is attached, as today.** Recommended: no new unattended spending in
  this slice; the Host's idle exit would make headless firing erratic anyway.
- (b) Fire whenever the Host is up, without keeping it up.
- (c) Fire whenever the Host is up, and count an armed schedule as held so the Host stays up.

**D3. Who owns `worktrees.json`.**
- (a) **The Host owns it; the app's registry is a mirror and writes through the Host.** Recommended:
  one writer, as S1 did for the state.
- (b) The Host keeps its own `host-worktrees.json`; the app lists and authorises the union.
- (c) The Host writes the file only when no app is attached and forwards otherwise; the app reloads on
  attach. Smallest, and racy at the moment an app opens.

**D4. The environment a Host-spawned worker inherits.**
- (a) **The Host's own env minus the strip list**, documented: a Host started from a CI shell passes
  that shell's env (secrets included) to workers, as a person starting the app from that shell would.
  Recommended.
- (b) The spawner records the app's env when the app starts the Host, and the CLI's `host start`
  records its own; both identical in practice, only more explicit.
- (c) Workers get a minimal allowlisted env. Safer, and a behaviour change for app-open Jobs too.

**D5. New app, old Host that is holding work.**
- (a) **The app keeps today's loop for that Host until it is replaced.** Recommended: nothing strands.
- (b) The app refuses to dispatch against an old Host and asks for a Host restart.

**D6. A worker lost to a Host restart, with no journal to recover it.**
- (a) **At load, open a Gate on each such Task** ("the worker was lost when the Host stopped"), using
  the `dispatched -> blocked` edge recovery added. Recommended: `runs wait` ends instead of hanging.
- (b) Leave the Task `dispatched` as today; a person or a coordinator retries.

**D7. A worker at its usage limit with no app attached.** (left out of S4+S5 by the user; S6, see
Amendments A58)
- (a) **The Host opens a Gate naming the reset time** when its local limit probe sees a limit and no
  app is attached; `runs wait` ends `waiting`. Recommended.
- (b) Stall silently until an app opens or the wait times out.
- (c) An S6-lite in the Host: after the reset time, type the roll prompt into single-account chains.

**D8. Continuity journal and the recovery reconciler.**
- (a) **Stay in the app.** Recommended: journal-gated, so absent rows mean no action.
- (b) The Host owns the journal (SQLite single writer moves), and the reconciler moves in S5.

**D9. A second app on one profile.**
- (a) **The Host refuses a second `role: 'app'` hello while one is attached.** Recommended.
- (b) Leave it as S1 recorded it.

**D10. Release shape.**
- (a) **S2 and S3 merge to `develop` separately; S4 and S5 release together.** Recommended.
- (b) One release for all four.

**D11. `jobs run` with no Host running.**
- (a) **Keep it exit 3 with `astera host start` in `nextSteps`**, and put `host start` first in the CI
  recipe. Recommended: the S1 decision made `host start` the explicit way in.
- (b) `jobs run` starts the Host itself.

**D12. Permission mode for a profile with no `app-settings.json`.**
- (a) **`yolo`, the store's own default** (`appSettingsStore.ts:118`). Recommended: `manual` stops a
  headless worker at its first command with nobody to answer.
- (b) `manual` when the settings file is absent.

## 11. Size and risk per slice

Estimates from the measured sources above. "Moved" is lines relocated with no logic change; "changed"
is new or edited lines, tests included.

| Slice | Files touched | Moved | Changed | Where the risk sits |
|---|---|---|---|---|
| S2 | about 22: `src/host/{index,orch,orchDeps,ptyHost,server}.ts`, new `src/host/spawner.ts`, new `src/host/exits.ts`, `src/core/host/{protocol,spawn}.ts`, new `src/core/orchestration/exec/*` (coordinator, tail, release, limitProbe, workerStart), `src/main/statusline.ts`, `src/main/ipc.ts`, `src/main/host/reattach.ts`, `src/cli/host.ts`, tests | about 1,700 (coordinator 954, statusline 390, limitProbe 154, tail 124, release 32, wrapper bodies about 180) | about 1,500 (900 of it tests) | **Environment parity** between the two spawners (a worker behaving differently by who spawned it); the statusline init split; the Windows ConPTY outcome when the Host dies (unmeasured; amended 2026-09-24, see Amendments A15); `pty-opened` versus the sweep. |
| S3 | about 10: `src/host/*`, new `src/core/orchestration/exec/integrateGit.ts`, `src/core/worktrees/registry.ts`, `src/main/ipc.ts`, `src/main/core.ts`, protocol, tests | about 450 (`ipc.ts:2634-2657`, `3169-3502`, `4088-4124`) | about 900 (600 tests) | **The user's repository**: this is the only automatic writer into it, and the move is also the first time its rules get tests. The registry ownership change touches the Explorer panel. |
| S4 + S5 | about 18: new `src/core/orchestration/exec/{dispatchLoop,validation,review}.ts`, moved `validator`, `repair`, `reviewGate`, `resumeSweep`, `prepare`, `runManager`, `src/host/{index,orch,orchDeps,server}.ts`, `src/main/ipc.ts`, `src/main/orchestration/commitHook.ts`, `src/core/orchestration/command.ts` (status fields only), `docs/cli.md`, tests | about 2,100 (loop 408, gateSlot 33, fire and nudge 83, drain about 60, validator wiring 126, review 184, startValidation 80, repair wiring 30, and the modules: validator 303, repair 239, reviewGate 127, resumeSweep 56, prepare 171, runManager 373) | about 1,800 (1,000 tests) | **The handover**: `driver` changes, the legacy-app window, F62's gate, and the S1 invariant that `handleCommand` is untouched (it stays untouched; only its deps move). Validation's run panel via adopted `run` ptys and the narrower Host path guard. |
| S6 (later) | about 12 | about 4,800 (rolling 2,273, codexRolling 1,704, rollTap 359, watcher 400, index.ts wiring about 470) | unknown until designed | Rolling has been this app's most bug-dense axis (`src/core/rolling/retry.ts` header, cited at `rollTap.ts:17-20`). Not attempted here. |

**The largest single risk across all of it** is the transition period in which both processes can run
the same code for different callers. It is bounded three ways: the shared `exec/` modules (one literal
each), the `driver` value (one policy), and F56's version check (one safety net that refuses a
competing commit before its spawn). Each of the three is testable on its own, and §9.3's two-process
rig tests them together.
