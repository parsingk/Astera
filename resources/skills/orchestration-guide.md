# Cross-vendor orchestration — full guide

This document, which `astera help` prints, is the single source of truth for usage. Everything below
is a runnable command line — use it as written rather than guessing.

`astera` is a **command** on the PATH of any session the app started. Its absolute path is in
`$ASTERA_CLI` (section 10).

**If `astera` comes back as `command not found`, do not give up — retry the same command as
`"$ASTERA_CLI"` first.** It is the same program and works regardless of the shell. Read every example
below with `astera` replaced by `"$ASTERA_CLI"` if you need to. **Only** when `echo "$ASTERA_CLI"` is
empty does it mean this session was not started by the app, or that orchestration is off — in which
case it has to be enabled in settings and a new session started.

## 1. Six concepts

| Concept | Role |
|---|---|
| **Run** | A durable namespace plus the coordinator inbox. It does no scheduling or batching |
| **Task** | One work item. A spec, its dependencies (`deps`), and a lifecycle state |
| **Dispatch** | One attempt at running a session for one Task. It owns that session's lifetime (alive/ended) |
| **Message** | One piece of mail (`status`, `worker_done`, `question`, `escalation`, `heartbeat`, `decision_gate`) |
| **Delivery** | The **batch** `check` returns (up to 50). The same batch replays until `--ack <deliveryId>` |
| **Gate** | A decision block the coordinator creates and the coordinator resolves. **It is for deciding the task DAG, not for stopping a worker that is already running** (that is `worker-stop`) |

In practice there is one Run — `task-create` and `check` use the most recent Run automatically unless
told otherwise. `run-use --id <run>` only checks that the Run exists and returns success; it binds
nothing to the session (the current implementation is a no-op). If you plan to keep several Runs going
at once, pass `--run <run>` explicitly on every command (`task-list` and `check` accept it).

## 2. Six Task states and their transitions

`pending → ready → dispatched → completed | failed`, plus `blocked` (a Gate).

| from | to | Trigger |
|---|---|---|
| `pending` | `ready` | all `deps` are `completed` |
| `pending`, `ready` | `dispatched` | `worker-start` |
| `pending`, `ready`, `failed` | `blocked` | `gate-create` (rejected if a Dispatch is open) |
| `blocked` | `ready` | `gate-resolve` (if the Task has more open Gates, all of them must be resolved too) |
| `dispatched` | `completed` | the worker's `send --type worker_done --outcome succeeded` |
| `dispatched` | `failed` | `worker_done --outcome failed`, or the session dies without reporting |
| `failed` | `dispatched` | `worker-start --retry-of <dsp>` (fewer than 3 consecutive failures) |
| `failed` | (terminal) | 3 consecutive failures — circuit break, no further retries |

There is no `dispatched → blocked`. Receiving `worker_done` puts the Task and the Dispatch into a
terminal state **automatically** — do not add anything after it (see section 10).

## 3. A supervision loop, end to end

```bash
# 1) Create the Run — always pass --cwd (see 4.1)
astera run-create --objective "refactor the auth module" --cwd "/abs/path/to/repo" --json

# 2) Create N Tasks (no --run flag — they attach to the most recent Run automatically)
astera task-create --title "consolidate types" --spec - --json <<'EOF'
Consolidate the core/auth types into one place. ...
EOF
astera task-create --title "add tests" --spec - --deps '["tsk_1a2b3c4d"]' --json <<'EOF'
Once the consolidation above is done, add regression tests. ...
EOF

# 3) Check the accounts, then start N workers
#    --worktree new **requires** --name (4.3) — without it the request is rejected with a 400
astera accounts --agent claude --json
astera worker-start --task tsk_1a2b3c4d --agent claude --account acc_main --worktree new --name types-cleanup --json
astera worker-start --task tsk_5e6f7a8b --agent codex --account acc_sub --worktree new --name add-tests --json

# 4) Wait — blocks until worker_done, escalation, or question arrives (this can take tens of minutes)
astera check --wait --json

# 5) Ack only after handling every message in the batch (reply first if it was a question)
astera reply --id msg_9f9f9f9f --body - --json <<'EOF'
That path is correct. Carry on.
EOF
astera check --ack dlv_aaaa1111 --json

# 6) Clean up when done — reuse the session if there is follow-up work, otherwise release it
astera worker-start --task tsk_next --agent claude --account acc_main --terminal <sessionId> --json
astera worker-release --dispatch dsp_c3c3c3c3 --json
```

