# The `astera` command

`astera` is Astera's command line interface. It reads and drives the same Jobs, runs, tasks and
questions the app shows, from an ordinary shell or from CI.

It is the same program as the app. The command is a small shuttle script that runs the installed
Astera binary in Node mode, so the CLI and the app can never be different versions of each other.

## Install

1. Open **Settings → Agents**, and under **Command line tool (astera)** click **Install the astera
   command**.
2. The panel names the folder it wrote to: `%LOCALAPPDATA%\astera\bin` on Windows,
   `~/.local/bin` on macOS and Linux.
3. If that folder is not on your `PATH`, the panel shows one line to add it and a **Copy** button.
   Run that line once, then open a new shell.

Astera never edits your shell profile. The line is shown for you to run, so that the change is one
you made and can find again.

Check the install:

```bash
astera version
```

Sessions that Astera itself starts already have the command on their `PATH`. The install button is
for shells the app did not start.

## The Host

Commands are answered by the **Astera Host**, a background process that owns the orchestration
state. The Host outlives the app: quit Astera and your workers keep running, and `astera` keeps
answering.

```bash
astera host status     # is a Host running, and on which profile
astera host start      # start one if none is running
astera host stop       # ask the running Host to retire
```

`astera host start` is idempotent. A Host that is already running is success, not an error.

`astera host stop` refuses while the Host still holds sessions or running **runs**, and says how many.
That refusal is the Host protecting work in progress. Stop the work first, then stop the Host. The
refusal is exit 6 (`CONFLICT`), and the counts are in `error.details.sessions` and
`error.details.runs`.

A Host that accepts the stop first lets any worker or coordinator start it is in the middle of
finish, for up to 20 seconds, and takes no new one. `host stop` therefore waits up to 35 seconds for
it to go: those 20 seconds, then the 15 seconds of silence after which a Host is called stuck. A
Host that is still there after that is exit 7 (`TIMEOUT`), with the wait in `error.details.waitedMs`.

**The three `host` commands fail the way every other command does**, with `"ok": false`, an
`error.code` and `error.nextSteps`, and with the `error:` sentence under `--human`. Until 2026-09-24
their failures printed `"ok": true` with the details under `data` and only the exit code saying
otherwise. A script that read `.data.stopped` or `.data.sessions` off a refused `host stop` reads
`.error.details` now. `host stop` with no Host running is still a success: nothing was running, and
nothing is.

A run, not a Job: a Job with two runs going at once counts as two, because two things are running.
A run is running while it has work in flight: a worker session open on one of its tasks, or a task
being validated or reviewed. A run whose tasks have not started yet is not. Neither is one whose
workers were all stopped, unless one of its tasks is still being validated or reviewed. `runs stop`
closes the run's worker sessions and pauses it, but it does not end a validation or a review, and a
paused run with such a task still counts. The Host finishes that task itself (with a Host that does
not announce `dispatch`, Astera does, when it is next open). Until then `host stop` refuses over that
run. `astera status` reports the same count as `runsRunning`.

A Host with no client connected leaves by itself after a minute, but only when it holds no sessions
and no running run, by that same count. A worker the Host started is one of its sessions, so the Host
stays while that worker runs (see "Workers with Astera closed" below). A Host that `astera host start`
started and that has started no worker holds nothing, and leaves a minute after its last client.
That includes a run that is waiting on a question: an open question does not keep the Host up.
**So with Astera closed, run `astera host start` before `astera questions answer`**; without a Host,
`questions answer` exits 3.

`astera host status` reports `jobsInProfile`, which is a different number — how many Jobs the
profile's file holds, running or not.

**Some commands still answer with no Host running**, by reading the state file on disk, which is
accurate precisely because no Host is writing it. It is a fixed list, and it is per verb, not per
noun:

```text
status
projects list | get | find
jobs     list | get
runs     list | get
tasks    list
questions list | get
```

Everything else needs a Host and exits 3 without one. That includes every command that changes
something (`jobs create`, `jobs run`, `tasks add`, `runs stop`, `runs resume`, `questions answer`,
`sessions send`)
and both waiting commands (`jobs wait`, `runs wait`), which a static file cannot answer however long
they wait.

**`astera status` is on that list, so its exit code does not say whether a Host is running.** With
no Host it answers 0 with `"running": false`, read from the file, and 3 only when the profile has no
state file yet. A script that needs to know reads `.data.running`, or the exit code of
`astera host status`: 0 when a Host is running, 3 when none is. With no Host, `host status` puts what
it looked at (`profile`, `jobsInProfile`) in `error.details`. When a Host of another protocol serves
the profile, both `status` and `host status` answer 9 (see Exit codes).

**From a Host that announces `dispatch`, `astera status` also says who places the work.**
`data.driver` is `host` when the Host places workers and runs checks itself. It is `app` when an older
Astera is open and does that work itself. It is `parked` when the Host waits for Astera to be opened
once: the profile's settings still carry work that the old orchestration switch paused, and only
Astera can release it. A damaged `app-settings.json` parks the Host too, until Astera is restarted and
repairs the file. Astera itself does not show that the Host is parked. `data.appAttached` says whether
Astera is connected. A Host that does not announce `dispatch` leaves both fields out.

`skills list` and `skills install` are outside both lists: they never contact a Host and never need
one. They read the profile's `accounts.json` and `app-settings.json` and work on files in each
account's config folder, so they answer the same with Astera and the Host running or not.

**The account list works with the app closed.** `accounts list`, `tasks add` (it checks every
`--account`) and `jobs create --coordinator-account` ask the app for its accounts when it is open.
When it is closed, the Host reads the profile's `accounts.json` instead, which is the file the app
keeps them in. The Host only reads that file and never changes it. If the file is damaged, those
three commands exit 6 and the message says to open Astera, which repairs it. `error.details.repair`
names the file.

**The run configurations work with the app closed too.** `run-configs list` and `tasks add
--validate` (it checks every id) ask the app when it is open, and the app answers for the Job's own
folder even when no session has run there yet. When it is closed, the Host builds the same list the
app would: the configurations saved in the profile's `run-configs.json` for the Job's folder, and the
ones that folder's `package.json`, Gradle, Maven, `Cargo.toml` or `go.mod` gives. It only reads. A
damaged `run-configs.json` is a 6 with the same "open Astera" message.

**The sessions commands work with the app closed, and need a Host.** `sessions list`, `sessions read`
and `sessions send` are answered by the Host out of the sessions it holds, because the Host is the
process that runs them. That is true with Astera open as well, with two exceptions for chat sessions:
while Astera is open, `sessions read` asks it which card a chat session is waiting on, and
`sessions send` hands a chat turn to it to deliver. With no Host there are no sessions to answer
about, so they exit 3.

### Workers with Astera closed

