# The public `astera` command — design

**Source specification:** `docs/ASTERA_PUBLIC_HEADLESS_CLI_IMPLEMENTATION_SPEC_20260919.md` ("the CLI
spec"), §10–§12 command design, §13–§20 the commands themselves, §23–§27 the output contract, §29–§30
distribution, §42 the read-first rollout, §52 help.

**Builds on:** `docs/2026-09-21-job-run-split-and-projects-design.md` — the model this CLI publishes.
Projects have ids, Jobs and runs are two levels, and the CLI is the first caller that needs both.

---

## 1. What this delivers

`astera` becomes a command a person can type in any terminal, not only inside a session the app
started.

```bash
astera status
astera projects list
astera jobs list --json
```

**It works while the app is running.** With the app closed it says so and exits non-zero — the CLI
spec's own answer for that case (§8). Making it work with the app closed is Host slice 3, and this
design deliberately does not wait for it (§12).

## 2. Decisions taken in conversation (2026-09-21)

1. **Noun-verb names, no aliases.** `jobs list`, not `run-list`. A removed name answers with the name
   that replaced it rather than failing blankly. The users of the old names are coordinator agents
   that read `astera help` before their first command, so a named replacement is a self-correcting
   turn rather than a break.
2. **The second level folds away.** `astera jobs get job_1` answers with the latest run inline;
   `runs` commands exist for when there is more than one. Someone whose Jobs run once never types
   `runs`.
3. **One vocabulary.** The internal and public CLI are the same program with the same names — the
   difference is only where the connection details come from (CLI spec §2).

## 3. What exists today

The `astera` in a session is already an RPC client: it reads `ASTERA_INFO` (a JSON file holding a
loopback port and a bearer token), POSTs one command to the app, prints the reply, and exits 0 or 1.

Three things it does not have, and this design adds all three.

| Today | After |
|---|---|
| `--json` is parsed and **ignored** — output is always JSON | JSON on `--json`, a human table by default |
| Exit code is 0 or 1 | The spec's 0–10, so a script can branch (§26) |
| The reply is the bare object | A `{ok, data}` / `{ok, error}` envelope (§25) |

**The envelope is a breaking change for the coordinator**, and it is taken now rather than later for
the same reason the names are: the guide is being rewritten anyway, and two output shapes would be
worse than one new one.

## 4. Discovery

A CLI inside a session is told where to connect. A CLI outside one has to find out.

```text
ASTERA_INFO set          → use it (a session the app started)
otherwise                → <userData>/orch/orch-info.json
```

`<userData>` is `%APPDATA%/astera` on Windows and the platform equivalent elsewhere — the same path
the app writes, derived the same way on both sides. The dev app appends `-dev` to it
(`src/main/index.ts`), so `ASTERA_PROFILE=dev` selects that one; without it the CLI talks to the
installed app.

**This is the file the app already writes** (`writeInfo` in `main/orchestration/shuttle.ts`, mode
0600) and already deletes as it quits. Nothing new is stored, and "the app is not running" is exactly
"that file is not there".

**Not the Host's pipe.** The Host does not serve orchestration yet — it holds terminals. When slice 3
moves the command server into it, this function is the only place that changes (§12).

## 5. The command surface

```text
astera
├─ version                 CLI, app and protocol versions
├─ status                  is the app there, and what is running
├─ projects list|get|find
├─ jobs     list|get|run|wait
├─ runs     list|get|wait|cancel
├─ tasks    list
├─ questions list|get|answer
└─ help                    the orchestration guide, as today
```

Phase A of the rollout (§42) is everything above except `jobs run`, `runs cancel` and
`questions answer`; those land in Phase B once the read surface has been lived with.

**Coordinator-only commands keep their names.** `worker-start`, `dispatch-show`, `send`, `check`,
`ask`, `gate-*`, `task-create`, `task-update` are not part of the public surface and are not renamed
— renaming them would cost a guide rewrite and buy nothing, since nobody outside the app types them.

`tasks list` is the one read command that overlaps: it is `task-list` under a public name, because a
person watching a Job wants to see its Tasks and that is the CLI spec's §18.

## 6. Output

Two modes, and the spec is explicit that a script must never parse the human one (§23).

**Human** — aligned columns, no borders, the state first because that is what a person scans for:

```text
RUNNING   job_4f2a  Refactor authentication      3/7
WAITING   job_91bc  Payment migration            1 question
COMPLETE  job_2d80  Rename the run config store  5/5
```

**Machine** — the default, and then the envelope below is the whole contract.

`--quiet` prints ids only, one per line, so `for j in $(astera jobs list --quiet)` works without `jq`.

**Human is `--human`, not the default, and the reason is measured.** The plan was the usual one: human
when stdout is a terminal, machine when it is piped. It cannot work here. This CLI runs as
`electron.exe` under `ELECTRON_RUN_AS_NODE`, and Electron on Windows is a GUI-subsystem binary, so
`process.stdout.isTTY` is `undefined` even inside a real console — plain `node` in that same console
reports `true`. The shim cannot switch binaries either: a packaged app cannot assume `node` is
installed, which is why it ships Electron's.

So the choice was between a flag and making human the default. Human-by-default would change what the
coordinator reads: the guide writes `[--json]` as optional on every command, so `tasks list` without
it would return a table with no `spec` and no `checks`. A flag costs a person eight characters; the
default costs an agent the fields it works from. If this turns out to be the wrong trade, it is one
line here and two in the guide.

No styling yet, so there is nothing for `NO_COLOR` to turn off. When colour lands it reads `NO_COLOR`
and `--no-color`; a flag that does nothing today would be worse than no flag.

## 7. The JSON envelope

```json
{ "ok": true, "data": { "jobs": [ … ] } }
```

```json
{ "ok": false, "error": { "code": "HOST_NOT_RUNNING", "message": "Astera is not running.", "details": {} } }
```

**`data` is always an object, never an array.** A top-level array cannot grow a field later without
breaking every reader; `{"jobs": [...]}` can. This is the one place the CLI spec's examples are
followed to the letter (§25) because it is the part that becomes an API.

Error codes are a closed set, and each maps to exactly one exit code (§8). The message is for a
person; the code is for a script.

## 8. Exit codes

| Code | Meaning | When |
|---|---|---|
| 0 | success | |
| 1 | generic failure | anything unclassified |
| 2 | invalid arguments | the parser refused |
| 3 | app unavailable | no info file, or the connection failed |
| 4 | not found | unknown id |
| 5 | permission denied | the 403 the server already answers |
| 6 | conflict | the 409 the server already answers |
| 7 | timeout | `--timeout` elapsed |
| 8 | waiting for input | `wait` stopped because a question is open |
| 9 | version mismatch | CLI and app disagree |
| 10 | the Job or run finished with failure | `wait` on a failed run |

The server already answers 400/403/404/409, so the mapping is mostly a table. **8 and 10 are the two
that matter for CI**: a script needs to tell "it finished badly" from "it is waiting for a person",
and both are legitimate non-zero ends of `wait`.

**9 comes from an unknown command, not from comparing numbers.** The server answers 501 for a command
it does not have; the CLI maps that to 9. The two halves ship as one build, so a command this CLI
knows and that app does not means the shim points at a different binary than the one running, which
is the only mismatch worth a code of its own. 404 stays what the table says it is: an id that is not
there. Apps released before this change answer 404 for an unknown command too, and those fall out as
4 with a message that says which it was; the CLI does not read messages to pick a code.

**`version` never fails.** It exists to say whether the two halves agree, so it answers 0 with what
it knows whatever the app does: no app, an app too old for the command, even a stale token. `app` is
null when the app did not say, and the next command reports the real problem with its own code.

## 9. Removed names

`unknown command: run-list` becomes:

```text
run-list was renamed to `jobs list` (astera help)
```

One table, in the parser, from the old name to the new one. It is not an alias: the command does not
run. An agent reading that line fixes itself in one turn; an alias would leave two vocabularies alive
in a guide that agents read end to end.

## 10. Installation

`astera` already exists as a shuttle script the app writes into `<userData>/orch` and puts on the
PATH of sessions it starts (`writeShuttle`). Making it public is making that directory reachable from
an ordinary shell.

**A button in Settings, not an installer step.** The CLI spec allows either (§29); a button is chosen
because it is reversible, it can say where the file went, and it does not make every person who
installs the app take a PATH change they did not ask for.

```text
Command Line Interface
Status: Not installed
[ Install `astera` command ]
```

What the button does:

1. writes the same two shuttle files into a **user-local bin directory** — `%LOCALAPPDATA%/astera/bin`
   on Windows, `~/.local/bin` elsewhere;
2. checks whether that directory is on `PATH`;
3. if it is not, says so and offers the one line to add, **without editing a shell profile**. The CLI
   spec forbids touching the profile silently (§29) and this design forbids it outright: a file the
   person did not write is a file they will not think to look at when something breaks.

The shuttle runs the app's own binary with `ELECTRON_RUN_AS_NODE=1`, so **the CLI and the app cannot
drift**: there is one program. That also answers the spec's "app update 시 CLI 동기화" — an update
replaces the binary the shuttle points at, and the shuttle is rewritten at every boot anyway.

**Built, with two things worth recording.** `%LOCALAPPDATA%/astera` already exists on a machine that
has run this app: the Host keeps its node runtime there. The bin directory sits beside it rather than
inventing a new root. And the button is only for shells the app did not start — sessions the app
spawns already have the shuttle's directory on their PATH, which is why an agent can call `astera`
today and a person cannot.

The status line names the directory, because an install that does not say where it put something is
an install nobody can undo. The PATH line is shown, never run: on Windows it is the PowerShell
two-call form, not `setx PATH "%PATH%;…"`, because `setx` truncates a value over 1024 characters and
handing someone a command that can silently cut their PATH is not an instruction, it is a trap.

## 11. Security

The boundary is the CLI spec's: same machine, same OS user (§6). Three things carry it, and all three
already exist.

- The loopback server listens on `127.0.0.1` only.
- The token file is written with mode 0600, and the token never appears in a command line or a log.
- The bearer token is required on every request.

**What this design adds is redaction on the way out.** The commands below return objects the app
holds, and those objects carry things the CLI spec says must never be printed (§38): account config
directories, session auth material, the token itself. An allowlist shapes the reply — never a
blocklist, because a blocklist is a list of the leaks somebody already thought of.

**Built, and measured while building it.** None of the five objects a public read command returns
(project, job, run, task, question) holds any of the three. The one place a config directory could
have reached the wire is the account list, and the app already narrows that to `{id, label,
provider}` before the server sees it (`listAccounts` in ipc.ts). So what the allowlist does today is
not hide secrets. **It fixes the public API surface**: without it, a field added to `OrchState`
becomes public the moment it is added, and removing one breaks somebody's script.

**One list per object, not per command**, because the same object is returned by several commands and
two copies of a list drift. `jobs get` folds a run into the job (§5), and the fold is shaped with the
run's own list — a redaction that leaks one level in is not a redaction.

**The compiler keeps the lists current.** Each object's fields are partitioned into shown and
withheld, and a type-level check fails the build naming any field in neither. An allowlist's only
failure mode is going stale, and this is the cheap way to make that loud instead of silent.

**Seven Task fields are withheld**, all of them the app's convergence ledger (`checkHistory`,
`policySnapshot`, `policyChanged`, `convergenceStartedAt`, `convergenceOff`, `suspiciousFiles`,
`reviewRequested`). Publishing them would make how the app drives convergence part of the contract,
so changing the policy would break other people's scripts. `completionOverride` stays: it is a
person's decision, not a ledger, and a watcher asking "why did this pass" needs it.