## 4. CLI reference

Arguments like `--spec`, `--body`, `--question`, and `--result` **read from stdin** when given the
value `-` (4.6). Every command already outputs JSON — the `--json` flag is accepted but makes no
difference to the output.

### 4.1 Run

```
run-create --objective <s> [--cwd <p>] [--json]
run-list [--json]
run-show --id <run> [--json]
run-use --id <run> [--json]        # confirms existence only; binds nothing (see section 1)
```

**Always pass `--cwd`.** Omit it and `astera` fills in **its own process's working directory** — that
is, the current directory of that shell. If that is not the repository root, every worker in that Run
(`--worktree current` being the default) comes up in the wrong directory, and nothing reports it.
Passing `--cwd <absolute repo path>` is the only reliable way.

### 4.2 Task and Gate

```
task-create --title <s> --spec <s|-> [--deps <json_array>] [--parent <tsk>] [--json]
task-list [--run <run>] [--status <s>] [--ready] [--brief] [--json]
task-update --id <tsk> --status <s> [--result <s|->] [--json]   # bypasses the transition table — see section 8
dispatch-show --task <tsk> [--json]        # returns that Task's Dispatch history as an array (retries included)

gate-create --task <tsk> --question <s|-> [--options <json_array>] [--json]
gate-resolve --id <gat> --resolution <s> [--json]
gate-list [--task <tsk>] [--status <s>] [--json]
```

- What the server blocks for workers is `task-create`, `task-update`, `gate-create`, and
  `gate-resolve` (section 6, `COORDINATOR_ONLY`). `task-list`, `dispatch-show`, and `gate-list` are
  not rejected for workers, but a worker follows section 6 and only uses `send` and `ask`, so it never
  needs them.
- The target flag for `task-update` is **`--id`**, not `--task` — passing `--task` yields
  `400 --id is required`.
- Omitting `--title` fills it from the first line of the spec (cut at 80 characters).
- `--ready` filters to Tasks with `status=ready`. `--brief` truncates the spec to 160 characters and
  returns `spec_truncated` alongside it — for a coordinator skimming many Tasks without burning
  context.
- `gate-create` **is rejected if the Task has an open Dispatch** (`cannot gate a task with an open
  dispatch`). To stop a worker that is running, use `worker-stop`, not a Gate.

### 4.3 Starting workers, their lifetime, and accounts

```
worker-start --task <tsk> --agent <claude|codex> --account <id>
             [--worktree <current|new|path>] [--name <s>]   # --name is required with --worktree new
             [--terminal <sessionId>] [--retry-of <dsp>] [--json]
worker-show --dispatch <dsp> [--json]
worker-read --dispatch <dsp> [--limit <n>] [--json]
worker-release --dispatch <dsp> [--json]
worker-retain --dispatch <dsp> [--json]
worker-stop --dispatch <dsp> [--json]
worker-abandon --dispatch <dsp> [--json]
accounts [--agent <claude|codex>] [--json]
```

- What the server blocks for workers is only `worker-start`, `worker-release`, `worker-retain`,
  `worker-stop`, and `worker-abandon`. `worker-show`, `worker-read`, and `accounts` are not blocked,
  but a worker has no use for them either (section 6).
