# The Host as Astera's control plane

The design for `ASTERA_PUBLIC_HEADLESS_CLI_IMPLEMENTATION_SPEC_20260919.md` §4: the public CLI talks
to the Persistent Host, not to Electron main, so that Astera is controllable from a shell without the
Desktop UI ever being opened.

Written 2026-09-22, against `develop` at `bb30c4a`, after the CLI's contract, read surface, human
output, installation and guide had landed against the **old** target — main's loopback HTTP server.
That work is not wasted: the command layer it was built on is transport-agnostic, which is what makes
this move affordable. What changes is where the commands run and what they talk to.

## 1. The goal, and the two decisions that shaped it

The stated goal: state queries, message sending, and running or stopping a Job, all from the CLI with
the Desktop UI never opened — and `astera host start` included, so the CLI is complete on its own.

Two decisions were taken before the design, and everything below follows from them.

**The Host owns execution, not just state.** The alternative considered and rejected was running the
existing app without a window and letting the CLI start it. That is much smaller — `registerIpc`
touches `win` in ten places and nine of them are the title-bar buttons — and it satisfies every
*reason* §4 gives. It was rejected because the stated end state is the spec's §58: the Host owns
durable execution, and the app is one client of it. This design takes that literally.

**`astera host start` is in scope.** That is what makes the app never required. It also means the
Host's absence is the CLI's problem to solve rather than a message it prints.

## 2. This is not one slice

Moving the orchestrator between processes is six pieces plus two that run alongside. The order is
fixed by dependency, not preference.

| | What moves | Size, measured | What it opens |
|---|---|---|---|
| S1 | State ownership, the control API, `host start` | store 444 lines; server's 2435 unchanged | status queries and message sending with no UI |
| S2 | Session spawn: accounts and session assembly | registry 232, manager 489, plus cliEnv | `worker-start`, and stopping, with no app |
| S3 | Worktrees | integrate 292 | worktree-backed Jobs with no app |
| S4 | The dispatch loop | small: `slotsToFill` is already pure | **Jobs advance with no app** |
| S5 | Validation, convergence, recovery | validator 303, repair 239, reconciler | no behaviour split between app up and down |
| S6 | Rolling and usage limits | rollTap 359, limitProbe 154 | limit recovery with no app |
| S7 | Host lifecycle and version skew | — | `host status`/`stop`, update skew |
| S8 | The app as a pure client | — | window optional |

S7 is not a late step: its `host start` half lands with S1, because once the Host owns the state
nothing works without it. The rest of S7 follows.

**S5 carries a trap.** Deferring it means the same Job runs differently depending on whether the app
happens to be open: workers run, but nothing validates and no repair fires. A silent difference, read
by a person as "validation passed". Before S4 ships, either validation-bearing Tasks refuse to advance
with no app attached, or S5 moves with S4. That decision belongs to S4's design, not this one.

This document designs **S1** and records the decomposition so the later steps inherit its shape.

## 3. The boundary

**The rule: if the state answers it, the Host runs it. Otherwise the app does, for now.**

To the Host in S1: ownership of `orchestration.json`, and every command that is a pure state
transition — all reads, `questions answer`, `task-create`/`task-update`, `run-create`/`run-spawn`,
`run-pause`/`run-resume`/`runs resume`, `gate-create`, and the four a worker lives on: `send`,
`reply`, `check`, `ask`, `inbox`. That last group is the point. It is what makes a Host that outlives
the app mean something: a running worker keeps reporting and keeps asking.

Left in the app in S1, and reclaimed by S2 through S4: session spawn, worktrees, coordinator spawn,
session kill, account and run-config lookup. The Host receives these, asks the attached app to perform
them, and refuses when no app is attached.

Left in the app permanently: the renderer, and `browser-js` (the agent browser needs an Electron
window).

`OrchServerDeps` has 30 members. The Host supplies four itself — `getState`, `setState`, `now`,
`enabled`. The other 26 are actions, and that asymmetry is what makes S1 affordable: the Host takes the
state and the decisions, and none of the machinery.

**Two costs, stated rather than hidden.** The Host's files keep a deliberate discipline of importing
nothing outside `core/host/protocol`, because they bundle into the Host's own executable; S1 breaks
that by pulling in `core/orchestration/state.ts`, which drags `core/i18n` along for gate messages. And
the app stops reading state directly, so the renderer's snapshot gains a hop. Both are acceptable;
neither should be discovered later by someone wondering what happened.