**With Astera closed, the Host starts and stops workers itself.** These coordinator commands work from a
shell with only a Host running: `worker-start`, `worker-start --worktree new`, `worker-stop`,
`worker-release` and `worker-read`. So does `run-start`, which starts a Job's coordinator again, and
`jobs run` of a Job with a coordinator account and no schedule, which starts the new run's coordinator,
for the first run and for every later one. If a later run's coordinator fails to start, that run stays
without one, and the error names `astera run-start --run <jobId>`, which starts it. Running `jobs run`
again does not help, because it is refused while that run is running. Either way, the Host
makes the run's worktree itself if it does not have one yet. If the coordinator then fails to start, the
Host removes that worktree again, and the failed start still answers the same way it always did. A
`worker-start --worktree new` whose worker then fails to start has its new worktree removed the same
way. A failed start that leaves nothing behind keeps no receipt: no agent started, and any new worktree
it made was removed by the Host itself. Once the cause is fixed, such as a damaged `app-settings.json`,
the same command with the same `--request-id` really starts. A failed start that left its worktree in
place, because something was still using it, keeps its receipt and replays its answer. So does one whose
worktree an older Astera removed, one that still makes and removes worktrees itself: the worktree is
gone, but the receipt is kept, so use a new `--request-id` for the retry. They are the commands a
coordinator session uses, and `astera help` describes them. The Host starts the agent in a session it
holds, keeps its output, and ends it when asked. When such a worker ends on its own, its Dispatch is
closed all the same: by the Host while Astera is closed, and by Astera once it has taken the session
back. Open Astera later and it shows those workers as tabs. With Astera open, a worker the Host starts
gets its tab at once.

**The Host also merges and removes worktrees itself.** `run-merge`, and `run-delete --merge` or
`--remove-worktrees`, all work the same way with only a Host running. A merge into the project folder
follows the same checks whoever runs it. The Host writes down each merge it makes, so one made while
Astera is closed does not show on the Work Unit screen as a change from outside. `run-delete` on a Job
that fires on a schedule closes its open workers and merges before a folder removal can be refused:
after that refusal, nothing about the Job or its runs is deleted, but the workers are already closed and
the merge has already happened.

**`astera host status` says whether this Host can do this.** `spawn` in `data.features` means it can
start and stop workers, and `worktrees` in `data.features` means it can make, merge and remove them
itself. `dispatch` means it also places the workers of a Job with no coordinator and runs their checks
(see below). A Host started by an older Astera does not have these, and neither does one whose starter
could not name the files a worker needs. With such a Host, these commands need the app as they did
before.

The Host reads the permission setting, **Run agents without permission checks**, from the profile's
`app-settings.json` at every start. With no such file it uses the app's default, which is on. A
damaged file refuses the start with exit 6 and `error.details.repair`, rather than guessing. A start
that reaches a Host that is stopping is refused with 6 and `error.details.retry` (see Output).

A damaged `worktrees.json` refuses the commands that make or remove a worktree the same way, with exit
6 and `error.details.repair` naming the file. Quit and reopen Astera, or restart the Host, to repair
it. A copy of the damaged file is kept as `worktrees.json.bak`. Merging does not read that file, so
`run-merge` still works while it is damaged.

**What still needs the app.** Each of these is exit 6 with a message that says the app is needed,
and nothing is started or changed:

- `worker-read` of a worker Astera started. Astera keeps that output, not the Host. The Host reads
  only the workers it started.
- `worker-stop` and `worker-release` of a worker that ran inside Astera itself, which Astera does only
  when it could not reach the Host. Only Astera can end it. Its Dispatch is not marked stopped.

With an older Astera open, one that does not yet make and merge worktrees itself, worktree work is
still that Astera's. It, not the Host, makes and merges the worktrees these commands need.

**Removing a worktree folder is refused while an Astera that writes `app.pid` is running somewhere but
not connected to this Host.** The Host cannot see what a session, a terminal or a run that app is
driving on its own is doing in that folder, so it will not delete the folder out from under it. The
command ends with exit 6, and the message says to remove the worktree from the app instead, or to quit
Astera and try again. This refusal happens before anything is touched, so it leaves no receipt behind:
quitting Astera and running the same command with the same `--request-id` then really removes the
folder. A refusal that comes after some folders were already removed does leave a receipt, since the
command has acted by then. A crashed Astera does not count as running, so this only happens while
Astera is genuinely still open somewhere. Only this version of Astera and newer write `app.pid`; an
older Astera running unattached is invisible to this check (see "Known limits after S3" in the design
doc).

A worker Astera started in a Host session is the Host's to end, so with Astera closed `worker-stop`
and `worker-release` still work on it.

**Jobs run with Astera closed.** With a Host that announces `dispatch`, a Job with no coordinator
runs with Astera closed. The Host places its workers, merges their worktrees, and runs the `--validate`
checks, the `--review` reviews and, in a `--convergence` Job, the repairs. So `runs wait` ends
`completed`, or `waiting` (8) when a question needs a person. Scheduled Jobs still fire only while
Astera is open, and a run that a schedule fires is not placed automatically. With a Host that does not
announce `dispatch`, no worker is placed while Astera is closed, and a `runs wait` holds until its
deadline and ends with 7.

**The Host runs the checks itself.** A task added with `--validate` or `--review` moves on after its
worker reports done, with Astera open or closed. A validation run the Host starts appears in Astera's
run panel when Astera opens, and stopping it there stops it in the Host. A Host that is stopped or
replaced while a check runs does not count that check as failed. The next Host starts it again in a
`--convergence` Job, and otherwise opens a question about it.

**A worker lost while Astera is closed opens a question.** When a worker ends without reporting while
Astera is closed, in a run with no coordinator session, the Host opens a question on its task, and
`runs wait` ends with 8. That includes a worker Astera saw before it closed, which Astera might
otherwise have started again by itself when it next opened. A run with a coordinator leaves the lost
worker to the coordinator.

**A worker that hits its usage limit while Astera is closed waits.** Its session stays open and its
task stays in progress, so `runs wait` ends at its deadline with 7. When Astera opens, it takes the
session back and moves it to the next account the task lists. Only Astera moves a session to another
account. A task can list several accounts, in the order to move through: `tasks add --account a,b`.

**While Astera shows the Host as not answering, Jobs wait.** Astera does not take over from a Host
that announced `dispatch`, even while that Host is not answering, because the Host may still be
working. So nothing is placed until the Host answers again or stops. The status bar says **Host not
answering**; the Jobs sidebar does not say why nothing moves. If it stays that way, restart the Host
from **Settings → Info**.

**Stopping a worker.** `worker-stop --dispatch <id>` ends the worker's session and marks its Dispatch
stopped. `runs stop --id <runId>` does the same for every open worker of a run, and pauses the run.
Both refuse with 6, and end nothing, while a worker is still starting: the message is `the worker is
still starting; try again in a moment`, and the answer is to run the same command a few seconds later.
That refusal lasts only two minutes from the start. A start older than that is taken as one that died,
and the stop closes its Dispatch without ending anything. Both also refuse a Dispatch held by
`worker-retain`. A worker that only Astera can end (the list above) is found only as `runs stop`
reaches it, so `runs stop` can end the workers before it and then refuse. Run it again with Astera
open.

