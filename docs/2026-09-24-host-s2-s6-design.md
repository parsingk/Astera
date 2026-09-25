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
| D2 | Scheduled Jobs with the app closed | Fire only while an app is attached, as today | user |
| D3 | Owner of `worktrees.json` | The Host; the app writes through it | controller, the draft's recommendation |
| D4 | Worker environment | The Host's own environment minus a documented strip list | user |
| D5 | New app, old Host holding work | The app keeps today's loop until that Host is replaced | controller |
| D6 | A worker lost to a Host restart with no journal | Open a Gate at load | controller |
| D7 | A usage limit with no app | A Gate carrying the reset time, so `runs wait` ends with 8 (left out of S4+S5 by the user; S6, see Amendments A58; replaced in S6 by the `limited` ending with no Gate, see Amendments A68; the coordinator's own wait counts too, see Amendments A74) | controller |
| D8 | Journal and reconciler | Stay in the app | controller |
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
- **A19. No `PROMPT_WRITE_*` journal rows for Host-spawned workers (plan ruling R9).** The journal
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
  `src/core/orchestration/exec/dispatchLoop.test.ts`.
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
  conhost per self-exiting pty, which grows with long-lived headless Hosts. A19 (no `PROMPT_WRITE_*`
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
  answer is the earliest reset among them. A `ready` Task no longer holds `limited` back in a
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
  to post into), a `total`, and `limited: [{ sessionId, seq }]` for every chain with a `waiting`,
  `switching` or `rolled` entry, live or not (the desktop count; a stall alone does not count). New
  `SlackNotifier.announceOffline(sessionId, text)` (`src/main/slack.ts`) posts once into that session's
  thread, answers `false` when the session has no Slack record, and rejects, rather than swallowing,
  a failed post or a not-yet-ready transport, so the caller knows not to ack; a new
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
  itself, since a roll link alone is not evidence of an account switch. Pinned by
  `src/main/host/rollJournalSummary.test.ts`, `src/main/slack.test.ts`, `src/main/desktopNotifier.test.ts`,
  `src/main/host/offlineRolls.test.ts` and `src/main/host/outdated.test.ts`.

## Known limits after S3

- **`refresh()` does not retry a Windows rename-busy read.** (resolved in S4+S5, see Amendments A60)
  `WorktreeRegistry.refresh()` reads through
  `readForWrite()`, a plain `fs.readFile`; the rename-busy retry only guards `save()`'s write path. A
  read racing a rename can hit a transient sharing violation, which `refresh()` surfaces as a rejection
  rather than riding out. Safe, because nothing is wiped, but the app's mirror stays stale until the
  next local write or refill (task-9-report.md).
- **A registry write during a Host replacement window fails rather than falling back to local.** For
  about `RETIRE_SETTLE_MS` (2s) around a Host's `retire({announce:true})` → `stop()` → `restart()`, the
  app's write-through route still reads `mode: 'host'`, so a write in that window answers "there is no
  connection to the Host" instead of writing the file itself. Nothing is lost silently; the caller sees
  the error (task-9-report.md, M1).
- **One `conhost.exe` leaks per pty that exits on its own.** node-pty 1.1.0 closes the pseudo console
  only when a live pty is killed (A17). S3 makes Hosts that live long with the app closed more common,
  and so this leak more common with them, but does not change the underlying behaviour.
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
- **A parked Host is silent in the app.** The app yields to any Host that announces `dispatch`, parked
  or not, so while the Host is parked nothing dispatches, and nothing in the app says why (A38). A
  settings file damaged while the app runs parks the Host until Astera restarts and repairs it.
- **A hung Host that keeps its pipe open stops every Job.** The app keeps yielding to it (A52). Jobs do
  not move until it answers, dies, or is restarted from Settings, Info. The status bar shows that the
  Host is not answering; the Jobs sidebar does not say why nothing moves.
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
  instance. If it reconnects within the grace, the steps run at that attach, at once and beside it;
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
  `src/host/mergeRecords.ts:64`). A busy project can push another's records out, and a HEAD move that
  only a dropped record explained then reads as an outside change (Task 3 review m2).
- **A broad Job `cwd` allows its whole subtree to the path guard** (A45,
  `src/core/run/hostPathGuard.ts:20-21`). A Job whose `cwd` is a drive root lets a validation or review
  run anywhere below it (Task 9 review m4).