- Default: `--worktree` is `current` when omitted.
- **`--name <s>` is required with `--worktree new`** — it becomes the branch and directory name of the
  new worktree. Without it the request is rejected with `400 --name is required for --worktree new`.
  It is unused (ignored) with `--worktree current` or an explicit path.
- **`--retry-of <dsp>` does not inherit placement.** Pass `--worktree`, `--agent`, and `--account`
  again — omitting them can retry with a different combination than the original attempt.
- `--terminal <sessionId>` reuses an existing worker session. This is the only case where a new Task
  can be handed to the same session without `--retry-of` (see the example in section 5).
- A successful `worker-start` responds with `{ sessionId, cwd, specPath, dispatchId }`. That is where
  the `dispatchId` used by later commands comes from — record it.
- **The app does not close a Dispatch that has been `worker-retain`ed.** After that, `worker-stop` is
  rejected with **409 `dispatch is retained`** (and the state does not change), and `worker-release`
  returns 200 but with **`"skipped": "retained"`** in the response — meaning the session is still
  alive. **There is no command that undoes retention.** If that session really has to end, the user
  must close the tab themselves (at which point the app closes the Dispatch); to give up only the
  tracking, use `worker-abandon`. Mistaking a live session for a dead one and starting a new worker in
  the same directory with `--retry-of` puts two agents on the same files at once — hence the
  rejection.
- `accounts` returns `{ id, label, provider }[]`. **Looking the accounts up first and then choosing
  `--account`** is the core of what this app adds to orchestration — never guess, always confirm a
  real id with `accounts` before passing it to `worker-start`. **Usage and remaining quota are not
  included** — they cannot be known at lookup time. Quota only becomes known through a failed
  worker's `limitResetsAt` (section 7).
- A Task that has reached 3 consecutive failures (`consecutiveFailures`) has
  `worker-start --retry-of` rejected with `circuit break`.

### 4.4 Messaging

```
send --type <status|worker_done|escalation|heartbeat>
     --subject <s> [--body <s|->] [--task-id <tsk>] [--dispatch-id <dsp>]
     [--outcome <succeeded|failed>] [--files-modified <p,…>] [--json]
check [--wait] [--types <t,…>] [--ack <deliveryId>] [--timeout-ms <n>] [--run <run>] [--json]
inbox [--limit <n>] [--json]
reply --id <msgId> --body <s|-> [--json]
ask --question <s|-> --task-id <tsk> [--dispatch-id <dsp>] [--options <csv>] [--timeout-ms <n>] [--json]
ask --resume <questionId> [--json]
help [--skills-dir <p>]
```

- `--task-id`, `--dispatch-id`, and `--outcome` are **required only** for `--type worker_done`. For
  other types, omitting them fills in the caller's currently open Dispatch.
- `check` has **no** read-only inspection flags such as `--peek` or `--all` — to look at history
  without consuming a batch, use `inbox --limit <n>`. `inbox` does not consume a batch (it never
  acks), but it is **coordinator-only** — a worker calling it gets a 403 (section 6).
- The default `--timeout-ms` is `300000` (5 minutes) for `check` and `600000` (10 minutes) for `ask`.
  Both can be overridden with `--timeout-ms`.
- `ask` requires `--task-id` when creating a new question. `--dispatch-id` may be omitted when the
  caller is the session holding that Task's open Dispatch (i.e. the worker itself) — it fills in from
  its own Dispatch.
- `ask --resume <questionId>` keeps waiting on that question id alone, with no `--task-id`,
  `--dispatch-id`, or `--question` (section 8).
- `help` takes no arguments. It works without a server connection (`ASTERA_INFO`), but `ASTERA_SKILLS`
  (or `--skills-dir`) must be present for it to find this document.

### 4.5 Recovery (coordinator only)

```
reset --tasks|--messages|--all [--json]     # exactly one of the three is required
```