In Astera, **Stop** on a worker the Host started ends it in the Host, and counts only once the Host
confirms the session ended. If the Host does not confirm, Astera says it could not stop the worker,
and the task stays open.

Stop your workers before `astera host stop`. The Host refuses to stop while it holds sessions, and
each worker it started is one.

What a worker the Host starts inherits from the Host's environment is under Security.

### Which Host, and which profile

Three environment variables decide this. Inside a session Astera starts, the app sets the first one
and you should leave all three alone.

| Variable | What it does |
|---|---|
| `ASTERA_PROFILE_DIR` | Absolute path to the Astera profile folder. The Host's address, the state file and the queue of undelivered reports all come from it. |
| `ASTERA_HOST` | Points at one specific Host by address. It overrides the address and nothing else. |
| `ASTERA_PROFILE` | Set it to `dev` to select the development profile when neither of the other two is set. |

The order is: the profile is `ASTERA_PROFILE_DIR` when set, otherwise the platform's folder for the
app name `ASTERA_PROFILE` selects. The address is `ASTERA_HOST` when set, otherwise the address
derived from that profile.

The profile travels rather than the address alone, because an address does not say which profile the
Host behind it uses, and the report queue and the state file are both properties of the profile.

The Host's address is derived from the text of the profile path, so two spellings of one folder would
name two Hosts. Separators are normalised for you before that happens: on Windows a forward slash
becomes a backslash, and a trailing separator is dropped on every platform, so `C:/Users/…/astera`,
`C:\Users\…\astera\` and `C:\Users\…\astera` all reach the same Host.

**Letter case is not normalised**, and on Windows it is the one spelling that still matters:
`c:\users\…` and `C:\Users\…` are the same folder to Windows but different Hosts to Astera. If you
set `ASTERA_PROFILE_DIR` by hand, copy the path rather than typing it. `astera host status` prints
the profile it resolved, which is how to check.

Two more variables exist inside sessions Astera starts: `ASTERA_CLI` is the absolute path to this
command, and `ASTERA_SKILLS` is the folder `astera help` reads its guide from. Outside a session
`astera help` and `astera browser help` read the guides that ship with the installed Astera instead.

## Command reference

Every command is a noun and a verb. A noun with no verb is rejected with the list of its verbs, so
`astera jobs` tells you what `jobs` can do.

**A flag that a command does not take is refused with exit 2.** The message names the flag and lists
the flags the command does take, and `nextSteps` is that command's `--help`. Nothing is mapped to a
flag it resembles, so `--timeout 30m` is refused rather than read as `--timeout-ms`. The global flags
(`--json`, `--human`, `--quiet`, `--no-keepalive`, `--request-id`) are never refused as unknown,
though a command can still refuse one for its own reason, as the `host` and `skills` commands do
with `--request-id` (below). The
commands agents use inside sessions (see the end of this section) are not checked this way: the guide
and sessions started by older builds pass them flags they ignore, and refusing those would break a
running coordinator over a flag that never did anything.

```text
astera version                           CLI, app and protocol versions
astera status                            is the orchestrator there, and what is running

astera host    status | start | stop

astera projects list
astera projects get   --id <projectId>
astera projects find  --path <absolute path>

astera jobs    list
astera jobs    get    --id <jobId | runId>
astera jobs    run    --id <jobId>
astera jobs    wait   --id <jobId>  [--timeout-ms <n>]
astera jobs    create --objective <text> [--cwd <path>] [--concurrency <n>] [--coordinator-account <accountId>] [--convergence [--max-fix-attempts <n>] [--max-review-rounds <n>] [--blocking-severity <high|medium>] [--max-total-minutes <n>]]

astera runs    list   [--job <jobId>]
astera runs    get    --id <runId>
astera runs    wait   --id <runId>  [--timeout-ms <n>]
astera runs    stop   --id <runId>
astera runs    resume --id <runId>

astera tasks   list   [--run <runId>] [--status <s>] [--ready] [--brief]
astera tasks   add    [--job <jobId> | --run <runId>] --spec <text|-> --account <id,…> [--title <text>] [--deps <json array>] [--parent <taskId>] [--validate <configId,…>] [--review]

astera accounts list  [--agent <claude|codex>]

astera run-configs list --job <jobId>

astera skills  list    [--account <accountId>]
astera skills  install [--account <accountId>]

astera sessions list
astera sessions read   --id <sessionId> [--lines <n>] [--turns <n>]
astera sessions send   --id <sessionId> --text <text|-> [--no-enter]

astera questions list  [--task <taskId>] [--status <open|resolved>]
astera questions get    --id <questionId>
astera questions answer --id <questionId> --answer <text>

astera requests show   --id <requestId>

astera help                              the orchestration guide, in full
astera agent-context                     every command this binary can route, as JSON

