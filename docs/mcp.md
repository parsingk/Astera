# Astera over MCP

`astera mcp serve` lets an MCP-capable agent create, run and monitor Astera Jobs. It is another way to
reach the same **Astera Host** that the desktop app and the [`astera` command](cli.md) use, so a Job
made over MCP shows up in the app and in `astera jobs list`. The Host owns the work, so Jobs keep
running when the MCP client disconnects.

## What you need

- The `astera` command, installed from **Settings, CLI tab** (see [cli.md](cli.md#install)).
- Nothing else. `astera mcp serve` connects to the Host of this profile and starts one when none
  answers. It never opens the desktop window.

The server speaks MCP over stdio, so you do not run it yourself. The client launches it.

## Connect a client

Each client launches the same command: `astera mcp serve`.

**Settings, CLI tab** shows the line for Claude Code, Codex and Cursor under MCP access, already in
the form for your operating system, each with a copy button. The lines appear once the command line
tool is installed; before that the tab says to install it first.

**The Settings lines name the installed command by its full path**, so they work whatever the
client's `PATH` holds. On Windows, a folder just put on the user Path reaches only programs started
after that, so a client that was already running cannot find `astera`. On macOS and Linux,
`~/.local/bin` is often missing from the `PATH` a desktop app starts with. On Windows a Settings line
looks like this:

```bash
claude mcp add astera -- cmd /c call "C:\Users\you\AppData\Local\astera\bin\astera.cmd" mcp serve
```

and on macOS or Linux like this:

```bash
claude mcp add astera -- '/Users/you/.local/bin/astera' mcp serve
```

The Cursor line carries the same as `"command": "cmd"` with
`"args": ["/c", "call", "<path>", "mcp", "serve"]`. The `call` is there for a folder name with `&`,
`(` or `)`: without it cmd drops the quotes around such a path and the path breaks. The quoting was
checked on Windows 11 with folders named with a space, with Hangul and `a&b (c)`: the line gave the
client the same arguments when pasted into cmd, PowerShell 7 and Windows PowerShell 5.1, and `cmd`
started with those arguments from Node and from Rust's standard library (Codex is written in Rust)
listed every tool.

One case these lines do not handle: a folder name with `$`, a backtick, `^` or `%`. PowerShell
expands `$` and the backtick inside double quotes, and cmd reads `^` and `%` in the path. For `$` or
a backtick, register the server by hand: write the JSON or TOML entry yourself, with the path as one
of the `args`, so no PowerShell reads it. For `^` or `%`, cmd reads them in any form that goes
through it, so move the CLI folder to a path without them.

The forms below use the short `astera mcp serve`, for a client that has the install folder on its
`PATH`.

**On Windows, launch it through `cmd /c`.** There `astera` is `astera.cmd`, and a client that starts
its server without a shell cannot run it. Checked on Windows 11 with Node 24: spawning `astera` by name failed with
`ENOENT`, spawning the full path of `astera.cmd` failed with `EINVAL`, and spawning
`cmd /c astera mcp serve` started the server and listed its tools. Each client below shows
its Windows form. On macOS and Linux, use the forms as they are.

### Claude Code

```bash
claude mcp add astera -- astera mcp serve
```

On Windows:

```bash
claude mcp add astera -- cmd /c astera mcp serve
```

The `--` separates Claude Code's options from the server command. Add `--scope project` to share it
through `.mcp.json`, or `--scope user` for every project. The same server written by hand in
`.mcp.json`:

```json
{
  "mcpServers": {
    "astera": {
      "command": "astera",
      "args": ["mcp", "serve"]
    }
  }
}
```

On Windows, the same entry with `"command": "cmd"` and `"args": ["/c", "astera", "mcp", "serve"]`.

### OpenAI Codex CLI

```bash
codex mcp add astera -- astera mcp serve
```

Or in `~/.codex/config.toml` (or `.codex/config.toml` for one project):

```toml
[mcp_servers.astera]
command = "astera"
args = ["mcp", "serve"]
```

On Windows:

```bash
codex mcp add astera -- cmd /c astera mcp serve
```

```toml
[mcp_servers.astera]
command = "cmd"
args = ["/c", "astera", "mcp", "serve"]
```

`codex mcp list` shows the configured servers.

### Cursor

In `.cursor/mcp.json` for one project, or `~/.cursor/mcp.json` for all of them:

```json
{
  "mcpServers": {
    "astera": {
      "command": "astera",
      "args": ["mcp", "serve"]
    }
  }
}
```

On Windows:

```json
{
  "mcpServers": {
    "astera": {
      "command": "cmd",
      "args": ["/c", "astera", "mcp", "serve"]
    }
  }
}
```

If the client cannot find `astera`, give `command` the full path of the installed command instead.

## The tools

| Tool | What it does |
| --- | --- |
| `list_projects` | The projects registered in Astera. Use a project id with `create_job`. |
| `get_project` | One registered project. |
| `list_accounts` | The agent accounts Astera holds (id, label, provider). Each provider's default account says `default: true`; `create_job` uses it when no coordinator account is given. |
| `list_jobs` | Astera Jobs, newest first, each with the state of its latest Run. Filter by state, and by project with a `projectId` from `list_projects` (an unknown id is `NOT_FOUND`). |
| `get_job` | One Job and its latest Run. |
| `create_job` | Create a durable Astera Job for a project. This does not start execution. Use `run_job` after reviewing the returned Job id. The coordinator account runs a coordinator that plans and places the work; without `coordinatorAccountId` it is `coordinatorProvider`'s default account (`claude` unless given). With `convergence: true`, a Task whose checks or review fail gets bounded repair and recheck loops instead of failing at once. |
| `run_job` | Start a new Run for an existing Job. Returns immediately with a Run id; use `get_run` and `get_completion` to monitor progress. Configured completion checks and review policies may trigger bounded repair and recheck loops. |
| `list_runs` | Runs, newest first, optionally of one Job. |
| `get_run` | One Run: its state and progress. Poll this instead of waiting; nothing here blocks. `waitingForApproval` counts the Tasks whose worker waits for a person's approval (see below). |
| `stop_run` | Stop a Run: its open workers are closed, its coordinator is asked to stop (`coordinatorStopped: true` means it had one and was asked, not that it has exited yet), and the Run is paused. Use `resume_run` to continue it. A Run that has already finished is refused with `CONFLICT` and left as it is: its coordinator and idle workers end on their own 10 minutes after it finished or after a person last typed into them (at once for a scheduled Run), so there is nothing to stop. |
| `resume_run` | Resume a Run that `stop_run` paused. A Job with a coordinator account gets a new coordinator, which looks at what is done and carries on; while the stopped one is still exiting it waits up to 10 seconds, then answers `CONFLICT` and changes nothing, so call it again. A Run that is not paused is returned as it is. |
| `list_tasks` | The Tasks of a Run, with their status and dependencies (deps). Each spec is cut to 160 characters, and `spec_truncated` says when it was; `get_task` has the whole spec. |
| `get_task` | One Task with its attempts and the open question on it, if any. An open attempt whose worker waits for a person's approval carries `waitingForApproval: true`. |
| `list_questions` | Questions that block a Run until someone answers, oldest first. Use `answer_question` with an id from here. |
| `answer_question` | Answer a blocking question raised in an Astera Run. Use `list_questions` first to retrieve open questions. |
| `create_task` | Add a Task to a Job's plan (`jobId`: every Run started from then on copies it) or to one Run (`runId`); give exactly one. `spec` is the work in full (up to 50 000 characters), `title` a short name (up to 200), `deps` the Task ids it waits for, `validate` run configuration ids from `list_run_configs` that must pass, `review: true` asks for a review. Without `accountId` the Task runs on the Job's coordinator account. |
| `list_run_configs` | The run configurations of a Job's project folder (`id`, `name`, `type`): the checks a Task can name in `create_task`'s `validate`. |
| `list_sessions` | The terminal and chat sessions Astera holds, live ones first: the person's own terminals included, and every worker and coordinator. Filter by `status` (`alive`, `ended`, or a terminal's `working`, `waiting` or `unknown`), `provider`, and `projectId`. Needs the session setting (below). |
| `get_session` | What a session shows now: a terminal's visible rows (`screen`) and the rows above them (`scrollback`, `lines` 1 to 500, 100 when not given; `lines` sizes the scrollback only, and the screen comes on top of it), or a chat's last turns (`turns` 1 to 50, 20 when not given) and the approval or question it holds open (`pending`). One answer holds at most 40 000 characters of text, the newest; over that the oldest rows or turns are left out, the scrollback first and then the top rows of the screen, and `truncated: true` says so, so ask for fewer `lines` or `turns`. `screenWrapped` and `scrollbackWrapped` mark each row that continues the one above it. Needs the session setting. |
| `send_message` | Type `text` (up to 50 000 characters) into a live session and press Enter; a chat session takes it as one turn. Returns as soon as the text is accepted, not when the session has answered: poll `get_session`. Needs the session setting and "Read and control". |
| `create_session` | Start a terminal or chat session in a registered project's folder (`projectId`), on `accountId` or, without one, on `provider`'s default account (`claude` unless given). Needs the session setting and "Read and control". |
| `get_check_output` | The output of a Task's failed check (`check`, or the first that failed): the last 4000 characters of its log, last round only. `offset` and `limit` (1 to 4000) page through them; `total` is how many there are. A Task with no failed check output is `CONFLICT`. |
| `get_task_output` | What the latest worker of a Task printed, counted from the end: skip `skipLines` newest lines, return the next `lines` (1 to 500, 200 when not given) older ones, oldest first; `more: true` says older lines remain. After Astera restarts it answers `recorded: false` with no lines, since worker output exists only while the process that started the worker runs (its last 64 KB). |
| `get_completion` | Where each Task of a Run stands in completion: not-started, working, checking, fixing, rechecking, reviewing, waiting-for-user, exhausted, converged or failed, with attempts and check results, and, per Task, a `failureSummary` (what fails in the current round: each failed check, its exit code and its last output line) and a `lastFailure` (the same for the last round of failed checks, not reviews; kept while it is rechecked and after it converged, so it says why a repair ran). Astera runs the checks and repairs; this only reads them. |

`create_job` takes a `projectId` from `list_projects` and an `objective`. The coordinator is a
`coordinatorAccountId` from `list_accounts`, or, without one, the default account of
`coordinatorProvider` (`claude` or `codex`, `claude` when neither is given): the earliest registered
account of that provider that is logged in, the one `list_accounts` marks `default: true`. With no
account of that provider logged in, `create_job` is refused with `INVALID_ARGUMENTS`. When both are
given, `coordinatorAccountId` wins. A Job that has never run shows `pendingStart: true` in `get_job`
and `list_jobs` until `run_job` starts it, and a Job with no Run has `outcome: "pending"`, also after
a `run_job` that failed. A Run that `stop_run` paused has `paused: true` and `outcome: "paused"`, in
`get_run`, `list_runs` and its Job, until `resume_run`.

**Who plans the Tasks.** A Job from `create_job` carries only its objective. Run it as it is and its
coordinator plans it first: it breaks the objective into a few Tasks, with dependencies, an account
(its own unless the objective names another) and the project's run configurations as checks when
there are any, and then runs them. A question it must ask before any Task exists goes on its first
Task, so `list_questions` shows it. To lay the Tasks out yourself instead, add them with
`create_task` (with the `jobId`) before `run_job`; the coordinator then runs them as they stand.

**Completion convergence.** `create_job` takes the same policy `astera jobs create --convergence`
does. `convergence: true` turns it on with the default bounds; `maxFixAttempts`,
`maxReviewRounds` and `maxTotalMinutes` (each an integer of 1 or more, the values the CLI takes) and
`blockingSeverity` (`high`, or `medium` for medium and high findings) change them. A knob given without
`convergence: true` is refused with `INVALID_ARGUMENTS`, as the CLI refuses it, since it would set a
policy that is off. The Job carries the policy as `convergence`, and `get_completion` shows the
loops as they run.

No tool waits: an agent polls `get_run`, `get_completion`
and `list_questions`. `run_job` makes the Run's worktree and starts its coordinator before it
answers, so on a large repository it can take up to a minute.

**A worker waiting for approval.** When a worker runs without skipping permission checks (Settings,
Agent tab), its agent can stop at a permission prompt and wait for a person. `get_task` then marks
that attempt `waitingForApproval: true`, and `get_run` carries `waitingForApproval` with the number
of its Tasks in that state; with none, the field is left out. Nothing over MCP answers the prompt: a
person answers it in Astera, in the worker's terminal. The Task's state in `get_completion` does not
change. It is read from the hook events Claude Code writes, the same ones `astera sessions list`
reads: Claude Code reports the prompt a few seconds after it goes up, and once anyone types into
that terminal the mark goes until the next event. A Codex worker writes no such events, so it never
shows as waiting.

Every list tool takes a `limit` from 1 to 200, 50 when it is not given. `list_jobs` comes newest
first by `createdAt`, `list_runs` newest first by `createdAt` (then `ordinal`), and `list_questions`
oldest first by `createdAt`; `list_tasks` keeps the Run's order (dependencies, then creation), and
`list_projects`, `list_accounts` and `list_run_configs` keep Astera's, and `list_sessions` puts live
sessions first and otherwise keeps Astera's. The list is ordered first and cut second. A cut
list carries `truncated: true` and `total` (how many there were) beside it; a whole list carries
neither.

**Paging.** Every list tool also takes an optional `cursor`. A cut list that has more rows after it
carries `nextCursor`; pass it as `cursor`, with the same filters, for the next page, which follows
the same order. No `nextCursor` means this is the last page. `truncated: true` and `total` mean the
list is not whole, so the last page of a paged list still carries them, without `nextCursor`. A
cursor is opaque and belongs to the tool that gave it: one from another tool, or one that is not a
cursor at all, is refused with `INVALID_ARGUMENTS`. A cursor holds a position in the list, not a
snapshot of it, so a list that changes between calls shifts: when rows are added ahead of the
position (a new Job in `list_jobs`, newest first), the next page starts that many rows earlier and
repeats them.

Every result carries the data twice, as `structuredContent` and as the same JSON in the text
content. An error is the exception: its text content is a `CODE: message` line followed by the JSON
(`code`, `message`, `nextSteps` and, when there are any, `details`), and it carries no
`structuredContent`, because some clients (Cursor) validate `structuredContent` even on an error.
The eight tools that change something (`create_job`, `create_task`, `run_job`, `stop_run`,
`resume_run`, `answer_question`, `send_message`, `create_session`) accept an optional `requestId`. Retrying with the same id returns the first
result instead of acting twice. The Host keeps these receipts in memory for one hour, and a Host
restart forgets them.

## MCP access

**Settings, CLI tab, MCP access** decides what a connected client may do:

| Value | Allows |
| --- | --- |
| Off | Nothing. Every tool is refused. |
| Read only | The list and get tools, `get_run`, `get_completion`, `list_run_configs`, `get_check_output` and `get_task_output` included; `list_sessions` and `get_session` only with the session setting on. |
| Read and control | The above, plus `create_job`, `create_task`, `run_job`, `stop_run`, `resume_run` and `answer_question`, and, with the session setting on, `send_message` and `create_session`. This is the default. |

**Sessions are a second setting.** `list_sessions`, `get_session`, `send_message` and
`create_session` also need **Let MCP clients see and use sessions** (Settings, CLI tab), which is off
by default: they reach every session Astera holds, the person's own terminals included. With it on,
the two reads follow "Read only" and the two writes need "Read and control"; with it off, each is
refused with `PERMISSION_DENIED` naming the setting. Two refusals hold whatever the settings say:
`send_message` into a terminal session waiting on a permission prompt or a question, or a chat
session holding an approval or a question open, is refused with `CONFLICT` and nothing is typed (a
person answers those in Astera; no MCP tool answers a prompt), and `create_session` starts a session
only in a registered project's folder. A Codex terminal writes no hook events, so whether it waits
on a prompt is not known and it is not refused.

Both settings are read on every call, so a change applies to a connected client at its next call without
reconnecting. Every other Host command is refused to MCP clients whatever the settings say.

**The Job Journal records which client acted.** What an MCP client does is journalled as surface
`mcp`, with the client's name and version as its MCP `initialize` request gave them (for example
`claude-code` `1.2.3`). The client names itself, so Astera keeps only ASCII letters, digits, `.`,
`_`, `-`, `/`, `@` and spaces, cuts the name to 64 characters and the version to 32, and leaves out
a field with nothing left.