## 4. Discovery, and `astera host start`

**The address is computed, not registered.** `hostAddress({profileDir, platform, tmpDir, protocol})`
already derives the pipe or socket name from the first twelve hex characters of the profile path's
sha256. The CLI already knows how to compute the profile (`cliDiscovery.userDataDir`, including
`ASTERA_PROFILE=dev`). CLI-side discovery is therefore the composition of two functions that exist,
not a new mechanism.

The spec's §5 asks for a descriptor file. This design splits the difference: **the address is computed;
the descriptor reports facts.** A written address goes stale (§46) and a computed one cannot. The
descriptor carries only what computation cannot know — pid, startedAt, host version, protocol,
features — and is what `host status` shows a person. The connection remains the source of truth.

**The handshake already exists.** `hello {protocol, app}` answered by `hello {protocol, host, pid,
startedAt, features?}`, with `protocol-mismatch` for the bad case: the spec's §7 and §34 are already
implemented. Orchestration is advertised by adding `'orch'` to `features`, **not** by moving the
protocol number. Bumping it retires a Host that is running perfectly well and kills its terminals with
it; `protocol.ts` already says exactly that about an earlier addition.

**`host start` builds nothing new.** `hostSpawnPlan` is already a pure function returning
`{command, args, options}`, paired with `resolveHostEntry`. They live in `src/main/host/` where the CLI
cannot reach them, so they move to `src/core/host/` and both callers use them. The packaged-versus-dev
split — the prepared Node runtime or the Electron binary — moves with them.

**`host stop` refuses by default** when sessions or Jobs are running, with the counts (§12). No
`--force`: nobody has measured what a forced stop leaves behind in the current recovery model, and an
unmeasured flag on a destructive operation is not a flag.

**`host status` answers without a Host**, with `running: false`, the profile path, and the Job count
read from the state file. It still exits 3: the content is the answer to "what is there", and the code
is the answer to "is the Host running", which is what §8 of the spec asks a script to be able to tell.

**Nothing is killed by PID** (§9, §46). The only way to clear a stale peer is to connect and send
`retire`, which `retireOlderHosts` already does.

## 5. The control API

**One message pair, not eighty.** A type per command would turn forty commands into eighty message
types.

```text
client -> host   { t: 'orch-call',   call, cmd, args, session? }
host -> client   { t: 'orch-result', call, status, body }
```

`{cmd, args}` is the HTTP body as it stands today and `session` is the `x-astera-session` header, so
`handleCommand(deps, {sessionId}, cmd, args)` moves unchanged and `COORDINATOR_ONLY` comes with it. The
command layer was already separated from HTTP for exactly this reason; this is that separation being
spent.

**What changes is the dependencies, not the command layer.** In the Host, `getState`/`setState` are its
own store; the action dependencies are calls back to the attached app.

```text
host -> app   { t: 'orch-act',   call, act, args }
app -> host   { t: 'orch-acted', call, ok, value?, error? }
```

S2 makes `startWorker` local instead of remote. S3 does the same for worktrees, S4 for dispatch. Each
time, `handleCommand` is untouched.

**No app attached is `CONFLICT` (6).** No new exit code: §26's ten are a closed set, and inventing an
eleventh for a state that disappears at S4 is worse than reusing the one that already means "the
current state makes this impossible". `worker-start` already catches a spawn failure, removes the
Dispatch and restores the Task, so refusing leaves nothing dirty.

**Long polls ride the socket.** `check --wait` (5 min), `ask` (10 min) and `runs wait` (1 hour) hold
open and are matched by `call`. This is better than HTTP, which needed care around Node's
`requestTimeout`. A caller that dies closes the socket and the Host abandons that call — which is §44's
"Ctrl+C ends the wait, not the Run", for free.

**The app's mirror is pushed.** `{ t: 'orch-state', state }` on every commit; the app swaps its mirror
and derives the snapshot as it does today, so the renderer path keeps its shape. Pushing the whole
state looks wasteful until you notice the app needs the whole state to derive a snapshot anyway.

**The app identifies itself in `hello`**, which already carries `app`. The app client is the target of
`orch-act`; CLI clients only ask. One profile has one app (single-instance lock).