astera browser js     [--script <text> | --file <path>]
astera browser help                      the agent browser guide
```

`astera help` is the reference agents read.

**`astera agent-context` prints the command surface as JSON**, for a caller that is a program rather
than a person. It covers every command this binary can route, not only the public ones above: the
commands a coordinator or worker session uses are in it too, marked `"public": false`, with their
flags. It also carries the protocol version and the exit code table. Like `--help` it needs no Host
and always exits 0.

The value of asking the binary is that the answer cannot be older than the binary. A document can
say a flag exists after it has been removed; this cannot. One limit is worth knowing: the **command
set** is held to what the program actually routes by the compiler, but the **flags** are written by
hand, because no command in this program declares its flags anywhere a machine could read them.

**`--help` prints usage, at three levels.** It is plain text, it exits 0, and it never contacts the
Host, so it answers with nothing running.

```text
astera --help                 every command, one line each
astera jobs --help            what the jobs noun can do
astera jobs wait --help       that one command, what it does, and its flags
```

`-h` is the same as `--help`. Note that `astera help`, with no dashes, is a different command: it
prints the whole orchestration guide, which is a reference for agents rather than usage text.

A command a coordinator or worker session uses answers `--help` as well, with the entry
`agent-context` prints for it: `astera worker-release --help` shows its flags, which is where a
refused `host stop` sends a person.

**`jobs get` takes either id.** Give it a Job and it folds in that Job's latest run; give it a run
and it folds in that one. A Job is the plan, a run is one execution of it. Jobs that only ever run
once never need the `runs` commands.

**A list narrowed to an id that does not exist is a 4, not an empty list**: `runs list --job` with
an unknown Job, and `tasks list --run` with an unknown run. An empty list would read as "that Job
has no runs". `nextSteps` is the list that gives the missing kind of id, `astera jobs list` and
`astera runs list` respectively. `runs list --job` given no value (`--job ""`, as a script whose id
came back empty would send) is a 2, not the list of every run.

**`jobs run` refuses a Job that is already running** and names the run that is going. It returns the
run it started, which is the id to pass to `runs wait`.

**`jobs create` makes a plan and runs nothing.** It returns the Job, marked `pendingStart`, with no
run. Add its tasks with `tasks add --job`, then start it with `jobs run`. This is what **New job** in
the app does. `--cwd` defaults to the directory you ran the command from. Give `--coordinator-account`
to have a coordinator session drive the Job once it runs; without it the workers are placed for you.
A Host that announces `dispatch` places them whether Astera is open or closed, and otherwise Astera
does (see "Jobs run with Astera closed").

**`tasks add` takes exactly one of `--job` or `--run`**, and there is no default. `--job` adds a task
to the plan, and `jobs run` copies it, with its `--deps` pointing at the copies, into every run it
starts from then on. `--run` adds a task to one run that already exists. The flag decides which: a run
id given to `--job`, or a Job id given to `--run`, is a 4, never quietly the other kind. The ids
`--account` takes come from `accounts list`, first one first, the rest in the order to fail over to.
`--validate` names the run configurations that must pass on the worker's result before the task counts
as done; the ids come from `run-configs list --job`, comma-separated. An id that is not one of that
Job's is a 4, and `nextSteps` is `astera run-configs list --job <jobId>` with the Job filled in.

**`run-configs list --job <jobId>` prints `id`, `name` and `type`** for each run configuration of the
Job's folder: the ones the app's Run menu shows there, saved and detected. Nothing else about a
configuration is printed, so its command and environment stay in the app. A run id is a 4, as it is
for `tasks add --job`. Saved configurations belong to a folder exactly as the Job names it, so create
the Job from the project root (or pass `--cwd` with the root). With Astera running, `jobs create` moves
a subfolder of a project the app knows up to that project's root; with Astera closed it keeps the
folder as given, and a Job made from a subfolder then lists only what that subfolder's build files give.

**`accounts list` prints `id`, `label` and `provider`** for each account the app holds, and nothing
else about them. `--agent claude` or `--agent codex` narrows it to one vendor.

**`skills` manages the agent skills Astera installs into each account**: the files that tell an agent
session about `astera`, and about the features switched on in the app. There are four.
`astera-orchestration` is always on. `astera-task`, `astera-browser` and `astera-handoff` follow
**Work unit tracking**, **Agent browser** and the **Smart Resume** resume strategy in Settings. The app
installs them itself at launch and when a setting is turned on; these two commands are for checking,
and for the times it has not yet done so. `--account <accountId>` narrows either to one account, and
an id that is not in `accounts list` is a 4. A damaged `accounts.json` or `app-settings.json` is a 6,
and the message says to open Astera, which repairs it. Repairing `app-settings.json` keeps the
damaged copy as `app-settings.json.bak` and writes every setting back at its default, with one
exception: permission prompts are turned on ("Run agents without permission checks" is off), because
the damaged file may have had them on. Astera tells you when it opens. Neither command writes to either file. A
missing `app-settings.json` is not an error: it reads as every setting at its default, which is off.

`skills list` reports, per account, every skill with `enabled` (whether its setting is on) and
`installed`: `current`, `stale` (an older copy Astera wrote, which `install` would replace),
`missing`, or `not-ours` (a file at that place that Astera did not write). It changes nothing.

```json
{"ok":true,"data":{"accounts":[{"id":"acc_1","label":"Work","provider":"claude","skills":[
  {"name":"astera-orchestration","enabled":true,"installed":"current"},
  {"name":"astera-browser","enabled":false,"installed":"missing"}, …]}]}}
```

`skills install` writes what the current settings enable and nothing else. **A skill whose setting
is off is never installed**, because the setting is your consent: the browser skill lets an agent
drive a browser on your behalf. Each installed skill comes back with `result`: `written`, `unchanged`,
`skipped-not-ours` (a file Astera did not write is left exactly as it is), or `failed` (the reason is
on stderr). **Any `failed` makes the command exit 1**, with the whole answer in `error.details`, so
`astera skills install && …` stops there. `skipped-not-ours` is not a failure and exits 0. `data.notEnabled` names each skill left out and the setting that turns it on. It removes
nothing, including a skill whose setting you have since turned off. Running it twice is safe: the
second run is all `unchanged`.

```json
{"ok":true,"data":{"accounts":[{"id":"acc_1","label":"Work","provider":"claude","skills":[
  {"name":"astera-orchestration","result":"written"}]}],
  "notEnabled":[{"name":"astera-browser","setting":"Settings → Agents → Agent browser"}, …],
  "note":"Sessions already open do not pick up new skills; open a new session to use them."}}
