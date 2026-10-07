# Remote Runtime

Remote Runtime lets one machine run Jobs and sessions for another. The machine that does the work is the
**Runtime**; the machine you type on is the **controller**. Jobs keep running on the Runtime when the controller
sleeps, shuts down or loses its network: the controller only sends commands and reads what happened.

This page covers the command line and MCP. The Astera app's own remote view comes later.

## Set up the Runtime

On the machine that will do the work:

```text
astera runtime start --listen 100.64.0.5     listen on that address (default 127.0.0.1, port 47831)
astera runtime pair --name laptop            a one-time pairing string, valid 10 minutes
```

`--listen` takes an address of that machine, such as its Tailscale or LAN address. Astera does not open the port
to the internet and offers no relay: reach the Runtime over a network you already trust (a VPN such as Tailscale, or
your LAN).

`runtime pair` prints one string, `astera-pair:v1:<address>:<port>:<code>:<fingerprint>`, and its parts. The code
is a secret that works once, for 10 minutes, and five wrong tries burn it. Give the string to the controller directly;
do not paste it anywhere else. `--read-only` pairs a controller that may read but not change anything.

To keep a Host running across reboots without the app open, run `astera runtime serve` from an OS service (a logon
task, a LaunchAgent or a systemd unit). See [cli.md](cli.md#remote-runtime).

## Pair the controller

On the machine you type on:

```text
astera runtimes add --pair 'astera-pair:v1:100.64.0.5:47831:ABCDEFGH23:<fingerprint>'
astera runtimes list
```

`runtimes add` checks the Runtime's key against the fingerprint in the string **before** it sends the code. A
different key is refused with `RUNTIME_IDENTITY_CHANGED` and nothing is sent. `--address` reaches the Runtime at
another address than the one in the string (a Tailscale name, a NAT). Without `--pair`, give `--address`, `--code`
and `--fingerprint`; the fingerprint is required, since the command line cannot show you a key and ask.

The token the Runtime issues is kept in this profile's `runtimes` folder, readable by your user only. It is never
printed, and never read from an argument or an environment variable.

`astera runtimes remove --id <runtimeId|name>` forgets a Runtime on the controller. It does **not** revoke the
pairing there: run `astera runtime revoke --id <clientId>` on the Runtime for that (`astera runtime clients` lists
the ids). A revoked controller's next command is refused with `RUNTIME_AUTH_FAILED`, and its open connections close.

## Use it from the command line

Put `--runtime <id|name>` before the command:

```text
astera --runtime office projects list
astera --runtime office accounts list
astera --runtime office jobs create --objective "fix the flaky test" --cwd 'D:\work\repo'
astera --runtime office jobs run --id <jobId>
astera --runtime office runs follow --id <runId>
astera --runtime office questions answer --id <questionId> --answer yes
```

What a Runtime offers is the same list its pairing is checked against:

- **Reads**, at either permission: projects, accounts, Jobs, runs, tasks, questions, run configurations, checks and
  output, `runs wait`, `jobs wait`, `runs follow`, sessions (list and read), GitHub reads, and `requests show` for
  your own requests.
- **Changes**, with a full-control pairing only: creating, running, stopping and resuming Jobs and runs, adding
  tasks, answering questions, creating sessions and sending to them.
- **Never remotely**: anything on this machine only (`host`, `skills`, `higgsfield`, `mcp`, `runtime`, `runtimes`,
  `projects add`, `browser js`, `app js`), How It Works records, GitHub writes, and the Host's own management.

A command with no remote form is refused with `RUNTIME_CAPABILITY_MISSING` before it reads anything on this
machine. In particular, `--runtime` never falls back to this machine's state file or report queue when the Runtime
cannot be reached: you get `RUNTIME_OFFLINE` instead.

Paths are the Runtime's. `--cwd` and `--project` are sent as typed, and a remote `jobs create` needs `--cwd`: the
controller's own folder means nothing on the Runtime.

## Use it from MCP

Every MCP tool takes an optional `runtimeId` (an id or a name from `list_runtimes`). A tool given one runs on that
Runtime; `list_runtimes` and `get_runtime` list the pairings. A remote tool call is allowed only when all three agree:

1. this machine's MCP settings (MCP access, sessions, GitHub writes), checked here before anything is sent;
2. the list above of what a Runtime offers;
3. the Runtime's pairing of this machine (read-only or full-control), checked on the Runtime.

For a remote call, an MCP access value Astera does not recognize counts as off.

The first check runs on this machine. An agent that can run `astera --runtime x` directly has the command line's
authority, which is the pairing's: the MCP settings limit MCP clients, not the person's own shell.

## When an answer is lost

A command that changes something carries a request id. If the connection drops before its answer comes back, the
controller reconnects (waiting 1 s, 2 s, 5 s, 10 s, then 30 s, with jitter) and sends the same command again with the
same id, marked as a retry. The Runtime then answers with what the first attempt did, and never runs it twice. When
it cannot say (the first attempt never arrived, or the Runtime restarted since), the answer is
`RUNTIME_OUTCOME_UNKNOWN`: list the newest Jobs or runs on that Runtime before trying again.

A Job's life does not depend on the controller: closing the laptop, losing the network or quitting the command
leaves running Jobs running.

## Error codes

| Code | Exit | Meaning |
|---|---|---|
| `RUNTIME_NOT_FOUND` | 4 | no paired Runtime has that id or name, or a name matches two |
| `RUNTIME_OFFLINE` | 3 | the Runtime could not be reached |
| `RUNTIME_AUTH_FAILED` | 5 | the Runtime does not know this controller: revoked, or never paired |
| `RUNTIME_IDENTITY_CHANGED` | 5 | the Runtime's key is not the one pinned at pairing |
| `RUNTIME_PROTOCOL_MISMATCH` | 9 | the two machines speak different remote protocols; update the older |
| `RUNTIME_PROJECT_NOT_FOUND` | 4 | that project is not registered on the Runtime |
| `RUNTIME_ACCOUNT_NOT_FOUND` | 4 | that account does not exist on the Runtime |
| `RUNTIME_CAPABILITY_MISSING` | 9 | the command has no remote form, or that Runtime cannot do it |
| `RUNTIME_BUSY` | 6 | too many connections or calls in flight on the Runtime; try again shortly |
| `RUNTIME_PERMISSION_DENIED` | 5 | a read-only pairing asked for a change |
| `RUNTIME_OUTCOME_UNKNOWN` | 6 | an answer was lost and the Runtime cannot say whether the change ran |
| `REMOTE_TIMEOUT` | 7 | no answer in time; the command may still finish |
| `REMOTE_OPERATION_CONFLICT` | 6 | refused because of the Runtime's current state |
| `REMOTE_REPLY_TOO_LARGE` | 1 | the answer was over 64 MiB |

The code is in `error.code` of the envelope; read it from there, never from the sentence.