## How it stays local

- The server talks to the client over stdio. It opens no network port.
- It reaches the Host only from the same OS account, and the Host proves itself with its key before
  the server sends anything.
- Credentials and tokens are never returned by a tool. Free text in results (objectives, specs,
  results, questions, answers, review issues and suggested fixes, failure summaries, error messages)
  is redacted of anything that looks like a secret; ids, paths and timestamps are left as they are.
- Session and output text is redacted the same way: every screen and scrollback row, every turn's
  text and tool lines and the pending summary of `get_session`, the `text` of `get_check_output` and
  every line of `get_task_output`. `total` and `offset` of `get_check_output` count the log before
  redaction.
- A line the terminal wrapped over several rows is joined and redacted as one line, with the spaces
  the Host trimmed at a row's end put back, so a key split across rows is caught; every row is also
  redacted on its own. From a Host too old to mark wrapped rows, each pair of adjacent rows is
  checked together instead, which can redact a row that only follows a token. When the rows returned
  start in the middle of a line (the first row of `scrollback` continues one above it), the start of
  that line, and the head of any secret on it, lies above what was returned, so only the visible
  tail is checked on its own; ask for more `lines` to read the whole line.
- Raw check output is not returned by the Job tools. `list_tasks` and `get_task` carry each check's
  status and exit code without its log, and so does `get_completion`. The one exception is `get_completion`'s
  `failureSummary` and `lastFailure`: they carry each failed check's last output line, cut to 200
  characters and redacted like the rest of the free text. `failureSummary` is the same line
  `astera runs checks` prints, for the current round only; `lastFailure` is that line for the last round
  of failed checks (a rejected review is not kept there), and stays after the recheck passes.

