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
That refusal is the Host protecting work in progress. Stop the work first, then stop the Host.

A run, not a Job: a Job with two runs going at once counts as two, because two things are running.
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

`skills list` and `skills install` are outside both lists: they never contact a Host and never need
one. They read the profile's `accounts.json` and `app-settings.json` and work on files in each
account's config folder, so they answer the same with Astera and the Host running or not.

**The account list works with the app closed.** `accounts list`, `tasks add` (it checks every
`--account`) and `jobs create --coordinator-account` ask the app for its accounts when it is open.
When it is closed, the Host reads the profile's `accounts.json` instead, which is the file the app
keeps them in. The Host only reads that file and never changes it. If the file is damaged, those
three commands exit 6 and the message says to open Astera, which repairs it.

**The run configurations work with the app closed too.** `run-configs list` and `tasks add
--validate` (it checks every id) ask the app when it is open, and the app answers for the Job's own
folder even when no session has run there yet. When it is closed, the Host builds the same list the
app would: the configurations saved in the profile's `run-configs.json` for the Job's folder, and the
ones that folder's `package.json`, Gradle, Maven, `Cargo.toml` or `go.mod` gives. It only reads. A
damaged `run-configs.json` is a 6 with the same "open Astera" message.

**The sessions commands work with the app closed, and need a Host.** `sessions list`, `sessions read`
and `sessions send` are answered by the Host out of the sessions it holds, because the Host is the
process that runs them. That is true with Astera open as well: the app is not asked. With no Host
there are no sessions to answer about, so they exit 3.

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
command, and `ASTERA_SKILLS` is the folder `astera help` reads its guide from.

## Command reference

Every command is a noun and a verb. A noun with no verb is rejected with the list of its verbs, so
`astera jobs` tells you what `jobs` can do.

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
astera sessions read   --id <sessionId> [--lines <n>]
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

**`jobs get` takes either id.** Give it a Job and it folds in that Job's latest run; give it a run
and it folds in that one. A Job is the plan, a run is one execution of it. Jobs that only ever run
once never need the `runs` commands.

**`jobs run` refuses a Job that is already running** and names the run that is going. It returns the
run it started, which is the id to pass to `runs wait`.

**`jobs create` makes a plan and runs nothing.** It returns the Job, marked `pendingStart`, with no
run. Add its tasks with `tasks add --job`, then start it with `jobs run`. This is what **New job** in
the app does. `--cwd` defaults to the directory you ran the command from. Give `--coordinator-account`
to have a coordinator session drive the Job once it runs; without it the app places the workers
itself.

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
and the message says to open Astera, which repairs it. Neither command writes to either file. A
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
The Host only reads the file. The last event in the file decides:

| Last event | `state` |
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
  `UserPromptSubmit` and no `StopFailure`. They usually read `unknown` while a turn runs, and a turn ended by
  an API error leaves its last tool event standing, `working`. Open a new session to get the hooks.
- A permission dialog reads `working` for its first few seconds. Claude Code sends the permission
  notification only once the dialog has been up that long.
- A prompt queued while a turn is ending can read `waiting` for a moment, until its own
  `UserPromptSubmit` lands.
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
{"ok":true,"data":{"id":"…","alive":true,"cols":100,"rows":30,
  "screen":["D:\\repo>echo hi","hi","","D:\\repo>"],"scrollback":["Microsoft Windows [Version …]"]}}
```

The Host keeps about 256,000 characters of each session's output while it runs, so scrollback goes
back only that far, and its oldest rows can be garbled where that window starts in the middle of a
sequence. Output from before the tab was last resized is shown at the current width. The Host drops
the output when a session ends, so an ended session reads as empty.

`sessions send` types `--text` into a terminal session and presses Enter 150ms later, which is how
the app delivers a scheduled message; `--no-enter` types the text and stops there. It answers
`{"id":…,"sent":true,"enter":true}` once the Enter has gone out, and `sent` means the Host handed the
text to the session. Two sends to one session are typed one after the other, never interleaved.
`--text -` reads the text from standard input and drops one trailing newline, so a heredoc is typed
once and Enter is pressed once. **It types into whatever the session is showing**: if the agent is
waiting at a permission prompt or a menu, the text and the Enter answer that prompt. Read the screen
first. A session that has ended is a 6. Chat sessions are listed, but reading one or typing into one
is a 6 for now: only terminal sessions are supported yet. With `--request-id`, a retried
`sessions send` is replayed rather than typed a second time.

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
  terminal session's screen shows, and type into every session, with `astera sessions`. A worker can type into its coordinator
  and into any other session. That is the chosen model, and the boundary is the same as for the rest
  of this command: your operating system account.

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
The Host still holds sessions or running runs. The message says how many. Stop the work first.

**Exit 7**
Either a wait reached its deadline, which is not a failure of the Job, or the Host is running and
not answering. `astera host status` tells the two apart: it answers in the first case and does not
in the second.

**Exit 9**
The `astera` on your `PATH` and the running Host came from different builds. Quit Astera, run
`astera host stop`, and start the version you meant to use.

**A worker reported while nothing was running**
Reports a worker could not deliver are written into the profile's queue and applied when the
orchestrator is next available. The command says where it wrote the file and exits 0, because there
is nothing for the worker to do about it.

## See also

- [Job lifecycle](jobs.md) for what a Job does once it starts.
- `astera help` for the full orchestration reference, including the commands agents use.