```

**Agent sessions read their skills when they start**, so a session already open does not see a
skill installed after it, and `data.note` says so. Open a new session.

**`sessions` reaches the agent sessions the Host holds**: each tab in which Astera runs Claude Code
or Codex, and each chat session. A session's id is the one `ASTERA_SESSION` holds inside it, and
`sessions list` prints it beside `kind` (`terminal` or `chat`), `title`, `accountId`, `cwd`,
`alive` and `state`. Ended sessions stay listed with `alive: false` until the Host stops. Plain shell tabs and run
configurations are not agent sessions, and are not listed.

**`state` says whether a session is `working`, `waiting` or `unknown`.** The Host reads it from the
hook event file that the session's own Claude Code hooks append to, `hook-events/<sessionId>.jsonl`
in the profile. The hooks run inside the agent, so the file keeps growing while the app is closed.
The Host only reads the file. The event that happened last decides. Each line carries the time its
hook started (`astera_at`), and the Host goes by that time rather than by where the line sits,
because two hooks can finish writing in either order (see below). A line with no time, written by an
older Astera, and two lines with the same time are taken in the order they were written.

| Latest event | `state` |
|---|---|
| a prompt went to the model (`UserPromptSubmit`) | `working` |
| a tool call started or returned (`PreToolUse`, `PostToolUse`) | `working` |
| Claude asked a question (`PreToolUse` of `AskUserQuestion`) | `waiting` |
| the turn ended (`Stop`), or an API error such as a usage limit ended it (`StopFailure`) | `waiting`: the session waits for its next prompt |
| a notification that this session is waiting on you: a permission prompt, an MCP server's question, or "waiting for your input" | `waiting` |
| any other notification: something finished, a background agent or a teammate asking for input or permission (these can arrive while the session's own turn runs), a type Astera does not know, or one with no type | `unknown` |

Everything else is `unknown`:

- **Codex sessions.** Codex runs without the hooks, so it has no event file.
- **Chat sessions.** Their status is in the chat protocol, which only the app reads.
- **Ended sessions.**
- **Sessions with no event yet.** Claude Code writes no event when a session starts, and the app
  clears the folder each time it launches. A session reads `unknown` until its first event after that.
- **Sessions typed into since their last event.** After anything is typed into the session (by you
  in the tab, by the app, or by `sessions send`), the last event can no longer answer until the next
  one lands. This covers an answer to a permission prompt, an Esc that interrupts a turn (which fires
  no `Stop`), and a local command such as `/clear` or `/model`, which fires no event at all. A
  prompt you submit reads `unknown` for the moment it takes its `UserPromptSubmit` event to land
  (about a tenth of a second), then `working`. What the tab's terminal writes by itself does not
  count as typing: focus changes and its answers to the agent's own queries. Mouse clicks and wheel
  scrolls over a session that tracks the mouse do count, because a click can answer a dialog.
- **A last line that is not a whole event**, because it is still being written or is not JSON.

`waiting` means the last event left the session at a prompt, with nothing typed since. It does not
say what the prompt is. Read the screen before you answer it.

Where the hooks cannot see, `state` can lag or be wrong:

- **Sessions started before this version of Astera** have only the hooks they started with: no
  `UserPromptSubmit` and no `StopFailure`. Claude Code reads the hook settings Astera gives a session
  once, when the session starts, and does not watch that file afterwards, so restarting or updating
  Astera does not add hooks to a session that is already running. Such a session usually reads
  `unknown` while a turn runs, and a turn ended by an API error leaves its last tool event standing,
  `working`. Astera cannot tell these sessions apart from newer ones. Open a new session, or resume
  the old one in a new tab, to get the hooks.
- A permission dialog reads `working` for its first few seconds. Claude Code sends the permission
  notification only once the dialog has been up that long.
- A prompt queued while a turn is ending can read `waiting` for a moment, until its own
  `UserPromptSubmit` lands.
- `UserPromptSubmit` and `StopFailure` are written by two separate background processes, so their
  order in the file is not guaranteed: a turn that fails almost as soon as it is submitted can write
  its `StopFailure` first, and a prompt sent right after a failed turn can write its
  `UserPromptSubmit` before that turn's `StopFailure`. The time on each line puts them back in order.
  Two events that start within a few milliseconds of each other can still come out the wrong way
  round, and then the session reads as if the earlier one came last, until the next event or until
  you type. The times are trusted only within five seconds of each other: two lines further apart
  than that, as after the computer's clock is set back, are taken in the order they were written.
- Hooks of your own in the account's settings run alongside Astera's. One that blocks a prompt leaves
  `working` standing until you type, and a `Stop` hook that makes Claude carry on leaves `waiting`
  standing while it works.

**`sessions read` shows what the session's tab shows.** The Host replays the session's recent output
into a terminal emulator at the tab's current size and returns what that terminal displays:
`data.screen` is the visible rows, top first, with the empty rows below the last painted one left
off, and `data.scrollback` is up to `--lines` rows (default 200, at most 10000) from just above the screen, oldest
first. Each row is the text of its cells with trailing spaces trimmed; colours and other styling are
not included. `data.cols` and `data.rows` are the size it was rendered at. `--human` prints the
scrollback and then the screen, one row per line.

```json
{"ok":true,"data":{"id":"…","kind":"terminal","alive":true,"cols":100,"rows":30,
  "screen":["D:\\repo>echo hi","hi","","D:\\repo>"],"scrollback":["Microsoft Windows [Version …]"]}}
```

The Host keeps about 256,000 characters of each session's output while it runs, so scrollback goes
back only that far, and its oldest rows can be garbled where that window starts in the middle of a
sequence. Output from before the tab was last resized is shown at the current width. The Host drops
the output when a session ends, so an ended session reads as empty.

**A chat session reads as its conversation.** `data.kind` is `chat` and `data.turns` is the most
recent `--turns` turns (default 20, at most 200), oldest first. Each has `role` (`user` or
`assistant`), `text` (its text, paragraphs separated by a blank line, empty for a turn that only
ran tools) and `tools`, one line per tool call: the tool, what it acted on, and `(ok)` or
`(failed)` once its result is in. The Host reads the file the agent itself writes, the same file
Astera's conversation view reads: a Claude session's transcript in its account's folder, a Codex
session's rollout. So it works with Astera closed and still reads after the session has ended. A
session that has not finished its first turn has no file yet and reads `"turns": []`. `--lines`
belongs to terminal sessions and `--turns` to chat sessions; giving a session the other one is a 2.

```json
{"ok":true,"data":{"id":"…","kind":"chat","alive":true,
  "turns":[{"role":"user","text":"why does the build fail?","tools":[]},
           {"role":"assistant","text":"Fixed. The build passes.","tools":["shell_command npm run build (failed: exit 1)","apply_patch src/a.ts (ok)"]}],
  "pending":{"kind":"approval","summary":"Bash: npm test"}}}
```

**`data.pending` is there only while Astera is open.** A chat session asks for approvals and
questions through cards, and only the app holds them. With Astera open, `pending` is the card the
session is waiting on (`kind` is `approval` or `question`, and `summary` is one line about it), or
`null` when there is none; it is left out for a session Astera has not taken back yet after it
starts. With Astera closed the field is left out, because the Host cannot see cards: a session
waiting on one then looks like any other. `--human` prints each turn under its
role, the tools as `[tool]` lines, and the card last.

`sessions send` types `--text` into a terminal session and presses Enter 150ms later, which is how
the app delivers a scheduled message; `--no-enter` types the text and stops there. It answers
`{"id":…,"sent":true,"enter":true}` once the Enter has gone out, and `sent` means the Host handed the
text to the session. Two sends to one session are typed one after the other, never interleaved.
`--text -` reads the text from standard input and drops one trailing newline, so a heredoc is typed
once and Enter is pressed once. **It types into whatever the session is showing**: if the agent is
waiting at a permission prompt or a menu, the text and the Enter answer that prompt. Read the screen
first. A session that has ended is a 6. With `--request-id`, a retried `sessions send` is replayed
rather than typed a second time.

**To a chat session, `sessions send` is one turn**, and it answers `{"id":…,"sent":true}`.
`--no-enter` belongs to terminal sessions and is a 2 here. Sends to one session go one at a time.

- **With Astera open, the app delivers the turn**, the same way it delivers a scheduled message, so
  the conversation view shows it as usual. If the session is waiting on a card (an approval or a
  question), the send is a 6 whose message names the card. `sessions send` does not answer cards:
  open Astera and answer it there. Nothing was sent then, so the same `--request-id` can be used again
  once the card is answered. For a few seconds after Astera starts, a session it has not taken back
  yet is a 6 too, with nothing sent; try again in a moment.
- **With Astera closed, the Host writes the turn to the agent itself.** For a Claude session that is
  the same line the app would write. For a Codex session the Host sends only the text on the
  session's thread: no model, reasoning effort or plan mode, so whatever the thread currently has
  applies, not what is picked in Astera's composer. The Host cannot see cards, so a turn sent while
  the session waits on one queues behind it in the agent and runs once the card is answered. When
  Astera opens again it rebuilds the session from the agent's output and transcript, and the turn
  is there. A Codex session that has not started its first thread yet cannot take a turn from the
  Host, and that is a 6 that says so; nothing was sent, so the same `--request-id` works once the
  thread exists.

**`runs stop` is reversible, which is why it is not called cancel.** It closes the run's open worker
dispatches and pauses the run. `runs resume` clears exactly that. It refuses while a dispatch is
held open on purpose.

**`wait` has four endings**, and two of them are a person: the work finished well, the work failed,
a question is open, or the run is paused. The exit code says which. The default deadline is one
hour; `--timeout-ms` changes it, and reaching it is exit 7 with the progress so far, not a failure
of the Job.

**A command can fail without telling you whether it landed**: exit 3 when the connection dropped
before the answer came back, exit 7 when the deadline passed with the Host still there. Both leave
the question open, because the Host commits before it answers.

**Every command already carries a request id**, minted per invocation whether or not you passed one,
and those two failures hand it back in `error.details` with the two commands to run:

```json
{"ok":false,"error":{"code":"TIMEOUT","message":"the Host did not answer ask within 31000ms — …",
  "details":{"requestId":"d3e3fe89-…",
             "queryCommand":"astera requests show --id d3e3fe89-…",
             "retryCommand":"astera ask --task-id tsk_1 --question 'shall I go on?' --request-id d3e3fe89-…"},
  "nextSteps":["astera requests show --id d3e3fe89-…","astera host status"]}}