## Troubleshooting

**Start with `astera mcp status`.** Run it in a shell on the same machine. It starts no Host and says
whether `astera mcp serve` would work: whether a Host runs and serves MCP clients (`host.running`,
`host.mcp`), the MCP access setting (`access`) and how many tools the server offers (`tools`). It
exits 0 when all is well, 3 when no Host runs (the server starts one when a client launches it, or
run `astera host start`), and 9 when the Host is too old for MCP clients. `access: null` with a
`warning` means `app-settings.json` cannot be read, and every MCP call fails until Astera repairs it.

Tool errors carry the same codes as the CLI (`HOST_NOT_RUNNING`, `VERSION_MISMATCH`,
`PERMISSION_DENIED`, `NOT_FOUND`, `CONFLICT`, `INVALID_ARGUMENTS`, `TIMEOUT`, `FAILED`) and a
`nextSteps` list saying what to do.

**`HOST_NOT_RUNNING`**
The server could not reach a Host and could not start one. Run `astera host start`. If it does not
come up, `astera host status` names the profile it looked in, and the Host's log is at
`<profile>/host/host.log`.

**`VERSION_MISMATCH`**
The Host is from before an update and cannot talk to this build. Open Astera, which replaces it, or
run `astera host start --replace`. The sessions that Host was running end with it.

