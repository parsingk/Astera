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

**On Windows, launch it through `cmd /c`.** There `astera` is `astera.cmd`, and a client that starts
its server without a shell cannot run it. Checked on Windows 11 with Node 24: spawning `astera` by name failed with
`ENOENT`, spawning the full path of `astera.cmd` failed with `EINVAL`, and spawning
`cmd /c astera mcp serve` started the server and listed its fifteen tools. Each client below shows
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
| `list_accounts` | The agent accounts Astera holds (id, label, provider). `create_job` needs one as the coordinator account. |
| `list_jobs` | Astera Jobs, each with the state of its latest Run. Filter by state. |
| `get_job` | One Job and its latest Run. |
| `create_job` | Create a durable Astera Job for a project. This does not start execution. Use `run_job` after reviewing the returned Job id. The coordinator account runs a coordinator that plans and places the work. |
| `run_job` | Start a new Run for an existing Job. Returns immediately with a Run id; use `get_run` and `get_completion` to monitor progress. Configured completion checks and review policies may trigger bounded repair and recheck loops. |
| `list_runs` | Runs, oldest first, optionally of one Job. |
| `get_run` | One Run: its state and progress. Poll this instead of waiting; nothing here blocks. |
| `stop_run` | Stop a Run: its open workers are closed and the Run is paused. It can be resumed later from Astera or with `astera runs resume`. |
| `list_tasks` | The Tasks of a Run, with their status and dependencies (deps). Each spec is cut to 160 characters, and `spec_truncated` says when it was; `get_task` has the whole spec. |
| `get_task` | One Task with its attempts and the open question on it, if any. |
| `list_questions` | Questions that block a Run until someone answers. Use `answer_question` with an id from here. |
| `answer_question` | Answer a blocking question raised in an Astera Run. Use `list_questions` first to retrieve open questions. |
| `get_completion` | Where each Task of a Run stands in completion: not-started, working, checking, fixing, rechecking, reviewing, waiting-for-user, exhausted, converged or failed, with attempts and check results. Astera runs the checks and repairs; this only reads them. |

`create_job` takes a `projectId` from `list_projects`, an `objective`, and a `coordinatorAccountId`
from `list_accounts`. A Job that has never run shows `pendingStart: true` in `get_job` and
`list_jobs` until `run_job` starts it. No tool waits: an agent polls `get_run`, `get_completion` and `list_questions`.

Every result carries the data twice, as `structuredContent` and as the same JSON in the text content.
An error is the exception: its text content is a `CODE: message` line followed by the JSON (`code`,
`message`, `nextSteps` and, when there are any, `details`), and it carries no `structuredContent`,
because some clients (Cursor) validate `structuredContent` even on an error.
The four tools that change something (`create_job`, `run_job`, `stop_run`, `answer_question`) accept an
optional `requestId`. Retrying with the same id returns the first result instead of acting twice. The
Host keeps these receipts in memory for one hour, and a Host restart forgets them.

## MCP access

**Settings, CLI tab, MCP access** decides what a connected client may do:

| Value | Allows |
| --- | --- |
| Off | Nothing. Every tool is refused. |
| Read only | The list and get tools, `get_run` and `get_completion` included. |
| Read and control | The above, plus `create_job`, `run_job`, `stop_run` and `answer_question`. This is the default. |

The setting is read on every call, so a change applies to a connected client at its next call without
reconnecting. Every other Host command is refused to MCP clients whatever the setting says.

## How it stays local

- The server talks to the client over stdio. It opens no network port.
- It reaches the Host only from the same OS account, and the Host proves itself with its key before
  the server sends anything.
- Credentials and tokens are never returned by a tool. Free text in results (objectives, specs,
  results, questions, answers, review issues and suggested fixes, error messages) is redacted of
  anything that looks like a secret; ids, paths and timestamps are left as they are.
- Raw check output is not returned. `list_tasks` and `get_task` carry each check's status and exit
  code without its log, and so does `get_completion`.

## Troubleshooting

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

**`astera: command not found` in the client's log**
The client was started from a shell that does not have the install folder on its `PATH`. Open a new
shell, or use the full path in the client's configuration. On Windows, a client that launches
`astera` itself fails even with the folder on `PATH`, because `astera` is `astera.cmd` and a program
started without a shell neither finds nor runs a `.cmd` (`ENOENT` by name, `EINVAL` by full path).
Use the `cmd /c astera mcp serve` form from [Connect a client](#connect-a-client).

## An example flow

1. `list_projects` to find the project id.
2. `list_accounts` to pick a coordinator account.
3. `create_job` with the `projectId`, an `objective` and the `coordinatorAccountId`. It returns the Job
   without starting it.
4. `run_job` with the Job id. It returns a Run id at once.
5. Poll `get_run` for the Run's state and `get_completion` for where each Task stands in its checks.
6. If a Run is blocked, `list_questions` shows the open questions, and `answer_question` answers one.
7. `stop_run` pauses the Run if it has to stop. Resume it from Astera or with `astera runs resume`.

<!--
Client configuration was checked against these pages on 2026-10-01:
- Claude Code: https://code.claude.com/docs/en/mcp
- OpenAI Codex CLI: https://developers.openai.com/codex/mcp (redirects to https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- Cursor: https://cursor.com/docs/context/mcp
-->