```

`queryCommand` asks what became of it; `retryCommand` is the line you ran with that id on it, for
after you know. **Follow `nextSteps` in the order it gives them**: after a 7 the receipt question
comes first, and after a 3 it comes behind `astera host start`, because with no Host reachable
`requests show` is a second 3.

**A command that read part of itself from standard input gets `retryNote` and no `retryCommand`.**
The payload was never on the command line, so a printed line would carry a bare `-` and send an empty
value; the note names the flags that read stdin and the id, and what to do is run the same command
again with that id and the same input. `queryCommand` is there either way.

**Both lines are POSIX shell syntax** — bash, zsh, and Git Bash on Windows, which is where `astera`
is usually run from. PowerShell reads the same quotes, apart from a value that contains a single
quote of its own. `cmd.exe` does not read single quotes at all, so a value with a space in it has to
be requoted there. Nothing in either line is ever left where a shell would expand it, so pasting one
cannot run anything but `astera`.

**`--request-id <id>` presents an id**, which is how a retry says that two calls are one request. Use
it with an id an error handed back, or choose one up front so a CI step is idempotent by
construction. A command that already took effect is not done twice: the Host replays the answer it
gave the first time, so a retrying script sees the run it created rather than a second one. A
replayed answer carries `"replayed": true` beside `"ok"` and exits with the original answer's code,
so a replayed 4 is still a 4.

**`"observed": true` is the other answer to an id you had already used, and it means something
else.** A command that commits and then waits, such as `ask` or `check --ack <id> --wait`, is not
replayed from the record: handing back a recorded timeout would answer out of an earlier call's
stopwatch and leave a retrying caller in a loop that cannot end. So the commit is not repeated, the
command runs again, and the body is what is true now. Read it as a first answer, because it is one.

**One id names one call.** Present the same id with a different command or different arguments and it
is refused with exit 2, naming the command the id was first used for, rather than being answered with
somebody else's result. Changing only `--timeout-ms` is the same call: more patience is not a
different question.

**Against a Host too old to keep receipts, a `--request-id` you typed is refused with exit 9** rather
than run unprotected. The id minted for a command you did not key is dropped instead, and that
command runs exactly as it always did.

**That refusal is about a Host that answered and cannot help. Some answers never reach a Host at
all**, and they split in two.

`host start`, `host status`, `host stop`, `skills list` and `skills install` do not go through the
Host's command layer, so a `--request-id` on one of them is **refused with exit 2** rather than
dropped. `host stop` and `skills install` are the ones that act, and a caller that keys them is owed
either the protection or the refusal. (`skills install` is safe to repeat anyway: a second run writes
nothing.)

The rest simply cannot act twice, so the id does nothing and nothing is refused over it: `version`
answers from the binary, because saying that the two builds differ is exactly what that command is
for; a read the state file can answer is answered from the file when no Host is running; a worker's
report that cannot be delivered is written to the queue; and `help`, `agent-context` and `browser
help` only print what is already in this binary.

**`requests show` asks what became of an id, and its three answers all exit 0**, because not finding
a receipt is an answer rather than a failure. `completed` means this Host ran the request, and
`data.response` carries the envelope it answered with, status and all. `pending` means a Host is
running it right now: wait and ask again, and do not send the command again, because a second
attempt while the first is in flight is refused with 6. `absent` means this Host holds no receipt
for that id under your session.

**`absent` is not proof that nothing happened.** Receipts live in the Host's memory, so compare
`data.hostStartedAt` with when you sent the request: a Host that started later never saw it, and the
one that did is gone. The id may also have been sent under a different `ASTERA_SESSION`, or the
command may have changed nothing and so left nothing to record. `data.interpretation` is the
runtime's own sentence for whichever of the three came back, which is why it is worth reading rather
than deriving. Before retrying on an `absent`, look at the state instead: whether the run exists,
whether the question is answered. With no Host at all, `requests show` is exit 3 like any other
command that needs one, and for the same reason: there is no receipt to have.

Commands the in-app coordinator agent uses, such as `worker-start`, `send`, `check` and `ask`, are
not part of this surface and are not described here. `astera help` documents them. `jobs create`,
`tasks add`, `accounts list` and `run-configs list` are the public names of four of them
(`run-create --auto`, `task-create`, `accounts`, `run-configs`), and the old names keep working for
the agents that use them. `run-configs list` differs in one way: it names its Job, where `run-configs`
reads the latest run's.

## Output

**JSON is the default**, because the first reader of this command is usually a script.

```json
{ "ok": true, "data": { "jobs": [ … ] } }
{ "ok": false, "error": { "code": "NOT_FOUND", "message": "unknown job: job_x", "details": {},
                          "nextSteps": ["astera jobs list"] } }