**`tasks list` is also the coordinator's command**, so the withheld seven vanish from what a
coordinator sees too. The guide never names them (it reads `checks`, `consecutiveFailures`,
`parentId`), but this is the change §14's step 6 regression run has to confirm on a real Job.
Coordinator-only commands — `dispatch-show`, `worker-read`, `inbox`, `ask`, `check` — are not shaped
at all; they are outside this contract, and shaping them would only hide what the guide tells the
coordinator to read.

## 12. What this does not do

- **It does not work with the app closed.** That is Host slice 3. §4's discovery function is the only
  place that changes when it lands.
- **No write commands beyond Phase B's three.** `jobs create`, `tasks create/dispatch` and
  `validation run` are Phase C (§42).
- **No `astera host start`.** Until the Host serves orchestration there is nothing to start it for.
- **No MCP.** The spec is explicit (§53), and the adapter seam this design leaves — parser →
  command → app RPC — is what makes it possible later.

## 13. Tests

**Unit (no app running)**
- the parser: every command, `--json`, unknown flags, the renamed-name table
- the envelope: success and each error code
- exit codes: one test per row of §8
- discovery: `ASTERA_INFO` wins; missing file is code 3, not a crash
- redaction: a reply carrying a config dir or a token prints neither, in both modes

**Against a live app**
- `status` with the app up and with it down
- `jobs list` matches what the Jobs sidebar shows for the same project
- `runs list --job` on a Job with two runs
- an unknown id is 4, a malformed flag is 2

**Regression**
- a coordinator session still runs `astera help` and its flow end to end
- `npm run typecheck`, `npm test`

## 14. Order of work

1. The envelope, exit codes and the renamed-name table — the contract, with the internal commands
   moved onto it in the same step.
2. Discovery and `version` / `status`.
3. The read commands, with redaction.
4. Human output.
5. The Settings button and the bin directory.
6. The guide rewritten onto the new names, and the orchestration regression run.

## 15. Open questions

1. **Does `astera` mean the installed app or the dev app when both are running?** This design says the
   installed one, with `ASTERA_PROFILE=dev` to choose otherwise. That is a guess about which one a
   person means; it is cheap to change.
2. **`tasks list` under a public name while `task-create` keeps its old one** is a deliberate seam,
   not a tidy one. If it reads badly in use, the answer is to make the rest of the task commands
   public too rather than to hide this one.