**One of the three is mandatory.** With no flag at all it is rejected with `400 specify one of
--tasks, --messages, --all` — the default for a destructive operation must not be "erase everything".
`--tasks` clears Tasks and Dispatches, `--messages` clears Messages and Deliveries, `--all` clears
everything.

**This is for recovery only.** It is rejected if even one Dispatch is open (`409 refusing to reset
while N dispatch(es) are open`) — do not call it during active coordination. Use it only after
explicitly deciding to throw that state away. When it runs, the app leaves the previous state in
`orchestration.json.bak`.

### 4.6 stdin arguments

`--spec`, `--body`, `--question`, and `--result` read from stdin when given `-` as the value.

```bash
astera send --type worker_done --task-id tsk_1a2b3c4d --dispatch-id dsp_c3c3c3c3 \
  --outcome succeeded --subject "types consolidated" --body - --files-modified "src/a.ts,src/b.ts" --json <<'EOF'
Merged the core/auth types into one. Tests untouched so far; the next Task can pick that up.
EOF
```

Do not pass long text directly as a command-line argument — quoting and special characters break
differently from shell to shell.

### 4.7 Exit codes

The exit code of `astera` is the only sound basis for deciding success or failure from `$?` in a
shell:

| Exit code | Meaning |
|---|---|
| `0` | The server responded 2xx |
| `1` | The server responded with a non-2xx status (400/403/404/409/500, …) |
| `2` | Argument parsing itself failed (e.g. an unknown flag) — the request never reached the server |

**A timeout response from `check --wait` or `ask` is also HTTP 200, so the exit code is `0`.** What
sections 5 and 6 say about "a timeout is not a failure" is carried directly by this rule — do not
treat a timeout as an error based on `$?`; check the `timedOut` field in the response body.

## 5. The Delivery contract of `check`

- `check` returns **the oldest unacknowledged Delivery (up to 50 messages) as a batch**. **The same
  batch replays** until `--ack <deliveryId>` — so if you die mid-processing, the next `check` hands you
  the same batch back with no messages lost.
- **Ack only after handling every message in the batch.** Acking after reading only part of it loses
  the rest for good (replay is per batch, not per message).
- `--types <t,…>` **only decides when a new batch gets created** — the batch that comes back is always
  every undelivered message. And **if an unacknowledged batch already exists, it is returned as-is
  regardless of `--types`** — you have to work through the backlog before the next `--types` filter
  means anything.
- A timeout from `check --wait` (`{count:0, messages:[], timedOut:true}`) or an immediate
  `{count:0, messages:[]}` is **a checkpoint, not a worker failure.** Real coding work takes 15–60
  minutes. Keep waiting — just call `check --wait` again — unless you receive `worker_done` or
  `escalation`, the session is gone (confirm with `worker-show`), or the user tells you to stop. A
  timeout response also exits `0` (4.7), so do not misread `$?` as failure.

## 6. Worker obligations

A worker (the session that received work, not the orchestrator) **uses only `send` and `ask`.** The
server blocks `check` and `inbox` as coordinator-only (403).

- `check`: the unacknowledged Delivery is shared by the whole Run, so a worker consuming it first with
  `check --ack` would acknowledge, on the coordinator's behalf, a batch the coordinator has not seen.
- `inbox`: it returns the Run's recent messages unfiltered, so a worker would read other workers'
  questions and the coordinator's answers to them, along with other Tasks' contents. What a worker
  needs is the answer to its own question, and `ask` returns that.

- **`worker_done` exactly once.** Success or failure, it is the terminal report:
  ```bash
  astera send --type worker_done --task-id <tsk> --dispatch-id <dsp> \
    --outcome succeeded --subject "<one-line status>" --body - --files-modified "path/a,path/b" --json
  ```
  Body goes through stdin: three sentences on what you did, what you found, and what is left — do not
  copy the code across, you share a working directory with the orchestrator.