```

`data` is always an object, never a bare array, so that a field can be added later without breaking
every reader. A list arrives under its own noun: `data.jobs`, `data.runs`, `data.tasks`,
`data.questions`, `data.projects`, `data.accounts`, `data.runConfigs`, `data.sessions`.

`error.code` is for branching and `error.message` is for a person. The codes are the closed set in
the exit code table below.

**`error.nextSteps` is what to run next.** It is always present and its entries are command lines,
not advice: `astera host start`, not "start the Host". It is empty when there is nothing general to
run, which is the honest answer for exit 1. That code means none of the other nine described the
failure, so nothing is known about the cause beyond the message.

It is also empty for a 6 that a damaged profile file caused. The app is the only program that
writes `accounts.json`, `app-settings.json` and `run-configs.json`, and it repairs them when it
starts. So when a command cannot read one, the step is to open Astera, and no command does that.
`error.details.repair` names the file. Branch on that field, not on the wording of the message.

A 6 from a Host that is on its way out is different again. A worker or coordinator start that
reaches a Host after it began to leave is refused before anything is started, and the Dispatch it
opened is rolled back. `error.details.retry` is `host-retiring`, and the step is the same command
again once a Host is up: `error.nextSteps` offers `astera host status`. One command is the exception.
A later `jobs run` whose coordinator was refused has already made its run, so the same command again
would make another. Its `error.details` carries `runId`, and its steps are `astera host status` and then
`astera run-start --run <jobId>`. A leaving Host takes no new
connections, so a retry made while it is still on its way out ends with 3 rather than this 6 again.
Once it has gone, the same command with the same `--request-id` reaches the next Host, which answers
it fresh.

Any other 6 still offers `astera status`.

The steps depend on the command as well as the code, so a 4 from `jobs get` offers `astera jobs
list` and a 4 from `runs get` offers `astera runs list`. Where a step needs an id the error already
carries, that id is filled in: a `runs wait` that ends in failure offers
`astera tasks list --run run_9f8e --status failed`, ready to run.

A placeholder still in angle brackets is one you supply. Two lines can mean two different things.
Where the second needs a value the first produces, they are a sequence to run in order; where they
are alternatives, such as the 8 that offers both `questions answer` and `runs resume`,
`error.details` says which one applies.

```bash
astera jobs run --id job_typo || astera jobs list
# or take them from the envelope
astera jobs run --id job_typo | jq -r '.error.nextSteps[]'
```

**`--human`** prints aligned columns for reading, with the state first:

```text
RUNNING   job_4f2a  Refactor authentication      3/7
WAITING   job_91bc  Payment migration            1 question
COMPLETE  job_2d80  Rename the run config store  5/5
```

Never parse that. It has no contract, and columns will change.

Every failure this mode reaches is a sentence rather than an envelope, and the same steps follow it
under `try:`, one per line. They are printed once, here or in the envelope, never both. The one
exception is a bad `--json`/`--human`/`--quiet` combination, which is refused before the mode is
settled and so has no mode to honour.

```text
error: cannot reach the Host at \\.\pipe\astera-host-9f2a (unreachable)
try:
  astera host start
```

**`--quiet`** prints ids only, one per line, so a shell loop works without `jq`:

```bash
for job in $(astera jobs list --quiet); do astera jobs get --id "$job"; done
```

**A wait says on stderr that it is still waiting.** `jobs wait` and `runs wait` block for as long as
the work takes, which can be an hour, and a command that prints nothing for an hour looks exactly
like one talking to a Host that has stopped answering. So every 15 seconds a line goes to stderr:

```text
astera: waiting for runs wait, 45s so far; the Host answered 5s ago
```

The number at the end is not decoration. While it waits, the command asks the Host the same
heartbeat question the app asks it, and reports how long ago the Host last answered. A Host whose
event loop has stopped turning answers nothing, so that number grows, and past 15 seconds the line
says so plainly instead of reassuring you. A Host too old to know the heartbeat gets no question and
the line ends after `so far`.

**Nothing of this reaches stdout**, which carries one result and nothing else, so there is nothing to
filter out of a pipeline: `astera runs wait --id "$run" | jq .data` is unaffected. `--no-keepalive`
turns the lines off for a caller that wants stderr empty; `2>/dev/null` does the same from the shell.
`--quiet` does not turn them off, because it decides what stdout carries and this is the other
channel.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | A failure none of the codes below describes |
| 2 | Invalid arguments: the parser refused, or the command rejected them |
| 3 | The Host could not be reached, and the state file could not answer this command |
| 4 | No such id |
| 5 | Refused for this caller |
| 6 | Refused because of current state, such as a Job that is already running |
| 7 | A deadline elapsed, or the Host is running and not answering |
| 8 | A `wait` stopped because a person is needed: a question is open, or the run is paused |
| 9 | The command exists here but not in the running build |
| 10 | A `wait` ended with the Job or run in failure |

**3 and 4 are different questions.** 3 means nothing answered; 4 means something answered and does
not know that id. Do not retry a 4.

**3 and 7 are the two that mean "I do not know".** Every other code is a decision about a command
that ran; these two say only that no answer came back, and the Host commits before it answers. Do not
read either as "it failed, run it again" — `error.details` carries the request id and the command
that says what became of it.

**8 and 10 are the two that matter in CI.** A pipeline needs to tell "it finished badly" from "it is
waiting for a person", and both are legitimate non-zero endings of a wait.

**9 means two different builds.** The command on your `PATH` and the running Host came from
different versions of Astera. Report it rather than working around it.

The Host's address includes its protocol version, so an `astera` of another protocol does not reach
the running Host at all. When it finds nobody at its own address, it checks whether a Host of any
other protocol serves the same profile before it says there is no Host or answers from the state
file. If one does, the answer is 9 rather than 3, the file is not read (that Host is writing it), and
`error.details` carries `hostProtocol`, `hostAddress` and `cliProtocol`. `astera host status` answers
9 in the same situation, and `astera host start` refuses with 9 instead of starting a second Host on
the profile. Its `nextSteps` is only `astera version`, because running `host start` again would get
the same answer.

`astera version` never fails. It answers 0 with whatever it knows, so it can be used to check
whether the two halves agree.

## Use in CI

Start a Job and wait for it:

```bash
set -e

run=$(astera jobs run --id job_123 | jq -r '.data.id')
astera runs wait --id "$run" --timeout-ms 3600000
```

Branch on how the wait ended:

```bash
astera runs wait --id "$run"
case $? in
  0)  echo "done" ;;
  8)  echo "a person is needed"; astera questions list --status open ;;
  10) echo "the run failed"; astera tasks list --run "$run" --status failed ;;
  7)  echo "still going when the deadline passed" ;;
  *)  echo "could not wait"; exit 1 ;;