- **A worktree removal already in flight when the drive moves still finishes.** The loop asks
  `mayStart` before each removal (`driving.ts:191-197`), but one already started goes on. It asks the
  attached app first, two removals of one folder make one of them fail, and a removal never throws
  (Task 12 review m2).
- **Carried from S3, unchanged:** the ~2 s replacement window for the app's worktree writes, the conhost
  per self-exiting pty (A17), and a pre-S3 app that writes no `app.pid` (A63).

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
- **Chat sessions are not taken over.** They are line processes whose protocol adapter lives in the
  app, so with the app gone nothing can drive a turn (plan R20).
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
- **A missing `app.pid` makes a live app look gone** (preflight R11). `markAppRunning` swallows a failed
  write, so a live app whose socket stays down past the 5 s grace is judged gone, and its sessions are
  taken. That is safe because the drop already disposed its chains (A69, preflight R10); the chain in the
  next entry is the exception.
- **A chain that was mid-roll when its app's socket dropped is not disposed by the drop** (preflight
  R10). It finishes its roll inside the app. If the Host then owns the pty, the adopter's unregister belt
  drops that chain when the app returns (A69, preflight R11).
- **A role-less older app (v1.3.17 to v1.3.25) counts as `cli`** (preflight C17), so `hasApp()` is false
  while it is attached and a takeover can run beside it. The holders check protects every pty it has
  attached; a pty it is about to attach, with its `pty-list` answer still in flight, is not protected.
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
  and cannot roll (preflight R6, the Task 6 review). Only a blank-slate respawn records
  `locateSince`.
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
  chain stays unmapped.

**The app beside a Host that rolls**

- **A rekey is forwarded to the renderer even when adopting the new pty failed.** The renderer catches
  up at the next sweep.
- **A history resume that misses the app's local indexes while the Host rolls costs one `pty-list`
  round trip**, up to 5 s (`hostNativeGuard.ts`).
- **The app holds the old session's exit for up to 15 s** until its orchestration mirror shows the rekey
  (`HOST_ROLL_SETTLE_MS`). After 15 s it delivers the exit anyway.
- **The ordering hold's wiring in `ipc.ts` is not pinned by a test.** The `withHostRollHold` wrapper is
  tested alone; the swap that puts it in front of the exit handler needs a `registerIpc` harness (the
  Task 14 re-review).

**`runs wait` and the usage lookup**

- **A coordinator's own wait is not a `limited` ending.** (resolved in the S6 limits follow-up, see
  Amendments A74: the coordinator's stop now counts, on the Run's `coordinatorStop`) The rule looked at
  open Dispatches only, and a coordinator is a Run's slot, not a Dispatch, so such a Run waited to its
  deadline (7).
- **`runs wait` ends `limited` only when no Task of the Run is ready to start and no check is running.**
  The reset it names is the earliest among the waiting workers (A68), and, since A74, among the
  coordinator's own stop too; a ready Task no longer holds `limited` back in a Run a coordinator drives,
  since only that stopped coordinator can start it.
- **The Host's usage lookup goes without the system proxy and the OS certificate store.** Node's
  `fetch` honours neither by default, so behind a corporate proxy the lookup fails, and a failed lookup
  accepts the limit (Q4): detection is kept, and the brake against a false roll is weaker, as in the app
  when its lookup fails.
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
  never the respawn underneath one.
- **The coordinator's stale-stop rule is ten minutes, and covers only the coordinator.** (Amendments A74)
  A coordinator's stop is ignored by `limitedUntil` once its `resetsAt` is more than
  `STALE_COORDINATOR_STOP_MS` (10 minutes) in the past, so a missed clear cannot leave every wait on that
  Run ending `limited` forever. A worker Dispatch's own stop carries no such staleness check, unchanged
  from A68.
- **A person can still start a ready Task by hand while its Run is `limited`.** (Amendments A74) `limited`
  means nothing moves on its own before the reset, not that nothing can: the same as `waiting` and
  `paused`, a person may start a ready Task from RunDetail or `worker-start`, and that does not end the
  `limited` state early or contradict it.

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
make SQLite a two-process file or make the Host its owner; that is D8.

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

(amended 2026-09-24, see Amendments A20: the S3 rows are not the whole mechanism; an internal
`orch-call` `worktree-list` (app to Host, role app only) and a push `{ t: 'worktrees-state', seq, file
}` (Host to all greeted clients) are additive too)

(amended for S6, see Amendments A71: the S6 additions, none of which bumps the protocol)

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
