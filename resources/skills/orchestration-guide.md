# Cross-vendor orchestration — full guide

This document, which `astera help` prints, is the reference for the whole orchestration surface,
including the commands that are not public, which are documented here and nowhere else. For the
public commands only, one command's flags are also one line away with `astera <noun> <verb> --help`,
and `docs/cli.md` is the reference for that surface and the exit codes. Everything below is a
runnable command line, so use it as written rather than guessing.

**Section 12 is for any session, not only a coordinator.** When you are asked to plan work for later,
to check on or talk to another agent session, or to fix a missing Astera skill, the command for it is
there: `jobs create`, `sessions`, `skills install`.

`astera` is a **command** on the PATH of any session the app started. Its absolute path is in
`$ASTERA_CLI` (section 10).

**If `astera` comes back as `command not found`, do not give up — retry the same command through
the environment variable first.** It is the same program. The variable is read the way your shell
reads environment variables: `"$ASTERA_CLI"` in bash or zsh, `& $env:ASTERA_CLI` in PowerShell — in
PowerShell `$ASTERA_CLI` alone is an unrelated, empty variable, so do not take it as the check. Read
every example below with `astera` replaced that way if you need to. **Only** when the environment
variable itself is empty does it mean this session was not started by the app — in which case a new
session started by Astera is what gets you the command.

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
at once, pass `--run <run>` explicitly on every command (`task-create`, `tasks list` and `check`
accept it).

**Passing `--run` on `task-create` is worth doing even with one Run of your own.** The default is
whatever run was started last across the whole app, so a Job someone runs from the sidebar (or a
schedule that fires) between your `run-create` and your `task-create` becomes that default, and every
Task you create after it lands in their run. Nothing fails when this happens — the Tasks are simply somewhere else. Take the
id from `run-create --json` and pass it on every `task-create`.

**"It does no scheduling or batching" above is true only for a Run made through the syntax this
guide documents.** `run-create`'s server-side handler also reads `--concurrency` and
`--auto` — neither of which appears in its syntax line (4.1) — and `--auto` makes that Run dispatch and
place its own workers exactly the way a Run the app's Jobs sidebar created does, with no `worker-start`
from anyone. `--auto` also arms a start gate (`pendingStart`): such a Run holds still until `run-start`
clears it, which is the app's "Run" button in the job detail window. So a Run made this way does
nothing at all until that command lands. This guide does not document how to do that on purpose, but nothing at the CLI's own
argument parser stops you from passing them anyway (it accepts any `--flag value` for any command).
**A Run someone laid out in the app may be handed to you.** When the person presses Run on a Job they
built in the sidebar, the app starts a coordinator session — possibly you — and gives it that Run.
Such a Run comes with its Tasks, their dependencies, their accounts and their validation settings
already set. Run them as they stand: do not create Tasks, do not rewrite their specs, and do not
reassign their accounts. If the plan looks wrong, raise it with the person through `gate-create`
rather than editing around it. Your first prompt says which Run it is and repeats its limits.

So "the most recently created Run" (which `task-create` with no `--run` attaches to) can already be
one of these — whether the app made it that way or a coordinator did — and that is exactly the case
4.2's note on `parentId` warns about.

## 2. Eight Task states and their transitions

`pending → ready → dispatched → completed | failed`, plus `blocked` (a Gate), `validating` — a Task
created with `--validate` (4.2) passes through `validating` between `dispatched` and `completed | failed`
while the run happens — and `reviewing` — a Task created with `--review` (4.2) passes through `reviewing`
after a successful report (and after a passing validation, if both are attached) while another agent on a
different provider judges it.

| from | to | Trigger |
|---|---|---|
| `pending` | `ready` | all `deps` are `completed` |
| `pending`, `ready` | `dispatched` | `worker-start` |
| `pending`, `ready`, `failed` | `blocked` | `gate-create` (rejected if a Dispatch is open) |
| `blocked` | `ready` | `gate-resolve` (if the Task has more open Gates, all of them must be resolved too) |
| `blocked` | `failed` | **not in `ALLOWED['blocked']` — reached only by a table bypass**, the same kind `task-update` uses (section 8): `gate-resolve --resolution mark-failed` on an exhausted convergence Gate (`kind: "convergence-exhausted"`, section 11) writes `failed` directly, in the same commit that would otherwise have unblocked the Task to `pending`/`ready`. A coordinator watching Task status only ever observes the jump straight from `blocked` to `failed` |
| `dispatched` | `completed` | `worker_done --outcome succeeded`, when the Task has neither `--validate` nor `--review` (4.2) |
| `dispatched` | `validating` | `worker_done --outcome succeeded`, when the Task has `--validate` (4.2) |
| `dispatched` | `reviewing` | `worker_done --outcome succeeded`, when the Task has `--review` but no `--validate` (4.2) |
| `dispatched` | `failed` | `worker_done --outcome failed`, or the session dies without reporting |
| `validating` | `completed` | the validation run exits `0`, and the Task has no `--review` |
| `validating` | `reviewing` | the validation run exits `0`, and the Task has `--review` (4.2) |
| `validating` | `failed` | the validation run exits non-zero, **on a Run with no convergence policy** — the same retry path as any other failure. On a convergence Run (section 11) a failure is never routed here directly: it reaches `blocked` (an exhausted or unopenable repair, as a Gate) or back to `dispatched` (a repair) instead, and the only way this exact edge is taken is `task-update` — never `gate-resolve mark-failed`, whose own edge is `blocked` → `failed` below |
| `validating` | `dispatched` | **convergence Runs only** (section 11). A check failed and Astera (the app, or the Host while the app is closed) opened a repair Dispatch on the same worker, through `openRepairDispatch`. You did nothing to cause this edge and there is nothing to do about it but wait |
| `validating` | `blocked` | the validation cannot run at all — a Gate opens automatically. On a convergence Run this edge also covers a paused Run, a Task with `--convergence off`, a repair the app could not start, and the repair budget running out (section 11) |
| `reviewing` | `completed` | the reviewer reports `worker_done --outcome succeeded` |
| `reviewing` | `failed` | the reviewer reports `worker_done --outcome failed`, **on a Run with no convergence policy** — the same retry path as any other failure. On a convergence Run (section 11) this edge is reached the same restricted way as `validating` → `failed` above |
| `reviewing` | `dispatched` | **convergence Runs only** (section 11). The review found a blocking issue and Astera opened a repair Dispatch, through `openRepairDispatch` |
| `reviewing` | `blocked` | the review cannot run at all (no other provider has a usable account, or the reviewer dies without reporting) — a Gate opens automatically. Same convergence additions as `validating` → `blocked` above |
| `failed` | `dispatched` | `worker-start --retry-of <dsp>` (fewer than 3 consecutive failures) |
| `failed` | (terminal) | 3 consecutive failures — circuit break, no further retries |