## 6. State ownership and boot order

**One writer.** The Host owns `orchestration.json`, including its `.bak`. The app stops constructing
`OrchestrationStore` — deleting that one line is what enforces the rule. The path does not change: same
profile, same file.

**Load-time work follows the store.** `store.load()` today asks the app for the Host's surviving
sessions and splits three ways: a set, `unknown`, or absent. Inside the Host the session list is its own
registry, so `unknown` ceases to exist — "we asked and got no answer" is not a state a process can be in
about itself. The schema migration (legacy runs into Job and JobRun) moves with it.

**The pending-report queue moves too.** Its meaning changes from "the app was closed" to "the Host was
closed", which is rarer but not gone: a machine gets turned off. Its directory is currently derived from
`orch-info.json`'s path, so it is re-derived from the profile.

**The app waits for `ready()`.** `HostClient` already exports the combined connect-and-handshake
deadline. The Jobs view gains two states it does not have today: waiting for the Host, and unable to
reach it, with a reason. That is the only new UI in S1.

**A dead Host is survivable.** Its state is on disk and the next Host opens it; the app reconnects and
re-mirrors. The durability sessions already have extends to the state.

## 7. What is removed

Backward compatibility is unchanged — `astera help`, `ASTERA_CLI` and `astera-orchestration` all keep
working (§31). What goes is the plumbing underneath.

- main's loopback HTTP server and its bearer token
- `orch-info.json` and `writeInfo`
- `cliDiscovery.infoPathFor` (`userDataDir` stays: the profile is how the address is computed)

`ASTERA_INFO` goes. **What replaced it is `ASTERA_PROFILE_DIR`, not `ASTERA_HOST`** — an absolute path
to the app's `app.getPath('userData')`, from which both the Host's address and the pending-report
queue are derived. `ASTERA_HOST` still exists, but only as an override naming one specific Host by
address.

**Amended after step 7 (2026-09-22).** The plan above was one address and nothing else, and it is not
enough. The `-dev` suffix on a development profile comes from `app.isPackaged` (`src/main/index.ts`)
and no variable carried it, so a CLI left to recompute the profile answered `%APPDATA%\astera` for a
dev build too: a worker spawned by the dev app reached the *installed* Host and dropped its
undelivered reports into the installed profile's queue, where the installed app drained them
(measured, F43). An address alone cannot fix that, because the queue's directory and the state file
the CLI falls back to are both properties of the profile and an address does not say which profile
the Host behind it uses — the same reason §6 above gives for re-deriving the queue from the profile.
So the folder travels and the address is computed from it, exactly as the app computes it
(`hostAddress`).

The spec's §2 asks that internal and public invocation differ only in where the connection information
comes from. That still holds: the difference is one variable, and the variable names a profile rather
than an address.

## 8. Errors

No new codes. The three new failures each have a seat in §26's closed set, and each tells a person
something different to do.

| Situation | Code | Why |
|---|---|---|
| No Host | 3 | The message names `astera host start`. Most reads do not reach here: they answer from the file. The exceptions are the waiting commands, which a static file cannot answer — see §12's first question. |
| Host without `orch` in `features` | 9 | The Host outlives app updates by design, so an old Host with a new CLI is ordinary, not exotic. |
| The command needs the app, and no app is attached | 6 | Transitional; gone at S4. |
| The socket dropped mid-call | 3 | The Host is gone; a retry confirms it. |
| `host stop` with work running | 6 | With the counts (§12). |

**The old Host is not retired silently.** It holds terminals that would die with it. Exit 9 says what
happened, `host stop` refuses while work is running, and the person decides.

**§45's `HOST_RECOVERING` is not implemented, having looked at what §45 asked us to look at.** The
Host's load is one JSON read and one pure reconcile. So orchestration calls are simply not accepted
until the state is loaded, and they wait. A short wait beats a new error code that every script would
have to write a retry loop around.

**The worker's policy is preserved.** A `worker_done` or `escalation` that cannot be delivered is still
written to the queue and still exits 0 with the notice. Only the trigger changes, from "cannot read the
info file" to "cannot reach the Host". The point of that mechanism is that a worker never has to
interpret a failed command for itself.

## 9. Security

The boundary is the spec's: same machine, same OS user (§6). Today the HTTP path is defended by a bearer
token in a 0600 file. Moving to a pipe replaces that with OS permissions, and on Windows that is not
automatic.