**`PERMISSION_DENIED`**
MCP access does not allow that tool. Change it in Settings, CLI tab. A client already connected sees
the change at its next call. The same code with the message "something answered at the Host's address
but could not prove it is this account's Host" means a process at the Host's address failed the Host
key proof. The server sent it nothing and does not start a Host beside it. Find what holds that
address before you retry.

**`TIMEOUT`**
The Host did not answer within 50 seconds. The server answers first because Cursor cuts a tool call
at 60 seconds and Codex documents 60 seconds as its limit, and an answer says why the call ended. The
command may still finish: re-read with a `get_` tool. For `run_job` the Run may still be starting,
so check with `get_job` before you call `run_job` again, or retry with the same `requestId`.

**`astera: command not found` in the client's log**
The client was started from a shell that does not have the install folder on its `PATH`. Open a new
shell, or use the full path in the client's configuration: the lines in Settings, CLI tab already do. On Windows, a client that launches
`astera` itself fails even with the folder on `PATH`, because `astera` is `astera.cmd` and a program
started without a shell neither finds nor runs a `.cmd` (`ENOENT` by name, `EINVAL` by full path).
Use the `cmd /c astera mcp serve` form from [Connect a client](#connect-a-client).

## An example flow

1. `list_projects` to find the project id.
2. `list_accounts` to pick a coordinator account, or skip it to use the default `claude` account.
3. `create_job` with the `projectId`, an `objective` and, if you picked one, the
   `coordinatorAccountId`. It returns the Job without starting it.
4. Optionally lay the Tasks out yourself: `list_run_configs` for the checks, then `create_task` with
   the `jobId` for each Task. Skip it and the coordinator plans the Job when it runs.
5. `run_job` with the Job id. It returns a Run id at once.
6. Poll `get_run` for the Run's state and `get_completion` for where each Task stands in its checks.
7. If a Run is blocked, `list_questions` shows the open questions, and `answer_question` answers one.
8. `stop_run` pauses the Run and stops its coordinator if it has to stop. `resume_run` lets it go
   again with a new coordinator. A Run that has finished needs no stop: its coordinator and idle
   workers end on their own after 10 minutes with nobody typing into them, so the Host can leave.

<!--
Client configuration was checked against these pages on 2026-10-01:
- Claude Code: https://code.claude.com/docs/en/mcp
- OpenAI Codex CLI: https://developers.openai.com/codex/mcp (redirects to https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- Cursor: https://cursor.com/docs/context/mcp
-->