There is no `dispatched → blocked`. Receiving `worker_done` puts the Dispatch into a terminal state
**automatically**, and the Task too — unless the Task has `--validate` and/or `--review` attached, in
which case success moves it to `validating` or `reviewing` instead of `completed` (below, and "When a
review is worth attaching"). Validation runs first: a Task with both only reaches `reviewing` once the
validation has passed. Either way, do not add anything after it (see section 10).

**There is also no second `worker-start` on a Task that is `validating` or `reviewing`.** This holds on
every Run, convergence or not: the table above has no edge out of either state for a plain
`worker-start`, and that Task has no open Dispatch to trip the usual "dispatch already open" check —
so, until this was closed, nothing stopped a second worker from landing on a Task that already had a
verdict pending. `worker-start` now refuses it by name, `400 task is awaiting a verdict: <status>`,
rather than failing on an opaque transition rejection. A convergence Run reuses this same refusal
(section 11) — it is not a new rule invented for convergence, just one convergence leans on.

### When a validation is worth attaching

Attach `--validate <configId>` (4.2) when the Task's outcome is provable by running something — a
build, a test suite, a lint or type-check — and skip it when the work is not: documentation, a spec, or
exploration have no exit code to judge them by, and forcing a run configuration onto that kind of Task
only adds a gate a human has to clear later for no reason. Decide per Task, not as a default for every
Task in a Run.

- **Success does not mean done.** `worker_done --outcome succeeded` on a validated Task moves it to
  `validating` instead of `completed` (table above) while the configuration runs. `worker_done
  --outcome failed` skips validation entirely — there is nothing to check when the worker itself says
  it did not finish.
- **The configuration runs where the worker actually worked.** It is looked up in the Run's project,
  but executed in the **dispatch's** working directory — a worker given its own worktree is judged on
  the tree it changed, not the project root.
- **Dependents wait.** A Task whose dependency is `validating` stays `pending`; only a passing
  validation releases it, never the worker's own report.
- **Exit code `0` completes the Task; non-zero fails it** the same way a failed worker would —
  `consecutiveFailures` climbs and the circuit still breaks at 3 — **on a Run with no convergence
  policy.** On a convergence Run (section 11) a non-zero exit never reaches `failed` directly: it goes
  back to `dispatched` (the app repairing it on the same worker, which does get the failure detail as a
  spec section) or to `blocked` (a Gate); `worker-start --retry-of` from you never enters into it. On
  the non-convergence path, the output tail is stored in the Task's `result`, but **a retry worker
  never sees it**: the spec file the app assembles for a worker carries only that Task's title and
  spec, so nothing a previous attempt produced — neither the validation output nor the earlier
  worker's report — reaches the next one. If the next attempt needs to know what failed, write it into
  the spec yourself.
- **Either outcome arrives in your inbox as a `status` message, whose exact subject depends on whether
  the Run has convergence on.** **On a Run with no convergence policy** it is `validation passed` or
  `validation failed`, with the exit code and the output tail in the body. **On a convergence Run**
  (section 11) a pass reads `All <n> checks passed` instead, and a failure that is about to become a
  repair reads `Checks failed: <name(s)> (<ran> of <total> ran)` (or `Checks failed (<ran> of <total>
  ran)` if none are named) — never the literal words `validation passed`/`validation failed`, so do not
  match on those on a convergence Run. That convergence-branch body carries only the exit code, not the
  output tail — read the failed check's own tail off the Task's `checks` field (`tasks list`, in
  `data.tasks[].checks`) instead. Either way, that message is what wakes `check`, so a validated
  Task is **not** settled when `worker_done` comes back — wait for its validation message before you
  decide what to dispatch next. (A validation that cannot run at all announces itself differently again,
  and the same way on every Run regardless of convergence: as a Gate's `decision_gate` message, never a
  `status` one.)
- **If the validation cannot run at all** — no such configuration, a required field empty, the
  directory gone, the app restarted mid-run, or the user stopping the validation run from the app's
  Run panel — the Task goes to `blocked` behind a Gate whose question says why. A stopped run is not
  counted as a failure: it means the work was never judged, not that it was wrong. That is a call for a person, not a silent pass and not a failure charged against the work.
- **If the directory is merely busy** with something else — another validation, or a run the user
  started by hand — the validation waits its turn rather than failing.

### When a review is worth attaching

Attach `--review` (4.2) to a Task whose requirement leaves room for interpretation. What a machine can
judge by running something — a build, a test suite — is `--validate`'s job; review exists for what that
cannot settle: whether the work actually does what was asked. **It costs one more agent session, so it
spends quota** — attaching it to a Task like a one-line documentation fix is the wrong call.

- **The app picks the reviewer, on a provider other than the implementer's.** A Task built on `claude`
  is never reviewed by `claude`. If no other provider has a logged-in, usable account, the Task goes to
  `blocked` behind a Gate instead of silently skipping the review.
- **Validation runs first.** A Task with both `--validate` and `--review` only reaches `reviewing` once
  the validation has passed (section 2's table) — the reviewer is not asked to re-judge whether the code
  compiles or the tests run.
- **A review failure rides the normal retry flow** — `worker-start --retry-of`, exactly like a validation
  or a worker failure — **on a Run with no convergence policy.** On a convergence Run (section 11) this
  never happens: `applyReviewResult`'s convergence branch routes a blocking review straight to a repair
  (`dispatched`, same worker) or a Gate (`blocked`), and the Task never reaches `failed` this way, so
  there is no `--retry-of` for you to call. On the non-convergence path, the `review failed` status
  message's body is the **only** record of what was missing; a retry worker's spec file does not carry
  it (the same limitation as validation, above), so pass on whatever the next attempt needs.
- **A review passing moves the Task straight to `completed`** and releases its dependents, the same as
  any other route to that state.

## 3. A supervision loop, end to end

```bash
# 1) Create the Run — always pass --cwd (see 4.1). --json returns its id; every task-create takes it
astera run-create --objective "refactor the auth module" --cwd "/abs/path/to/repo" --json

# 2) Check the accounts — a Task's --account decides which agent runs it, and it is required (4.2).
#    If which account to use was not stated and more than one could apply, ask before creating Tasks.
astera accounts --json

# 3) Create N Tasks — pass --run with the id from step 1 (see 4.2; the default is app-wide)
astera task-create --run run_9f8e7d6c5b4a3210 --account acc_main --title "consolidate types" --spec - --json <<'EOF'
Consolidate the core/auth types into one place. ...
EOF
astera task-create --run run_9f8e7d6c5b4a3210 --account acc_sub --title "add tests" --spec - --deps '["tsk_1a2b3c4d"]' --json <<'EOF'
Once the consolidation above is done, add regression tests. ...
EOF

# 4) Start N workers — the ids came from step 2
#    --worktree new **requires** --name (4.3) — without it the request is rejected with a 400
astera worker-start --task tsk_1a2b3c4d --agent claude --account acc_main --worktree new --name types-cleanup --json
astera worker-start --task tsk_5e6f7a8b --agent codex --account acc_sub --worktree new --name add-tests --json

# 5) Wait — blocks until worker_done, escalation, or question arrives (this can take tens of minutes)
astera check --wait --json

# 6) Ack only after handling every message in the batch (reply first if it was a question)
astera reply --id msg_9f9f9f9f --body - --json <<'EOF'
That path is correct. Carry on.
EOF
astera check --ack dlv_aaaa1111 --json

# 7) Clean up when done — reuse the session if there is follow-up work, otherwise release it
astera worker-start --task tsk_next --agent claude --account acc_main --terminal <sessionId> --json
astera worker-release --dispatch dsp_c3c3c3c3 --json
```

## 4. CLI reference

Arguments like `--spec`, `--body`, `--question`, and `--result` **read from stdin** when given the
value `-` (4.6). Every command already outputs JSON — the `--json` flag is accepted but makes no
difference to the output.

**`astera agent-context` prints this whole surface as JSON**, including every command below, with
each one's flags, the protocol version and the exit code table. It needs no Host and always exits 0.
Prefer it over this section when you want the list rather than the explanation: the command set in
it is held to what the program actually routes, so it cannot name a command this build does not
have. The flags in it are still written by hand, as they are here.

### 4.1 Run

```
run-create --objective <s> [--cwd <p>]
           [--convergence [--max-fix-attempts <n>] [--max-review-rounds <n>] [--blocking-severity <high|medium>]]
           [--json]
jobs list [--json]
jobs get --id <run> [--json]
run-use --id <run> [--json]        # confirms existence only; binds nothing (see section 1)
run-configs [--json]               # that Run's project's run configurations, [{ id, name, type }]
```

**Always pass `--cwd`.** Omit it and `astera` fills in **its own process's working directory** — that
is, the current directory of that shell. If that is not the repository root, every worker in that Run
(`--worktree current` being the default) comes up in the wrong directory, and nothing reports it.
Passing `--cwd <absolute repo path>` is the only reliable way.

**That path also decides where a human can see the Run.** The app's Jobs sidebar lists the Runs of the
project it currently has open, matched against `Run.cwd`. So a Run created with a `--cwd` pointing
somewhere other than the project your session belongs to still works — every command succeeds — but it
is invisible in that window until the user opens the project it names. If you are working on one
repository, pass that repository's root and open your session there.

`run-configs` returns the Run's project's run configurations as `[{ id, name, type }]` — the ids
`task-create --validate` accepts (4.2). It always reads the **most recently created** Run and takes no
`--run` flag, unlike `tasks list` and `check` (section 1). It changes no state, and unlike most commands
here it is **not** coordinator-only — a worker may call it to see what it will be judged by before it
starts.

**`--convergence` turns on completion convergence for this Run — read section 11 before using it.** In
short: a Task with checks or a review is no longer yours to retry when one fails; the app repairs it,
and several commands you would otherwise reach for are refused while that is happening.
`--max-fix-attempts`, `--max-review-rounds`, and `--blocking-severity` tune it and are rejected without
`--convergence` present — they do not imply it.

### 4.2 Task and Gate

```
task-create --title <s> --spec <s|-> --account <id,…> [--run <run>] [--deps <json_array>] [--validate <configId,…>] [--review] [--json]
tasks list [--run <run>] [--status <s>] [--ready] [--brief] [--json]
task-update --id <tsk> --status <s> [--result <s|->] [--json]   # bypasses the transition table — see section 8
task-update --id <tsk> --convergence off [--json]                # stops the app's own repairs on this Task — section 11
dispatch-show --task <tsk> [--json]        # that Task's Dispatch history in data.dispatches (retries and the app's review Dispatch included)

gate-create --task <tsk> --question <s|-> [--options <json_array>] [--json]
gate-resolve --id <gat> --resolution <s> [--json]
questions list [--task <tsk>] [--status <s>] [--json]
```

- What the server blocks for workers is `task-create`, `task-update`, `gate-create`, and
  `gate-resolve` (section 6, `COORDINATOR_ONLY`). `tasks list`, `dispatch-show`, and `questions list` are
  not rejected for workers, but a worker follows section 6 and only uses `send` and `ask`, so it never
  needs them.
- The target flag for `task-update` is **`--id`**, not `--task` — passing `--task` yields
  `400 --id is required`.
- Omitting `--title` fills it from the first line of the spec (cut at 80 characters).
- **A Task's `parentId` is reserved for the app, which is why `--parent` is no longer listed above.**
  `task-create` still accepts it, so nothing you already have breaks, but the app now reads that field
  as one specific marker: the integration Task it creates for itself when finished worktrees have to be
  merged back into the project folder before the next Task can start. Setting it makes the app misread
  your Task as that marker, and three things go wrong at once — it skips the merge step before starting
  that Task, it starts it in the project folder instead of its own worktree (the one combination the
  placement rule forbids, because parallel workers then overwrite each other), and it counts as the
  integration Task that already exists, so the real one is never created and the Task waiting on the
  merge waits forever. **This only reaches Runs the app drives itself** — the scheduler ignores every
  other Run — but `task-create` with no explicit run attaches to the most recently created Run, which
  can be one of those — pass `--run <run>` so it cannot. Use `--deps` to say what a Task follows;
  that is what the graph is built from (`--deps` orders Tasks, it does not choose their Run).
- **`--account <id>` or `--account <id>,<id>,…` sets the accounts this Task's worker runs on, in
  order, and it is required** — the ids come from `accounts` (4.3). **This list is the only thing that
  says which agent runs the Task.** A Run no longer carries a provider, so a Task with no accounts
  cannot be started by anyone: `task-create` rejects it, and the app's own scheduler skips it.
- **Every account in one `--account` list has to be the same provider** — `task-create` rejects a
  mixed list, naming both offending ids, the same way it rejects an empty entry (`a,,b`) or a repeated
  id (`a,a`). Two Tasks in the **same Run** may use different providers; that is the point of the
  provider living on the Task. It is one Task's list that may not mix.
- With more than one id, running into a usage limit moves the worker to the next account in the order
  given; with only one, there is nowhere to move, so it waits out the limit instead. If the first
  account in the list turns out unusable when the worker actually starts — unknown id, wrong provider,
  or not logged in — the Task does not fall back to the next one: dispatch fails and a Gate opens for
  you to resolve, the same as an unrunnable validation or review (section 2). Only accounts after the
  first are dropped in place like that.
- **When the person who asked for the Job did not say which account to use, do not pick one for them
  beyond the one unambiguous case.** Run `accounts --json` (4.3) first, then:
  - exactly one account exists → use it, and say which one you used;
  - they named a provider (or the work plainly requires one) and that provider has exactly one account
    → use it, and say which one;
  - anything else → **ask them, listing the accounts by label with their provider**, and wait. Do not
    create the Tasks first and fix the accounts afterwards: a Task's accounts decide which agent runs
    it, and picking on their behalf spends the quota they were saving.
- **`--validate <configId>` or `--validate <configId>,<configId>,…` makes this Task's completion depend
  on one or more run configurations**, not just the worker's own report — the ids come from
  `run-configs` (4.1). Omit it and nothing changes: `worker_done --outcome succeeded` completes the
  Task exactly as before. With it, that same report instead moves the Task to `validating` (section 2,
  which covers what happens next and when it is worth attaching). **A list runs in the order given, and
  the first failure stops it** — later configurations in the list report `not-run`, not `failed`; they
  never got the chance to say either way.
- **`--review` makes this Task's completion depend on another agent's judgement** — a value-less flag,
  the same shape as `tasks list --ready`. Omit it and nothing changes. With it, a successful report (and
  a passing validation, if `--validate` is also attached) moves the Task to `reviewing` instead of
  `completed` (section 2, which covers what happens next, when it is worth attaching, and what the
  reviewer sees).
- **`dispatch-show` also lists the review Dispatch the app started**, on a Task with `--review`
  (above). You did not open it and there is nothing to clean up on it: `worker-release` or
  `worker-stop` on that entry kills the reviewer's session mid-review, and because that command
  validates no state by design (section 8), nothing stops you. The Task then goes to `blocked`
  behind a Gate you have to answer. Release only the Dispatches you started yourself — a review
  Dispatch is the app's to end.
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
- Default: omitting `--worktree` means **wherever that Run works** — the Run's own worktree if the app
  has given it one, and `current` (the Run's `cwd`) if it has not. A Run you create and dispatch
  yourself has none, so for those the default is still `current`.
- **`--name <s>` is required with `--worktree new`** — it becomes the branch and directory name of the
  new worktree. Without it the request is rejected with `400 --name is required for --worktree new`.
  It is unused (ignored) with `--worktree current` or an explicit path.
- **The placement rule.** Referred to elsewhere in this guide and defined here. A Run's concurrency
  (`jobs get --id <run>`, defaulting to 3) decides where its workers belong:
  - **1 or less — sequential.** Omit `--worktree`. Every worker runs where that Run works, one after
    another.
  - **2 or more — parallel.** Pass `--worktree new --name <short-name>` so each worker gets its own
    worktree.

  **Why:** merging finished work back requires a clean tree, so two workers must never share one
  folder — they overwrite each other, and neither the commit obligation nor the merge step notices.
  Nothing rejects the wrong combination at the moment (resolving the intended folder happens after
  this command), so this one is on you.
- **Respect the Run's concurrency.** Never let more than that many dispatches be open in one Run at
  once. `worker-start` **rejects** the call that would exceed it with
  `409 run <id> is at its concurrency limit: <n> of <n> dispatches are open`, and a rejection costs
  you a turn — count the open ones first. The app's review dispatches are outside this count: a review
  is a step of a Task that has already run, not a new work item.
- **`--retry-of <dsp>` does not inherit placement.** Pass `--worktree`, `--agent`, and `--account`
  again — omitting them can retry with a different combination than the original attempt.
- **Convergence Runs (`run-create --convergence`, section 11).** In such a Run, a Task that carries
  `--validate` or `--review` is repaired by the app, not by you: its failures go back to the same
  worker as a spec section, its checks re-run, and `worker-start` on it is refused
  (`400 task is awaiting a verdict: <status>`) for as long as its status reads `validating` or
  `reviewing`; once the app's own repair Dispatch is open, the Task's status reads `dispatched` again
  and `worker-start` is refused the ordinary way instead (`400 dispatch already open: <id>`) — either
  way it is refused, only the message differs. Read section 11 in full before driving a convergence
  Run; this bullet is the pointer, not the reference.
- `--terminal <sessionId>` reuses an existing worker session. This is the only case where a new Task
  can be handed to the same session without `--retry-of` (see the example in section 5). The session
  must belong to a worker of the **same Run** as the Task being started; a session of another Run is
  refused with `403` and nothing is typed into it.
  **A Task placed into an existing session inherits that session's account chain, not its own.** The
  chain is fixed when a session starts, so a Task whose `--account` list differs from the list the
  session was started with can be moved onto an account it was never given — or have nowhere to move
  when the session was started on a single account. Per-Task account lists and `--terminal` do not
  mix: reuse a session only for Tasks that carry the same account list it was started with.
- A successful `worker-start` responds with `data` = `{ sessionId, cwd, specPath, dispatchId }`. That
  is where the `dispatchId` used by later commands comes from — record it (`.data.dispatchId`).
- **The app does not close a Dispatch that has been `worker-retain`ed.** After that, `worker-stop` is
  rejected with **409 `dispatch is retained`** (and the state does not change), and `worker-release`
  returns 200 but with **`"skipped": "retained"`** in `data` — meaning the session is still
  alive. **There is no command that undoes retention.** If that session really has to end, the user
  must close the tab themselves (at which point the app closes the Dispatch); to give up only the
  tracking, use `worker-abandon`. Mistaking a live session for a dead one and starting a new worker in
  the same directory with `--retry-of` puts two agents on the same files at once — hence the
  rejection.
- **On a convergence Run, `worker-release` refuses a Dispatch whose Task is still converging** —
  `409 task <tsk> is still converging — release after it completes`. Section 11 has the exact
  condition; do not read a 409 here as "retry the release," read it as "wait."
- `accounts` returns `data.accounts`, a list of `{ id, label, provider }`. **Looking the accounts up first and then choosing
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
- `help` takes no arguments. It works with no Host running. It reads this document from
  `--skills-dir` when given, else from `ASTERA_SKILLS`, else from the `resources/skills` folder of
  the Astera build the command belongs to, so it also works in a shell Astera did not start.

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

### 4.7 What comes back

**Every reply is an envelope.** One line of JSON, always one of these two shapes:

```json
{"ok":true,"data":{ … }}
{"ok":false,"error":{"code":"NOT_FOUND","message":"unknown run: run_x","details":{},"nextSteps":["astera runs list"]}}
```

**Everything this guide describes lives inside `data`.** Where a section says a command "responds
with `{sessionId, cwd, …}`", that object is `data`. Read `.data.sessionId`, not `.sessionId`.

**A list arrives under a name, not as a bare array.** The name is the noun:

| Command | Where the list is |
|---|---|
| `tasks list` | `data.tasks` |
| `questions list` | `data.questions` |
| `dispatch-show` | `data.dispatches` |
| `inbox` | `data.messages` |
| `run-configs` | `data.configs` |
| `accounts` | `data.accounts` |
| `jobs list` / `runs list` / `projects list` | `data.jobs` / `data.runs` / `data.projects` |
| `accounts list` / `run-configs list` / `sessions list` | `data.accounts` / `data.runConfigs` / `data.sessions` |
| `skills list` / `skills install` | `data.accounts`, each with its `skills` |

Anything else that returns a list gives `data.items`. A bare top-level array can never grow a field
without breaking every reader, which is why there are none.

`error.code` is for branching and `error.message` is for a person. The codes are the closed set in
the table below.

**`error.nextSteps` is for you.** It is always present, and its entries are command lines to run
rather than sentences to interpret. The steps depend on the command as well as the code, so a `4`
from `worker-show` offers `astera tasks list` then `astera dispatch-show --task <taskId>`, while a
`4` from `task-update` offers `astera tasks list` alone. Every step is one your session is allowed
to call: a `4` from `ask`, which a worker reaches, never suggests a coordinator-only command.

Where an id is already in `details` it is filled in, so the line can be run as it stands. A
placeholder still in angle brackets is one you supply. **Two lines can mean two different things**,
and the shape of the failure says which: where the second line needs a value the first produces, as
with `tasks list` before `dispatch-show --task`, run them in order; where they are alternatives, as
with the `8` that offers both `questions answer` and `runs resume`, `error.details.state` says which
one applies. An empty list means there is no one command that is right for this failure. Read
`message` and decide.

### 4.8 Exit codes

The exit code of `astera` is the only sound basis for deciding success or failure from `$?` in a
shell. Each `error.code` maps to exactly one of these:

| Exit code | `error.code` | Meaning |
|---|---|---|
| `0` | — | The command succeeded (`ok: true`) |
| `1` | `FAILED` | Something failed that none of the codes below describes |
| `2` | `INVALID_ARGUMENTS` | The parser refused, or the Host rejected the arguments (400) |
| `3` | `HOST_NOT_RUNNING` | The Host could not be reached, and this command is not one the state file can answer |
| `4` | `NOT_FOUND` | No such id (404) |
| `5` | `PERMISSION_DENIED` | Refused for this session (403) — e.g. a worker calling a coordinator command |
| `6` | `CONFLICT` | Rejected because of current state (409) — e.g. a Task that already has an open Dispatch |
| `7` | `TIMEOUT` | A deadline elapsed — this client's own, or the Host's `wait`, or a Host that is running and not answering |
| `8` | `WAITING_FOR_INPUT` | A `wait` stopped because a person is needed — a question is open, or the run is paused (see below) |
| `9` | `VERSION_MISMATCH` | The Host does not have that command — the CLI and the Host are different builds |
| `10` | `RUN_FAILED` | A Job or run finished in failure |

**`wait` is the only place `ok` reports the outcome rather than the call.** `jobs wait` and
`runs wait` hold one request open until the run ends, and the ending decides the exit code: `0`
finished well, `10` finished in failure, `8` stopped for a person, `7` the deadline passed. The
default deadline is an hour; `--timeout-ms` changes it. A `7` is not a failure of the Job — it is
this command giving up on waiting, and `error.details.progress` says how far it had got.

`8` (`WAITING_FOR_INPUT`) is what `jobs wait` and `runs wait` answer when a question is open **or**
the run is paused — both mean nothing moves until a person acts. `error.details.state` says which,
and for a question `details.questionId` is the one to answer.

**`3` and `4` are different questions.** `3` means the orchestrator is not reachable at all; `4` means it is there
and does not know that id. Do not retry a `4`.

**`3` and `7` are the two that mean "I do not know".** Every other code is a decision: the command
ran and this is what happened. These two say only that no answer came back — the connection dropped,
or the deadline passed with the Host still there — and the Host commits before it answers, so the
command may well have run. Do not read either as "it failed, do it again". Section 4.10 is what to
do instead, and the error itself carries the two commands to run.

**`9` is not your mistake.** It means the `astera` on the PATH and the running app came from
different builds. Report it rather than working around it.

**A timeout response from `check --wait` or `ask` is a success, so the exit code is `0`.** What
sections 5 and 6 say about "a timeout is not a failure" is carried directly by this rule — do not
treat a timeout as an error based on `$?`; read `data.timedOut`.

**A timed-out `ask` carries its own recovery in `data.nextSteps`.** That is the same kind of list as
`error.nextSteps` above — command lines to run, not advice — and for this answer it holds exactly one
line, the one that waits again on the question you already asked:

```json
{"ok":true,"data":{"answered":false,"timedOut":true,"questionId":"msg_ab12cd34",
                   "nextSteps":["astera ask --resume msg_ab12cd34"]}}
```

Run that line. Do not ask again: the question is still open and still in front of the same person, so
a second one is answered once and waited on twice (section 6).

**When the id is not there, the list is empty and `data.cannotResume` says why**, rather than handing
you a line you cannot run:

> the answer did not name the question, so this wait cannot be resumed safely; the question may still
> be pending, so do not ask again

**A `7` from `ask` is a different ending and says a different thing.** There the Host never answered
at all, so nothing came back to be missing an id — and this CLI cannot tell from the reply whether
your question was ever created. **The request id can**, and the message says so:

> no answer came back at all, so this wait cannot be resumed from here — but this call carried a
> request id, and `astera requests show --id <id>` says whether the question was created and what its
> id is. Run that before asking again: asking again risks a second question in front of the same
> person

Read the two apart. The first says a question exists and cannot be named; the second says the reply
told you nothing and the receipt is where to look. **One first move either way: do not ask again.**
Run the command in that message (4.10 is the whole of it); a `completed` receipt hands you the
`questionId` to `--resume`, and only an `absent` leaves you with nothing to resume — that is when to
tell your coordinator with `send --type escalation`. A `7` from `ask` that *was* a `--resume` carries
the id it was given, so its `nextSteps` already has the line to run.

### 4.9 While you wait

`ask`, `check --wait`, `jobs wait` and `runs wait` hold one request open for minutes at a time. While
they do, a line goes to **stderr** every 15 seconds:

```text
astera: waiting for ask, 45s so far; the Host answered 5s ago
```

It is there because a long silence and a wedged Host look identical from outside. The tail of the
line is the answer to that: the command asks the Host for a heartbeat while it waits and reports how
long ago it last answered. Past 15 seconds of silence the line says that instead, and then what you
are looking at is probably not a wait any more (`astera host status`).

**stdout is untouched** — it carries the one result, so nothing has to be filtered out of it.
`--no-keepalive` turns the lines off.

### 4.10 When you do not know whether it landed

Exit `3` and exit `7` are the two endings where no answer came back (4.8). The Host commits before it
answers, so between the work happening and the reply reaching you there is a window in which the
command ran and you were told nothing. A `worker-start` sent twice across that window is two agents
in one worktree.

**Every command carries a request id, whether or not you passed one.** When one of those two endings
happens, the error hands you that id and the two commands to run:

```json
{"ok":false,"error":{"code":"HOST_NOT_RUNNING",
  "message":"the Host closed the connection before answering worker-start",
  "details":{"requestId":"d9cea50f-d589-4cd8-8132-d1ab5e3fbfbf",
             "queryCommand":"astera requests show --id d9cea50f-d589-4cd8-8132-d1ab5e3fbfbf",
             "retryCommand":"astera worker-start --task tsk_9f2b --agent codex --account acc1 --worktree current --request-id d9cea50f-d589-4cd8-8132-d1ab5e3fbfbf"},
  "nextSteps":["astera host start","astera requests show --id d9cea50f-d589-4cd8-8132-d1ab5e3fbfbf"]}}
```

**Follow `nextSteps` in the order it gives them.** For a `7` the receipt question comes first, because
the Host is there and can answer it. For a `3` it comes second, behind `astera host start`, and that
order is deliberate: with no Host reachable, `requests show` is a second `3` and tells you nothing.

`retryCommand` is the line you ran with that id on it, for after you know. It is POSIX shell syntax —
bash, zsh and Git Bash; PowerShell reads the same quotes apart from a value containing a single quote
of its own, and `cmd.exe` does not read single quotes at all, so requote there. Nothing in it is left
where a shell would expand it, so pasting it cannot run anything but `astera`.

**A command that read part of itself from standard input gets `retryNote` instead of
`retryCommand`**, because there is no line to print: the payload was never on the command line, so a
printed line would carry a bare `-` and send an empty body. The note names the flags that read stdin
and the id to pass. Run what you ran, with `--request-id <that id>`, feeding the same text in the same
way. `queryCommand` is there either way.

**`astera requests show --id <id>` has three answers and all three exit `0`**, because not finding a
receipt is an answer rather than a failure. `data.interpretation` is the runtime's own sentence for
the one you got, and it is worth reading rather than deriving:

> **`completed`** — Request `<requestId>` already took effect (`<command>`). The recorded response is
> what this Host answered the first time. Treat it exactly as if you had received it then: the ids in
> it name things that exist. Do not send the command again.

`data.response` carries that answer whole, status and body, including an error body when what the
Host recorded was a failure.

> **`pending`** — Request `<requestId>` is running on this Host right now (`<command>`). Nothing is
> lost and nothing is decided: wait and ask again. Do not send the command again, because a second
> attempt while this one is in flight is refused with exit 6.

> **`absent`** — This Host holds no receipt for request `<requestId>` under your caller identity, and
> that is not proof that nothing happened. There are four ways to see it and only one of them means
> nothing happened: the request never reached a Host, and retrying is correct; it reached a Host that
> has since restarted, which comparing `hostStartedAt` with the time you sent it will tell you; you
> are asking under a different session than the one that sent it; or the command changed nothing, so
> there was nothing to record and retrying gets the same answer. Before retrying, look at the state
> rather than at the receipt, because the state is the only record that survives everything.

**That last sentence is the discipline.** Receipts live in the Host's memory and die with it, so
`absent` is the one answer that decides nothing. Look at the state instead: does the run exist
(`astera runs list --job <j>`), is the dispatch open (`astera dispatch-show --task <t>`), is the
question already answered (`astera questions get --id <q>`). With no Host running at all,
`requests show` is exit `3` like any other command that needs one, and for the same reason: there is
no receipt to have.

**Retrying is presenting the same id again.** `--request-id <id>` on any command says that this call
and the earlier one are one request. A command that already took effect is not done twice: the Host
replays what it answered the first time, the reply carries `"replayed": true` beside `"ok"`, and the
exit code is the original answer's — so a replayed `4` is still a `4`.

**`"observed": true` is a different word for a different thing.** `ask` and `check --ack <id> --wait`
commit and then wait, and a recorded timeout from one of them is not a fact about the world — it is
how long some earlier call waited. Handing that back would answer instantly out of somebody else's
stopwatch and leave you looping. So those two are not replayed from the record: the commit is not
repeated (no second question, no second ack), the command runs again, and the body is what is true
now. **Read an `observed` body as a first answer**, because it is one: a fresh `check` can hand you a
delivery, with a new `deliveryId` to ack, that nobody has seen.

**One id names one call.** Present the same id with a different command or different arguments and it
is refused with `2`, naming the command the id was first used for, rather than being answered with
somebody else's result. Changing only `--timeout-ms` is the same call: asking for more patience does
not change what you asked for.

**`--resume` and the request id are for two different things.** A `check --wait` or `ask` that times
out is a success (4.8) and tells you so; `ask --resume <questionId>` continues that wait, and its
`data.nextSteps` hands you the line. The request id is for the other case: **no answer came back at
all**, so you have no `questionId` and cannot tell whether the question was even created. Present the
id instead — no second question is created, and the reply says whether the answer has since arrived.
A timeout you expected is `--resume`; an answer you lost is the key.

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
- A timeout from `check --wait` (`data` = `{count:0, messages:[], timedOut:true}`) or an immediate
  `{count:0, messages:[]}` is **a checkpoint, not a worker failure.** Real coding work takes 15–60
  minutes. Keep waiting — just call `check --wait` again — unless you receive `worker_done` or
  `escalation`, the session is gone (confirm with `worker-show`), or the user tells you to stop. A
  timeout response also exits `0` (4.8), so do not misread `$?` as failure.

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
- **A worker started for a review Dispatch does not change code.** Its spec file says so explicitly —
  read the requirement, the implementer's report, and the changed files, then judge; do not fix
  anything you find wrong. It still reports exactly once, `worker_done --outcome succeeded` or
  `--outcome failed`, under **its own** dispatch id — not the implementation Dispatch's.
- **When stuck, `ask` (blocking).** If a judgement call, missing information, or a permissions problem
  is preventing progress, ask instead of guessing:
  ```bash
  astera ask --task-id <tsk> --dispatch-id <dsp> --question - --options "choice1,choice2" --json
  ```
  On `data` = `{"answered":true,"answer":"…"}`, proceed accordingly.
- **If `ask` times out, do not ask again — keep waiting with `--resume`.** The question stays pending,
  and re-asking is rejected (one unanswered question per Dispatch). The answer hands you the line to
  run, so take it from there rather than assembling one:
  ```bash
  answer=$(astera ask --task-id <tsk> --question - --json < q.txt)
  echo "$answer" | jq -r '.data.nextSteps[]'   # astera ask --resume msg_ab12cd34
  astera ask --resume msg_ab12cd34 --json      # and again, as many times as it takes
  ```
  A timeout is not a failure — nothing about the question changed, only this call gave up waiting on
  it. If `data.nextSteps` is empty, `data.cannotResume` says why (section 4.8); guessing an id from
  there waits on somebody else's question.
- **When ownership is still valid and the coordinator should step in but it is not blocking, use
  `escalation`** (non-blocking):
  ```bash
  astera send --type escalation --task-id <tsk> --dispatch-id <dsp> --subject "<summary>" --body - --json
  ```
- **A report the app cannot take is written down, not lost.** The app can be closed while a worker
  the Host keeps running finishes its Task. When the server cannot be reached at all, `worker_done`
  and `escalation` — and only those two — are appended to a queue in the app's profile, and the
  answer is `ok: true` with `data` = `{"queued":true,"applied":false,"path":"…"}` and exit code `0`.
  **`ok` there means the command ran, not that the report arrived** — `applied: false` is the half
  that says it did not. Read both halves: the
  report is safe. The Host applies it the next time it starts, with the app open or closed (with an
  older Host, the app applies it the next time it starts). Nothing in the Job has moved yet. Do not send it again and do not read it as the work having failed. Every
  other command still fails the way it always did — a file cannot answer an `ask`. A report the
  server would reject anyway (no `--outcome`, no `--task-id`, no `--dispatch-id`) is not queued: it
  fails as it always has, so fix it and send it again.
- After reporting, end your turn and wait at the agent prompt. Do not close the terminal yourself — if
  the orchestrator reuses it, new instructions arrive as input.

## 7. The four `worker-show` states and what to do

```
worker-show --dispatch <dsp> --json
```

| `workerState` | Meaning | What the orchestrator does |
|---|---|---|
| `ready` | Alive and working | Keep waiting (`check --wait`), or read output sparingly with `worker-read` |
| `failed` | Proven dead (abnormal exit or `outcome:failed`) | Retry with `worker-start --task <t> --retry-of <dsp> --agent … --account … --worktree …` — **unless this is a repair Dispatch** (`dispatch-show --task <tsk>` shows `repair` on it). A dead repair Dispatch, on a convergence Run, is the app's own recovery reconciler's to restart, not yours — that is the whole point of the app driving the loop (section 11). Retrying it yourself races the reconciler for the same worktree |
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

**Running into a quota limit is the app's problem now, not the coordinator's.** Every worker session
runs on a one-account rolling chain — its own account, alone. When that account's quota runs out, the
app reads the reset time out of the transcript, waits it out, and carries the work forward by itself.
The coordinator does not wait for it and does not retry; for a chain that recovers on its own, there
is nothing for the coordinator to do at all.

"Carries forward" is not "the same session" for every runtime — that has to be said per runtime, not
as a blanket fact:

| runtime | at the reset |
|---|---|
| `claude` | resumes in the **same live session** — no kill, no respawn, session id unchanged. The one exception: if the limit's choice list is still on screen when the reset arrives, it takes the codex row's path instead. |
| `codex` | kills the session and restarts it under a **new** session id |

Either way the Task and its Dispatch survive: when the session id changes, the app moves the Dispatch
onto the new one, so `worker-show --dispatch <dsp>` keeps resolving without the coordinator lifting a
finger.

Because of that, seeing `limitResetsAt` on a `worker-show` response is no longer the ordinary shape of
running into a quota limit — it is now the narrower, rarer case where this worker's session genuinely
died and rolling did not carry it through. The app parsed that fact out of the session transcript, and
it also arrives in the inbox as a `status` message.

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
- **Silence matters more here than anywhere else in this guide.** The rule directly above — heartbeats,
  terminal activity, a `check --wait` timeout, and an idle TUI are not failure signals — is now
  load-bearing: a chain riding out a reset can go quiet for hours, and that quiet is exactly what
  waiting looks like from outside.
- **`worker-stop` cancels the app's own wait, too.** Stop a worker that is riding one out and the
  coordinator is back to owning the timing itself: retry with `--retry-of` only after the reset time,
  or the early attempt counts as one of the circuit breaker's three strikes.
- **The app appends a `## Resume briefing (assembled by the app — do not delete)` section to the
  worker's own spec file whenever riding out a quota limit costs the worker its process** — always on
  codex, and on claude when the chain moves to a different account. It replaces any earlier one
  instead of stacking, so the spec file never grows a history of them. That section is the app's, not
  yours — do not write it, edit it, or delete it. When the process survives the wait (the usual case
  for a single-account claude worker) the app adds nothing to the file; it just tells the worker what
  changed while it waited, because the worker's own conversation is still intact.

## 8. Cleanup after completion — the orchestrator decides

The app does not infer completion from observation alone, and it does not close sessions
automatically. After receiving `worker_done`, pick one of these **yourself**:

- **If the same agent has follow-up work**, reuse the session:
  ```bash
  astera worker-start --task <next> --agent <same agent> --account <same account> --terminal <sessionId> --json
  ```
  (Even with `--terminal`, `--agent`, `--account`, and `--worktree` must be given again — placement is
  not inherited. **Re-read `sessionId` from `worker-show --dispatch <dsp>` right before you reuse it**
  — a roll changes it, and on codex a roll always does (section 7), so the id you were given when the
  worker started may name a session that no longer exists.)
  **The account chain is the one thing a reuse does inherit** (4.3): the follow-up Task rolls along the
  list the session was started with, whatever its own `--account` says. Reuse a session only for Tasks
  that were given the same account list; otherwise start a fresh worker.
- **If there is no follow-up**, clean up with `worker-release --dispatch <dsp>`. Call it after both
  success and failure reports — it is after-the-fact cleanup, not cancellation. Only the session that
  Dispatch owns is closed; a reused session, a session the user took over, and a session whose
  ownership cannot be proven are all preserved.
- **If the user asks to keep it alive for debugging**, `worker-retain --dispatch <dsp>` — it is
  recorded as an exception rather than silently skipped. After that, `worker-stop` is rejected with 409
  and `worker-release` returns `skipped: "retained"` (meaning no session was closed). **There is no
  command that undoes it** — see 4.3.

**Do not try to move a Task's state by hand after `worker_done`.** `worker_done` already settles the
Dispatch, and the Task too — to a terminal state (`completed`/`failed`) directly, or through
`validating` first if the Task has `--validate`, and through `reviewing` if it has `--review`
(both, in that order, when it has both — section 2).

`task-update --id <tsk> --status <s>` is **not for the normal flow.** It bypasses the state transition
table, so use it only as an escape hatch for a stranded Task — for example, a Task stuck at `failed`
by a circuit break (3 failures) that a human has checked and wants corrected to `completed`. Calling
it leaves a record of the bypass in the app log. Once corrected, Tasks that depended on it move to
`ready` automatically.

**`task-update` resets that Task's `consecutiveFailures` (the circuit counter) to 0.** So even a Task
whose circuit opened after 3 failures can be dispatched again after
`task-update --id <tsk> --status ready` — because it means a human checked the cause and cleared it.
This is the only escape hatch that opens the circuit. The other paths to a zero counter all end at
`completed` and are unreachable while dispatching is blocked: a worker's `worker_done --outcome
succeeded` on a Task with neither `--validate` nor `--review`, a validation that exits `0` on a Task
with no `--review`, and a passing review. **Reaching `validating` or `reviewing` does not reset it** —
otherwise a Task that never passes them would go 0 → 1 on every attempt and the circuit would never
break.
**Do not reach for it out of habit without checking the cause** — that makes the circuit breaker
meaningless and repeats the same failure indefinitely.

## 9. Do not — summary

- Do not conclude a worker failed from a `check --wait` timeout or `data.count === 0` (section 5).
- Do not kill a worker over heartbeats, terminal activity, or an idle TUI (section 7).
- Do not try to move state by hand after `worker_done` (section 8).
- If `ask` times out, do not re-ask — run the line the answer hands you in `data.nextSteps`, which is
  `--resume <questionId>` (sections 4.8 and 6).
- `worker-start --retry-of` does not inherit placement — pass `--worktree`, `--agent`, and `--account`
  again (4.3).
- Do not try to call `check` or `inbox` from a worker session — they are rejected. Use only `send` and
  `ask` (section 6).
- Do not treat a `worker-retain`ed Dispatch as dead — `worker-stop` returns 409 (4.3).
- Do not guess accounts — confirm a real id with `accounts` first (4.3).
- Do not choose a Task's account for someone who did not name one, unless there is only one it could
  be — ask instead (4.2).
- Do not exceed a Run's concurrency, and do not put parallel workers in one folder — the placement
  rule (4.3).
- Do not restructure a Run a person laid out in the app (4.1) — run it as it stands, or open a Gate.
- Do not move a quota-killed worker **to a different account.** Retry on the same account after
  `limitResetsAt` (section 7).
- Do not write, edit, or delete a worker's `## Resume briefing` section in its spec file — the app
  owns it (section 7).
- On a convergence Run, do not `worker-start` or `worker-release` a Task while it converges — both are
  refused — and do not `task-update` it either, even though that one is not refused (section 11).
- Do not resolve a `convergence-exhausted` Gate yourself — `retry-once`/`mark-failed` is a person's call
  (section 11).
- Do not `sessions send` without a `sessions read` right before it. The text answers whatever prompt
  the other session shows, a folder-trust or first-run screen included (12.3).
- Do not send anything again after exit `3` or `7`. Follow `nextSteps` in its order (4.10): after a
  `7` that is `requests show`, after a `3` it is `astera host start` first, then `requests show`.

## 10. Environment variables

| Variable | Value | Applies to |
|---|---|---|
| `ASTERA_CLI` | Absolute path to the CLI executable. Its directory is prepended to this session's PATH, so `astera` works too | Orchestrator and workers alike |
| `ASTERA_PROFILE_DIR` | Absolute path to the Astera profile folder this app is running on. `astera` derives the Host's address from it, and writes a report it could not deliver into that profile's queue | Everyone (except `help`, which needs no Host) |
| `ASTERA_SESSION` | This session's app session id — the caller's identity | Everyone |
| `ASTERA_SKILLS` | Absolute path to the directory holding this document | Everyone (`help` reads it from there) |

**Two more variables exist, and neither is set for you.** `ASTERA_HOST` points `astera` at one
specific Host by address; it overrides the address derived from `ASTERA_PROFILE_DIR` and **nothing
else** — the state file and the report queue still come from the profile. `ASTERA_PROFILE=dev`
selects the development profile when neither of the other two is set. So the order is: the profile is
`ASTERA_PROFILE_DIR` if set, otherwise the platform's folder for `ASTERA_PROFILE`'s app name; and the
address is `ASTERA_HOST` if set, otherwise the one derived from that profile. Inside a session the app
sets `ASTERA_PROFILE_DIR` and you should not override any of the three.

**Only this session's PATH is modified** — the app does not touch the user or system PATH. So a shell
the app did not start has no `astera`, and even if it did, it owns no Dispatch and can do nothing as a
worker. On win32 the shuttle is two files (`astera.cmd` for cmd and PowerShell, the extension-less
`astera` for bash — MSYS bash does not consult PATHEXT). On macOS and other posix platforms it is a
single extension-less `astera` file. Calling `astera` works from any shell, and when it does not,
the path in the `ASTERA_CLI` environment variable always does — `"$ASTERA_CLI"` in bash or zsh,
`& $env:ASTERA_CLI` in PowerShell.

An empty `ASTERA_CLI` means this session was not started by the app — start one from Astera. Use this
value too whenever a script needs the absolute path.

**Stub installation**: at server startup the app installs the stub into **both claude and codex**
accounts at `<configDir>/skills/astera-orchestration/SKILL.md`. `AGENTS.md` is a user file and is left
alone. **Both runtimes were verified to recognise this file as a skill** — it can also be invoked
directly as `/astera-orchestration`. Skills load at session start, so it does not appear in sessions
that were already open before installation.

## 11. Convergence Runs

**A Run without `--convergence` (4.1) is unchanged by everything in this section.** A validation or
review failure still ends the Task at `failed`, `worker-start --retry-of` is still yours to call, and
nothing here applies. Everything below is about a Run created with `--convergence` — and even there,
a Task with neither `--validate` nor `--review` is unaffected too: convergence only changes what
happens when a check or a review fails.

**What it means.** On a convergence Run, a Task with `--validate` and/or `--review` does not settle
its own failure. Astera does, the app or, while the app is closed, the Host. When a check fails, or a
review finds a blocking issue, Astera sends the failure back to the **same worker session** as a new
section of its spec file and reruns the Task's checks; a `worker-start --retry-of` from you never
happens for this Task. You see this as a `status` message whose body says
`repair <k> of <maxFixAttempts>`. That is Astera working, not a report going missing.
**Do not start a worker for a converging Task, and do not try to retry it yourself** — there is
nothing for you to retry; wait for the next message.

**Turning it on.**
```
run-create --objective <s> --convergence [--max-fix-attempts <n>] [--max-review-rounds <n>] [--blocking-severity <high|medium>]
```
- `--convergence` alone turns it on with defaults: `--max-fix-attempts 3`, `--max-review-rounds 2`,
  `--blocking-severity high` (a `critical` or `high` review issue blocks; `medium` also blocks only if
  you pass `--blocking-severity medium`).
- The three knobs **require `--convergence` on the same call** — `run-create` rejects
  `--max-fix-attempts`/`--max-review-rounds`/`--blocking-severity` with no `--convergence` (400):
  passing a knob is not itself enough to turn convergence on, and a silent no-op here would read as
  "I configured it" when nothing was configured.
- It cannot be turned on for a Run that already exists, and there is no `run-update` for it — decide at
  `run-create` time.
- `jobs get --id <run> --json` echoes the policy back as `.convergence` (absent means off) if you need
  to check what a Run you did not create was given.

**What ends a repair loop.** Two ways, and only one of them is yours to act on:
- **It converges.** The checks all pass, or the review comes back with nothing blocking. You get a
  `status` message — subject `All <n> checks passed`, or `Review approved` (`Review approved (<n>
  non-blocking note(s))` if the reviewer left any, with the notes themselves in the body, not the
  subject) — and the Task reaches `completed` (or `reviewing` first, if both are attached — section 2's
  order is unchanged). Nothing further needed.
- **It exhausts its budget.** More than `--max-fix-attempts` consecutive check failures, or more than
  `--max-review-rounds` review rounds. This opens a Gate with `kind: "convergence-exhausted"` and
  `options: ["retry-once", "mark-failed"]` on `questions list`/`gate-create`'s response shape — **read the
  `kind` and `options` fields, not the Gate's `question` text**, which is written in whatever language
  the app is set to. **This is a person's decision, not yours.** `retry-once` opens exactly one more
  repair outside the normal budget; `mark-failed` moves the Task to `failed` the way `task-update`
  does, bypassing the transition table, without touching `consecutiveFailures` — it is being given up
  on, not rescued. Do not call `gate-resolve` on this Gate yourself; let the person answer it in the
  app, the same as any other Gate you would raise rather than decide (section 1).

**What is refused while a Task is converging, and why.** A repair keeps the Task on the same worker on
purpose — close that session now and the next one starts fresh, having forgotten what it just tried —
so the two commands that would pull that worker or its Dispatch out from under the repair are refused:
- **`worker-start` on the Task.** While its status reads `validating` or `reviewing`, it is refused
  with `400 task is awaiting a verdict: <status>` (this refusal applies on every Run, convergence or
  not — see section 2). Once the app has opened the repair Dispatch, the Task's status reads
  `dispatched` again, and `worker-start` is refused the ordinary way instead —
  `400 dispatch already open: <id>` — because that Dispatch is now open and belongs to the repair.
  Either phrasing means the same thing here: leave this Task alone.
- **`worker-release` on that Dispatch.** Refused with
  `409 task <tsk> is still converging — release after it completes` whenever the Run has convergence on
  and the Task is `validating`, `reviewing`, or has any not-yet-ended repair Dispatch open on it —
  releasing now would close the very session the next repair is about to reuse, and the worker on the
  other end would lose the context of what it just tried. Wait for the Task to leave that state, then
  release as usual (section 8).
- **A repair Dispatch that dies is not yours to retry either.** `worker-show` on it reads `failed` the
  same as any dead session (section 7), but the app's own recovery reconciler already treats a
  convergence Run's repair Dispatches as its own to redispatch — retrying it yourself with
  `worker-start --retry-of` races the reconciler for the same worktree. Check `dispatch-show --task
  <tsk>` for a `repair` field before retrying anything that came back `failed`; if it is set, leave it
  to the app.
- **`task-update` on the Task is not refused, but do not use it anyway.** Nothing in the server checks
  convergence before applying a `task-update --status` — it still bypasses the transition table the
  way section 8 already describes. Using it on a converging Task moves the Task out from under a
  repair the app still believes is running, which is exactly the "escape hatch for a stranded Task"
  section 8 warns against reaching for without checking the cause first — a converging Task is busy,
  not stranded.

**A person can turn convergence off for one Task**, with `task-update --id <tsk> --convergence off`
(the only value accepted; there is no `on` — a Task otherwise follows its Run). This does not cancel a
repair already running: that one finishes, and only its *next* failure changes course — instead of
opening another repair it opens an ordinary Gate (`kind: "convergence-blocked"`) for a person, the same
`blocked` state a validation or review that cannot run at all already uses (section 2). `--convergence`
and `--status` are rejected together on one call (400) — issue them as two calls if you need both, so
each result is unambiguous.

**`--validate`'s comma list (4.2) is what convergence repairs run against.** The list runs in the order
given, in every Run, and the first failure stops it; on a convergence Run that first failure is what
gets sent back to the worker, named by its configuration's `name` — the ones after it never ran.

## 12. The public commands an agent uses

Everything above is what a coordinator and its workers use inside one Run. `astera` also has a public
surface, the one `docs/cli.md` describes, and a few of its commands are for you as well. They reach
what lies outside the Run you were handed, or outside any Run: a Job a person will start later,
another agent session, the skills installed in an account. **They are not a second way to drive your
own Run.**

| When you need to | Use | Not |
|---|---|---|
| plan work that a person, not you, starts later | `jobs create`, then `tasks add --job` | `run-create`, whose Run is yours to drive now |
| know which accounts exist, before `tasks add --account` or `--coordinator-account` | `accounts list` | a guessed id |
| know the ids `tasks add --validate` takes | `run-configs list --job <jobId>` | `run-configs`, which reads the latest run's project |
| see what another agent session is doing, or give it one short message | `sessions list`, `sessions read`, then `sessions send` | `worker-read` and `worker-start --terminal`, which are for your own Dispatches |
| find out why an Astera skill is missing, and put it back | `skills list`, `skills install` | copying a `SKILL.md` by hand |
| learn whether a call whose answer you lost took effect | `requests show` | sending it again |

`astera <noun> <verb> --help` prints one command's flags, and it needs no Host.

### 12.1 When not to use them

- **A coordinator inside its Run keeps using section 4.** `task-create --run`, `worker-start`,
  `check`, `worker-show`, `worker-read` and the rest. `tasks add --run <run>` reaches the same Run, but
  it adds nothing a coordinator needs, and one vocabulary per Run is easier to read back.
- **A Run someone laid out in the app gets no new Tasks from `tasks add` either** (section 1). Raise a
  plan you think is wrong with `gate-create`.
- **A worker uses none of this except `requests show`**, which answers a worker's own lost `send` or
  `ask` the same way (4.10). `jobs create` and `tasks add` go through `run-create` and
  `task-create`, so a worker is refused them with exit `5`, the same boundary as section 6. A worker
  talks to its coordinator with `send` and `ask`, never by typing into a session.
- **Do not type into your own workers.** A worker's next instruction is a Task, given with
  `worker-start --terminal <sessionId>` (section 8). Text typed with `sessions send` is outside every
  Dispatch: no Task records it and no `worker_done` answers it.
- **Do not type into your own session.** `$ASTERA_SESSION` is your own id, and `sessions list` lists
  you too. Text sent there arrives as input to you.
- **Do not create a Job for work you are about to do yourself**, and do not start one someone asked
  you only to plan. `jobs create` runs nothing; starting it is the person's call, and it spends their
  quota.
- **Do not reach for `skills install` to switch a skill on.** It installs what the app's settings
  already enable and nothing else. A skill whose setting is off comes back in `data.notEnabled`
  with the setting that turns it on: tell the person, and let them decide.

### 12.2 Planning work for later: `jobs create` and `tasks add --job`

```bash
# 1) Which accounts exist. The account rules of 4.2 apply here unchanged: ask when it is not clear
astera accounts list --json

# 2) The plan. Nothing runs; it comes back marked pendingStart with no run. Its id is .data.id
astera jobs create --objective "migrate the payment module" --cwd "/abs/path/to/repo" --json

# 3) The ids --validate takes, if a Task's result can be checked by running something (section 2)
astera run-configs list --job job_4f2a --json

# 4) Its Tasks. Each comes back with its own id in .data.id; --deps takes those ids
astera tasks add --job job_4f2a --account acc_main --title "move the types" --spec - --json <<'EOF'
Move the payment types into src/payments/types.ts. ...
EOF
astera tasks add --job job_4f2a --account acc_main --title "add tests" --spec - --deps '["tsk_1a2b3c4d"]' --validate <configId> --json <<'EOF'
Once the types have moved, add regression tests. ...
EOF
```

- **Pass `--cwd` with the repository root**, for the same two reasons as section 4.1: it decides
  where the workers run and which window's Jobs sidebar shows the Job.
- **`tasks add` takes exactly one of `--job` or `--run`**, with no default. A Job id given to `--run`,
  or a run id given to `--job`, is a `4`, never quietly the other kind.
- **Then say what you made.** The person sees the Job in the Jobs sidebar, waiting to be run, and
  starts it there. `jobs run --id <jobId>` starts it from here, and is theirs to ask for.

### 12.3 Another session: `sessions list`, `sessions read`, `sessions send`

```bash
astera sessions list --json
astera sessions read --id <sessionId> --json
astera sessions send --id <sessionId> --text "Please rebase on develop before you push." --request-id <an-id-you-choose> --json
```

`sessions list` gives each session's `id`, `kind` (`terminal` or `chat`), `title`, `accountId`,
`cwd`, `alive` and `state`. `state` is `working`, `waiting` or `unknown`, and `waiting` only says
that the session stopped at a prompt: it does not say which prompt.

**`sessions send` types into whatever the other session is showing.** The text and the Enter answer
the prompt on the screen, whatever it is. **Read the screen with `sessions read` right before every
send**, and send only when it shows the agent's own input prompt. These were measured on a real
Claude Code session:

- **In a folder it has not seen, Claude Code first asks whether to trust the folder, and the answer
  under the cursor is "No, exit".** Text and Enter there end the session.
- **On Claude Code's first-run theme picker, a digit picks a theme and the Enter after it takes the
  next screen's default, which starts a login** and tries to open a browser to sign in.
- **At a permission prompt, your text is the answer to the permission.**

If the screen shows any of these, do not send. Tell the person what the session is waiting on.

**Keep what you send short.** Measured on the same Claude Code session: a one-line send is submitted,
and `state` goes from `unknown` to `working` to `waiting` as that turn runs; text with a line break in
it is submitted as one message, not split. A long text (about 2,000 characters) is submitted too, but
Claude reads text typed that way as pasted content, and it hedged on an instruction inside it as
something it had not been told directly. So when the other session needs a lot of context, write it
to a file and send one short line that names the file.

**A chat session takes a send as one turn.** With Astera open, a chat session that is waiting on an
approval or a question card refuses the send with exit `6` and names the card; `sessions send` does
not answer cards, and nothing was sent. **With Astera closed you cannot see a card**: `sessions read`
has no `pending` then, and the send is not refused. Your turn waits behind the card in the agent and
runs once someone answers it in Astera, so "sent" does not mean the other session has read it yet. A
session that has ended is a `6` as well.

**Pass `--request-id` on every send, with an id you choose.** A retry with the same id is replayed:
the Host answers what it answered the first time and types nothing a second time.

**Exit `3` and exit `7` mean "I do not know whether it was typed", not "it failed".** Do not send
again. Follow `nextSteps` in the order it gives them (4.10): after a `7` that is the receipt, after a
`3` it is `astera host start` first, because with no Host the receipt question is a second `3`:

```bash
astera requests show --id <requestId> --json
```

A `completed` receipt is the answer the send got, and that answer can be a recorded refusal: read
`data.response`, which holds the Host's `status` and `body`. Only a `2xx` status whose body has
`"sent": true` means it was typed; a `409` is a refusal, and nothing was sent. A `pending` one means
it is being typed right now: ask again in a moment. After an `absent`, read the screen before you
decide anything, because the screen is then the only record of whether the text arrived.

### 12.4 A missing skill: `skills list` and `skills install`

```bash
astera skills list --json
astera skills install --json
```

- **Use them when a skill the person expects is not there**, for example `/astera-browser` not
  found, or right after an account was added: a new account gets no skills until the app restarts.
- `skills list` changes nothing. Per account it gives each skill's `enabled` (whether its setting is
  on) and `installed` (`current`, `stale`, `missing` or `not-ours`).
- `skills install` writes only what the settings enable, and leaves a file Astera did not write
  exactly as it is (`skipped-not-ours`). Any `failed` makes it exit `1`.
- **A session that is already open never sees a skill installed after it started**, and that includes
  yours. Say so, and suggest a new session.
- Both answer from the profile's files, with no Host and no app. They refuse `--request-id` with exit
  `2`; running `skills install` twice is safe anyway, because the second run writes nothing.