**Windows named pipes are created readable by Everyone and ANONYMOUS by default.** Measured on this
machine, `D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)(A;;FR;;;WD)(A;;FR;;;AN)`.

**No ACL work is needed, and the reason is already written down.** `server.ts` records it at
`greetedSockets`: the grant to Everyone is `FILE_GENERIC_READ`, which carries no `FILE_WRITE_DATA`, so
such a peer cannot send `hello` — and a peer that has not said hello is never added to the set the Host
writes to. Orchestration inherits that property unchanged, because every reply it adds is addressed:
`orch-result` goes to the socket that asked, and `orch-state` goes to the app client. A read-only peer
gets a socket and silence, before and after this design.

So §6's "Windows named-pipe ACL" is satisfied by a property the code already has rather than by new
code. What S1 owes is a test that pins it: a client that never says hello receives nothing, including
no `orch-state`. Without that test the property is an accident that a later refactor can remove, and
the first sign would be another local account reading a Job's state.

The unix socket path keeps its directory-permission story, and the descriptor file is written 0600, like
the token file it replaces.

## 10. Tests

The shape follows §48, adapted to what is testable here.

**Pure, no process.** Address derivation from a profile. Descriptor parse, including a stale one.
Feature negotiation against a Host without `orch`. Call and result correlation. The dependency shim that
turns an action into `orch-act` and rejects when no app is attached. `handleCommand` itself needs no new
tests: it does not change, and three hundred existing ones cover it.

**Host RPC, in process.** Two fake clients on one Host, an app and a CLI. A call answered while another
is still waiting. A long poll abandoned by a disconnect. A call arriving before the state has loaded. An
action forwarded and answered, and an action with no app attached.

**With the real app.** The three the spec names as acceptance (§57), each run by hand against the dev
app: status and reads with the window closed and with the app quit; a question answered from a shell
while a worker waits on it; and the orchestration regression, a real Job with a real worker, which is the
only way the assembled spec and the coordinator's own path get exercised.

**The one that matters most for S1**: quit the app, confirm the Host still answers `jobs list`, then
answer a question from the shell and watch the blocked worker continue. That sequence is the whole
justification for the move, and if it does not work nothing else in S1 is worth shipping.

## 11. Order of work for S1

1. `hostSpawnPlan` and `resolveHostEntry` move to `core/host/`; `astera host start|status|stop`.
2. The no-hello-no-output property pinned by a test, before anything rides the pipe (§9).
3. `orch-call`/`orch-result` and the call table; `features: ['orch']`.
4. The store moves; the Host loads and owns it; the app stops constructing it.
5. `orch-act`/`orch-acted` and the remote dependency shim.
6. `orch-state` and the app's mirror; the Jobs view's two new states.
7. The CLI switches from HTTP to the pipe; the file fallback for reads with no Host.
8. Removal: the HTTP server, `orch-info.json`, and `ASTERA_INFO` giving way to `ASTERA_PROFILE_DIR`
   (§7's amendment — the plan said `ASTERA_HOST`, and step 7 showed an address cannot answer where
   the report queue lives).
9. The guide, and `docs/cli.md` (§51).

## 12. Open questions

1. ~~**Does the file-read fallback cover every read command, or only the cheap ones?** `runs wait` and
   `check --wait` cannot be answered from a file nobody is writing. They should refuse with 3 rather
   than wait forever on a static file, but that needs stating per command.~~

   **Answered in step 7 (2026-09-22).** It is stated per command, as an allowlist: `FROM_FILE` in
   `src/core/orchestration/stateFile.ts`, fourteen names, each a verb rather than a noun. The
   allowlist is the answer to the "or only the cheap ones" half as well — the default is "needs a
   Host", so a read command added later does not silently start answering from a stale file. The
   waiting commands are not on it and end with 3, as this question said they should. `docs/cli.md`
   publishes the same list for people.
2. **What does the app do when it finds a Host that predates `orch`?** It cannot retire it without
   killing terminals, and it cannot show Jobs without it. Probably the same two-state Jobs view as §6,
   with a sentence naming the version. Needs deciding before S1 ships.
3. **S5's trap** (§2): whether validation-bearing Tasks refuse to advance with no app, or S5 moves with
   S4.