- **When stuck, `ask` (blocking).** If a judgement call, missing information, or a permissions problem
  is preventing progress, ask instead of guessing:
  ```bash
  astera ask --task-id <tsk> --dispatch-id <dsp> --question - --options "choice1,choice2" --json
  ```
  On `{"answered":true,"answer":"…"}`, proceed accordingly.
- **If `ask` times out, do not ask again — keep waiting with `--resume`.** The question stays pending,
  and re-asking is rejected (one unanswered question per Dispatch):
  ```bash
  astera ask --resume <questionId> --json
  ```
  Repeat as many times as needed.
- **When ownership is still valid and the coordinator should step in but it is not blocking, use
  `escalation`** (non-blocking):
  ```bash
  astera send --type escalation --task-id <tsk> --dispatch-id <dsp> --subject "<summary>" --body - --json
  ```
- After reporting, end your turn and wait at the agent prompt. Do not close the terminal yourself — if
  the orchestrator reuses it, new instructions arrive as input.

## 7. The four `worker-show` states and what to do

```
worker-show --dispatch <dsp> --json
```

| `workerState` | Meaning | What the orchestrator does |
|---|---|---|
| `ready` | Alive and working | Keep waiting (`check --wait`), or read output sparingly with `worker-read` |
| `failed` | Proven dead (abnormal exit or `outcome:failed`) | Retry with `worker-start --task <t> --retry-of <dsp> --agent … --account … --worktree …` |
| `stopped` | Exited normally (code 0) or was halted by `worker-stop` | Retry the same way if needed, otherwise `worker-release` |
| `outcome_unknown` | Unprovable (the session died along with an app restart, or `worker-abandon`) | Run `worker-stop` and look again, or accept "resources may still be alive" with `worker-abandon` |

**Heartbeats, terminal activity, a `check --wait` timeout, and an idle TUI are not failure signals.**
Do not kill a worker over them — the only basis for the table above is the `workerState` that
`worker-show` reports.

**The table does not apply to a Dispatch with `retained: true`.** `worker-stop` is rejected with 409
and `worker-release` returns `skipped: "retained"` — the user asked for that session to be kept alive.
Do not retry in that state (it amounts to putting a second agent in the same directory). How to lift
it is in 4.3.

### A worker killed by a quota limit — `limitResetsAt`

When a `worker-show` response carries `limitResetsAt` (epoch ms), it means **that worker ended because
of an account usage limit, and the same account can be used again after that moment**. The app parsed
that fact out of the session transcript, and it also arrives in the inbox as a `status` message.

```
worker-start --task <t> --retry-of <dsp> --agent <same runtime> --account <same account> --worktree …
```

- **Do not change the account.** That moves the work onto a subscription the user did not intend.
  Waiting for the same account to free up is the default. Moving to another account is only for when
  the user explicitly says to.
- **Do not retry before the reset time.** You will hit the limit again immediately, and that failure
  counts toward the circuit breaker's three.
- **No** `limitResetsAt` means either it was not a limit or the app could not tell. The two are not
  distinguished, so treat it as an ordinary failure.
- **The app does not wait on your behalf.** Whether to wait, give up, or ask the user is your
  judgement. If a long wait is needed, tell the user and work another `ready` Task in the meantime.

## 8. Cleanup after completion — the orchestrator decides

The app does not infer completion from observation alone, and it does not close sessions
automatically. After receiving `worker_done`, pick one of these **yourself**:

- **If the same agent has follow-up work**, reuse the session:
  ```bash
  astera worker-start --task <next> --agent <same agent> --account <same account> --terminal <sessionId> --json
  ```
  (Even with `--terminal`, `--agent`, `--account`, and `--worktree` must be given again — placement is
  not inherited.)
- **If there is no follow-up**, clean up with `worker-release --dispatch <dsp>`. Call it after both
  success and failure reports — it is after-the-fact cleanup, not cancellation. Only the session that
  Dispatch owns is closed; a reused session, a session the user took over, and a session whose
  ownership cannot be proven are all preserved.