esac
```

Make a step safe to re-run, by giving the call an id the pipeline can reproduce:

```bash
run=$(astera jobs run --id job_123 --request-id "$CI_JOB_ID-start" | jq -r '.data.id')
```

Re-running that step answers with the same run rather than starting a second one. If the step dies
before it reads the reply, `astera requests show --id "$CI_JOB_ID-start"` says whether it landed.

Plan a Job from a pipeline, then run it:

```bash
account=$(astera accounts list --agent claude | jq -r '.data.accounts[0].id')
job=$(astera jobs create --objective "nightly dependency bump" --request-id "$CI_JOB_ID-plan" | jq -r '.data.id')
build=$(astera tasks add --job "$job" --spec "update the lockfile" --account "$account" | jq -r '.data.id')
astera tasks add --job "$job" --spec "run the tests" --account "$account" --deps "[\"$build\"]"
run=$(astera jobs run --id "$job" | jq -r '.data.id')
```

Answer a question from a pipeline:

```bash
q=$(astera questions list --status open --quiet | head -n 1)
astera questions answer --id "$q" --answer "use the existing migration"
```

Find the Job for the repository the pipeline checked out:

```bash
project=$(astera projects find --path "$PWD" | jq -r '.data.id')
astera jobs list | jq --arg p "$project" '.data.jobs[] | select(.projectId == $p)'
```

## Security

The boundary is your machine and your operating system account.

- The Host listens on a local named pipe on Windows and a unix socket elsewhere. Nothing is exposed
  on the network.
- The address is derived from the profile folder, so each profile has its own Host and two profiles
  on one machine never meet.
- On macOS and Linux the socket sits in a directory created with mode 0700 before the socket is
  bound, so it is never briefly reachable by another account.
- On Windows a named pipe's default security descriptor does grant read access to other local
  accounts. Measured, it cannot be narrowed from Node. Read access alone cannot complete the
  handshake, and the Host sends only to peers that completed it, so another account on the machine
  hears nothing. This is the one place the boundary rests on the protocol rather than on file
  permissions.
- There is no token and no connection file. What used to be a bearer token on a loopback HTTP port
  was removed with the server it protected.
- Public replies are shaped by an allowlist of fields. Account configuration directories, session
  credentials and provider tokens are not part of any reply, in either output mode.
- Every agent session Astera starts can reach this command, and through it can start worker sessions
  under any account the app holds. That is what orchestration is, and it is not something you switch
  on: an agent you run is an agent that can spend your accounts.
- Any process running as you, including every agent session Astera starts, can see what every
  terminal session's screen shows and read every chat session's conversation, and type into every
  session, with `astera sessions`. A worker can type into its coordinator
  and into any other session. That is the chosen model, and the boundary is the same as for the rest
  of this command: your operating system account.
- **A worker the Host starts inherits the Host's environment**, and the Host's environment is that of
  whatever started it: Astera, or the shell that ran `astera host start`. A Host started from a shell,
  a CI job for example, therefore hands that shell's variables, secrets included, to every agent it
  starts, exactly as Astera does when you start Astera from that shell. Start the Host from an
  environment that holds only what the agents may see. What is removed is a fixed list:
  - When the Host starts: every variable whose name begins with `ASTERA_SESSION`, `ASTERA_CLI` or
    `ASTERA_SKILLS`; the variables a Claude Code session sets about itself (`CLAUDECODE`,
    `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`,
    `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_BRIDGE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`,
    `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_PID`, `CLAUDE_EFFORT`); and `ELECTRON_RUN_AS_NODE` and every
    `ASTERA_HOST_` variable, which the Host's start then sets for itself.
  - When the Host starts a worker: `ELECTRON_RUN_AS_NODE` and every `ASTERA_HOST_` variable again, so
    the Host's own settings never reach an agent. Then the same steps as for a worker Astera starts:
    the Claude Code list above is cleared once more, the Astera variables a session is given
    (`ASTERA_STATUSLINE_OUT`, `ASTERA_STATUSLINE_ORIGINAL`, `ASTERA_HOOK_OUT`, `ASTERA_CLI`,
    `ASTERA_PROFILE_DIR`, `ASTERA_SKILLS`, `ASTERA_SESSION`) are cleared and set afresh, and
    `CLAUDE_CONFIG_DIR` or `CODEX_HOME` is set to the account's folder, or removed for the default
    account.

  Everything else passes through as it is, including `PATH` (with the `astera` folder put in front),
  `ASTERA_HOST`, `ASTERA_PROFILE` and settings such as `CLAUDE_CODE_USE_BEDROCK` or
  `CLAUDE_CODE_OAUTH_TOKEN`.

Anyone who can already run programs as you can run `astera`. Treat it with the same care as your
shell.

## Troubleshooting

**`astera: command not found`**
The install folder is not on your `PATH`, or this shell was opened before you added it. Re-check
**Settings → Agents → Command line tool (astera)**, run the line it shows, and open a new shell.

**Exit 3, "cannot reach the Host"**
No Host is running and the command needs one. Run `astera host start`. If it does not come up,
`astera host status` names the profile it looked in, and the Host's log is at
`<profile>/host/host.log`.

**Exit 3 on a read command**
The state file could not be read either, which usually means this profile has never run a Job.
`astera host status` prints the profile path it is using.

**Commands reach the wrong Astera, or `running: false` about a Host you can see**
You have both an installed build and a development build, or a hand-set `ASTERA_PROFILE_DIR` whose
letter case differs from the running Host's. `astera host status` prints the profile it resolved;
compare it with the one the Host is on. Inside a session the app sets `ASTERA_PROFILE_DIR` itself, so
a session's `astera` always reaches the app that started it. From a plain shell, `ASTERA_PROFILE=dev`
selects the development profile.

**An agent session does not know about `astera`, or about a feature you switched on**
Its account may not have the skill yet. An account added in the app gets no skills until Astera
restarts. Run `astera skills list` to see what each account has and `astera skills install` to put
in what the settings enable, then open a new session: a session reads its skills when it starts.

**Exit 6 from `astera host stop`**
The Host still holds sessions or running runs. The message says how many, and so do
`error.details.sessions` and `error.details.runs`. Stop the work first.

**Exit 7**
Either a wait reached its deadline, which is not a failure of the Job, or the Host is running and
not answering. `astera host status` tells the two apart: it answers in the first case and does not
in the second.

**Exit 9**
The `astera` on your `PATH` and the running Host came from different builds. Quit Astera, run
`astera host stop`, and start the version you meant to use. When `error.details.hostProtocol` is
there, the other Host speaks a different protocol and this `astera` cannot reach it, so its
`host stop` finds nothing: stop that Host with the build that started it (quitting that Astera, or
its own `astera host stop`), then run `astera host start` with the build you mean to use.

**A worker reported while nothing was running**
Reports a worker could not deliver are written into the profile's queue and applied when the
orchestrator is next available. The command says where it wrote the file and exits 0, because there
is nothing for the worker to do about it.
A Host that announces `dispatch` applies them itself when it next starts, with Astera open or
closed; with an older Host, Astera applies them when it next opens. One exception: the first time
Astera opens on a profile that used the old orchestration switch, it leaves the queue alone, and so
does the Host. Those reports are applied the next time the Host starts.

## See also

- [Job lifecycle](jobs.md) for what a Job does once it starts.
- `astera help` for the full orchestration reference, including the commands agents use.