- **If the user asks to keep it alive for debugging**, `worker-retain --dispatch <dsp>` — it is
  recorded as an exception rather than silently skipped. After that, `worker-stop` is rejected with 409
  and `worker-release` returns `skipped: "retained"` (meaning no session was closed). **There is no
  command that undoes it** — see 4.3.

**Do not try to move a Task's state by hand after `worker_done`.** `worker_done` already puts the Task
and the Dispatch into a terminal state (`completed`/`failed`).

`task-update --id <tsk> --status <s>` is **not for the normal flow.** It bypasses the state transition
table, so use it only as an escape hatch for a stranded Task — for example, a Task stuck at `failed`
by a circuit break (3 failures) that a human has checked and wants corrected to `completed`. Calling
it leaves a record of the bypass in the app log. Once corrected, Tasks that depended on it move to
`ready` automatically.

**`task-update` resets that Task's `consecutiveFailures` (the circuit counter) to 0.** So even a Task
whose circuit opened after 3 failures can be dispatched again after
`task-update --id <tsk> --status ready` — because it means a human checked the cause and cleared it.
This is the only escape hatch that opens the circuit (the only other path to a zero counter is a
worker's `worker_done --outcome succeeded`, and that is unreachable while dispatching is blocked).
**Do not reach for it out of habit without checking the cause** — that makes the circuit breaker
meaningless and repeats the same failure indefinitely.

## 9. Do not — summary

- Do not conclude a worker failed from a `check --wait` timeout or `{count:0}` (section 5).
- Do not kill a worker over heartbeats, terminal activity, or an idle TUI (section 7).
- Do not try to move state by hand after `worker_done` (section 8).
- If `ask` times out, do not re-ask — keep waiting with `--resume <questionId>` (section 6).
- `worker-start --retry-of` does not inherit placement — pass `--worktree`, `--agent`, and `--account`
  again (4.3).
- Do not try to call `check` or `inbox` from a worker session — they are rejected. Use only `send` and
  `ask` (section 6).
- Do not treat a `worker-retain`ed Dispatch as dead — `worker-stop` returns 409 (4.3).
- Do not guess accounts — confirm a real id with `accounts` first (4.3).
- Do not move a quota-killed worker **to a different account.** Retry on the same account after
  `limitResetsAt` (section 7).

## 10. Environment variables

| Variable | Value | Applies to |
|---|---|---|
| `ASTERA_CLI` | Absolute path to the CLI executable. Its directory is prepended to this session's PATH, so `astera` works too | Orchestrator and workers alike |
| `ASTERA_INFO` | Absolute path to the connection info JSON (`{port, token}`) | Everyone (except `help`, which does not need it) |
| `ASTERA_SESSION` | This session's app session id — the caller's identity | Everyone |
| `ASTERA_SKILLS` | Absolute path to the directory holding this document | Everyone (`help` reads it from there) |

**Only this session's PATH is modified** — the app does not touch the user or system PATH. So a shell
the app did not start has no `astera`, and even if it did, it owns no Dispatch and can do nothing as a
worker. On win32 the shuttle is two files (`astera.cmd` for cmd and PowerShell, the extension-less
`astera` for bash — MSYS bash does not consult PATHEXT). On macOS and other posix platforms it is a
single extension-less `astera` file. Calling `astera` works from any shell, and when it does not,
`"$ASTERA_CLI"` always does.

An empty `ASTERA_CLI` means this session was not started by the app, or orchestration is off — enable
it in settings and start a new session. Use this value too whenever a script needs the absolute path.

**Stub installation**: at server startup the app installs the stub into **both claude and codex**
accounts at `<configDir>/skills/astera-orchestration/SKILL.md`. `AGENTS.md` is a user file and is left
alone. **Both runtimes were verified to recognise this file as a skill** — it can also be invoked
directly as `/astera-orchestration`. Skills load at session start, so it does not appear in sessions
that were already open before installation.
