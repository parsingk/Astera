# Remote Runtime

Remote Runtime lets one machine run Jobs and sessions for another. The machine that does the work is the
**Runtime**; the machine you type on is the **controller**. Claude, Codex, worktrees, checks, repairs and recovery stay
on the Runtime, and you drive the work from the Astera app, the `astera` command or MCP on the controller. Jobs keep
running on the Runtime when the controller sleeps, shuts down or loses its network: the controller only sends commands
and reads what happened.

## What it costs

Astera does not require a hosted relay or cloud service for Remote Runtime. You provide the machine and private network
connection. The only costs are the ones you choose: a VPS or cloud machine if the Runtime is one, a VPN service if you
use one, and the Claude or Codex subscriptions or API use the Runtime's accounts already have. There is no Astera
server fee.

## How it differs from MCP over HTTP

MCP over HTTP (Settings › CLI) lets an MCP client on another machine call this machine's tools. It is plain HTTP: its
`lan` mode is not a secure remote path, and the docs for it say so. Remote Runtime is the secure path: a pinned TLS
key, a one-time pairing, a token per controller that can be revoked, and a list of what a controller may do that the
Runtime checks on every call.

## What it promises

1. A network loss, a laptop that sleeps or shuts down, a closed app or command, and a Gateway restart never change a
   Job's lifetime.
2. While Remote is on, the Runtime's Host stays up, including with only a scheduled Job or a Run waiting on a question.
   A schedule time that passes while the Host is down is skipped, not fired late.
3. A rebooted Runtime machine is back when its user logs in (with one of the OS recipes below), or after
   `astera runtime start`. A crashed Host is back at once when it runs under `astera runtime serve` with an OS
   supervisor.
4. After a Host restart, lost workers, repairs and interrupted checks are recovered by the Host itself, with no app
   open anywhere. Live terminal sessions do not survive a Host restart.
5. A controller that reconnects sees the Runtime's current state; a remote terminal that reconnects shows the same
   screen it would have shown had it stayed attached, or says plainly that it cannot.
6. A retried change never runs twice. When the Runtime cannot prove whether the first attempt ran, the answer is
   `RUNTIME_OUTCOME_UNKNOWN`, never a second run.

Notifications for a Job on a Runtime follow the Runtime machine's own Slack settings, not the controller's.

## Where it runs

The Runtime is a machine with the Astera app installed: Windows, macOS, or Linux from the `.deb` in a desktop session
(a Linux server with no desktop, no X11 or Wayland, waits for v1.1). Any of the three can be a controller.

Use a private network: your LAN, a VPN, or Tailscale. Do not forward the Runtime's port to the internet. Astera offers
no relay and opens no port for you.

## Set up the Runtime

On the machine that will do the work, with the Astera app installed and its command line turned on (Settings › CLI):

```text
astera runtime start --listen 100.64.0.5     listen on that address (default 127.0.0.1, port 47831)
astera projects add --path D:\work\repo        a folder the controllers may run in
astera runtime pair --name laptop            a one-time pairing string, valid 10 minutes
```

`--listen` takes an address of that machine, such as its Tailscale or LAN address. `start` makes this machine's
identity the first time (a key and certificate kept owner-only in the profile), starts a Host if none runs, and waits
until it listens. Every later Host start, by the app or a command, listens again while Remote is on.

**Projects.** A controller starts Jobs and sessions only in the Runtime's registered projects; a folder that is not one
is refused. Register them on the Runtime, with `astera projects add` or in the app.

**Accounts.** The Claude and Codex accounts a Runtime uses are signed in on the Runtime machine, in the Astera app, once.
A controller picks among them; no credential ever travels to or from the controller.

## Pair a controller

Pair with the string the Runtime prints. `astera runtime pair` prints one string,
`astera-pair:v1:<address>:<port>:<code>:<fingerprint>`, and its parts. The code is a secret that works once, for 10
minutes, and five wrong tries burn it. Give the string to the controller directly; do not paste it into a chat or a
ticket. `--read-only` pairs a controller that may read but not change anything.

In the app: Settings › Remote Runtimes, paste the string, Pair. From the command line:

```text
astera runtimes add --pair 'astera-pair:v1:100.64.0.5:47831:ABCDEFGH23:<fingerprint>'
astera runtimes list
```

The controller checks the Runtime's key against the fingerprint in the string **before** it sends the code. A different
key is refused with `RUNTIME_IDENTITY_CHANGED` and nothing is sent. `--address` reaches the Runtime at another address
than the one in the string (a Tailscale name, a NAT). Without `--pair`, give `--address`, `--code` and
`--fingerprint`; the fingerprint is required, since the command line cannot show you a key and ask.

The token the Runtime issues is kept in the controller's profile, readable by its user only. It is never printed, and
never read from an argument or an environment variable.

## Use it from the Astera app

- **Jobs.** The Jobs view has a runtime selector: pick the Runtime, then one of its projects. Its Jobs, Runs, Tasks,
  timeline, completion checks and questions show as they are on the Runtime; with a full-control pairing you create,
  run, pause, resume, merge and delete them there. A read-only pairing shows the same screens with the controls off
  and says why.
- **Changed files.** A Run's detail lists the files it changed, from git on the Runtime, beside what its workers
  reported, and opens a file's diff.
- **Sessions.** In the new session dialog, choose where it runs. On a Runtime you open one of its running sessions or
  start a terminal or chat session in one of its projects, on one of its accounts. A remote tab streams the Runtime's
  terminal or conversation; closing the tab leaves the session running there. A roll to another account moves the tab
  with it, and a session that starts waiting for you notifies you here.
- **Offline.** When the Runtime cannot be reached, its screens show the last state they read, marked as not current,
  and never as failed. Work on the Runtime goes on.

## Use it from the command line

Put `--runtime <id|name>` before the command:

```text
astera --runtime office projects list
astera --runtime office accounts list
astera --runtime office jobs create --objective "fix the flaky test" --cwd 'D:\work\repo'
astera --runtime office jobs run --id <jobId>
astera --runtime office runs follow --id <runId>
astera --runtime office questions answer --id <questionId> --answer yes
astera --runtime office runs-changed-files --id <runId>
```

What a Runtime offers is the same list its pairing is checked against:

- **Reads**, at either permission: projects, accounts, Jobs, runs, tasks, questions, run configurations, checks and
  output, `runs wait`, `jobs wait`, `runs follow`, a Run's changed files and diffs, sessions (list, read and their
  facts), GitHub reads, and `requests show` for your own requests.
- **Changes**, with a full-control pairing only: creating, running, stopping and resuming Jobs and runs, adding tasks,
  answering questions, creating, typing into, resizing and ending sessions.
- **Never remotely**: anything on this machine only (`host`, `skills`, `higgsfield`, `mcp`, `runtime`, `runtimes`,
  `projects add`, `browser js`, `app js`), How It Works records, GitHub writes, and the Host's own management.

A command with no remote form is refused with `RUNTIME_CAPABILITY_MISSING` before it reads anything on this machine. In
particular, `--runtime` never falls back to this machine's state file or report queue when the Runtime cannot be
reached: you get `RUNTIME_OFFLINE` instead.

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

## Keep it running: OS recipes

`astera runtime serve` keeps exactly one Host running on this profile while Remote is on, restarts a Host that
crashes (after 1, 2, 5, then 30 seconds), and exits 75 when Astera was updated so its supervisor starts it again on the
new version. It never turns Remote on by itself: run `astera runtime start` once first. Each recipe below starts
`serve` when the user logs in and restarts it whenever it exits with a non-zero code.

On a Runtime supervised this way, run `astera runtime stop` before `astera host stop`: while Remote is on, `serve`
starts a new Host after a stop.

### Windows

A logon task for your own user that runs a hidden PowerShell loop around `astera runtime serve`, in PowerShell:

```powershell
$loop     = "while (`$true) { & '$env:LOCALAPPDATA\astera\bin\astera.cmd' runtime serve; " +
            "if (`$LASTEXITCODE -eq 0) { break }; Start-Sleep 5 }"
$action   = New-ScheduledTaskAction -Execute 'powershell.exe' `
            -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -Command `"$loop`""
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
            -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'Astera Runtime' -Action $action -Trigger $trigger -Settings $settings
```

The loop is the restart: Task Scheduler's own "restart on failure" does not restart a task whose program exits with
an error code, so the loop starts `serve` again 5 seconds after any non-zero exit (a crash, or 75 after an update) and
ends when `serve` exits 0. A task for your own user needs no administrator. A task that runs before you log in (the
"run whether the user is logged on or not" kind, S4U) needs an administrator to register, so this recipe starts at
login. Measured on Windows 11 with a standard user: the task registers, runs with no window, `serve` brings a killed
Host back within 20 seconds and the loop brings a killed `serve` back within 12.

Remove it with `Unregister-ScheduledTask -TaskName 'Astera Runtime'`.

### macOS

A LaunchAgent that runs `astera runtime serve`, `~/Library/LaunchAgents/run.astera.runtime.plist` (replace `you` with
your user name):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>run.astera.runtime</string>
  <key>ProgramArguments</key>
  <array><string>/Users/you/.local/bin/astera</string><string>runtime</string><string>serve</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/Users/you/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
</dict>
</plist>
```

```text
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/run.astera.runtime.plist
```

A LaunchAgent runs once you log in. Claude keeps its sign-in in your login keychain, which is locked until you log in,
so Claude sessions and workers on a macOS Runtime start only after a login. `PATH` must include the folders `claude`
and `codex` are installed in. Remove it with `launchctl bootout gui/$(id -u)/run.astera.runtime` and delete the file.

This recipe has not been measured on a Mac yet; the Windows and Linux ones have.

### Linux

A systemd user unit, `~/.config/systemd/user/astera-runtime.service`:

```ini
[Unit]
Description=Astera Runtime

[Service]
ExecStart=%h/.local/bin/astera runtime serve
Restart=on-failure
RestartSec=5
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
```

```text
systemctl --user daemon-reload
systemctl --user enable --now astera-runtime
loginctl enable-linger $USER      start it at boot, before you log in
```

A user unit does not read your shell's profile: add to `PATH` the folders `claude` and `codex` are installed in (the
npm global folder, for example), or they are not found; the Host and its workers get exactly this `PATH`. Remove it with
`systemctl --user disable --now astera-runtime` and `loginctl disable-linger $USER`.

Measured on Ubuntu 22.04 with systemd: with linger on, the unit started at boot with no one logged in; systemd brought a
killed `serve` back (`Restart=on-failure`) and `serve` brought a killed Host back within 20 seconds; a Windows
controller paired with it listed its project, and each file's diff matched `git diff` on the Runtime, case-only
renames and Unicode names included.

## Security

- The Runtime listens with a TLS key made on that machine; a controller pins its fingerprint at pairing and refuses a
  different key from then on.
- Each controller has its own token, kept owner-only on both sides, never printed, never in an argument or the
  environment. Revoking it closes its connections at once.
- A controller reads and changes Jobs, Runs, Tasks and sessions by their ids. It cannot read or write an arbitrary
  file, list a folder, or run a shell on the Runtime. A Run's changed files and diffs come from git, by file ids the
  Runtime gave.
- Logs on both sides never carry tokens, pairing codes or terminal output.

## When an answer is lost

A command that changes something carries a request id. If the connection drops before its answer comes back, the
controller reconnects (waiting 1 s, 2 s, 5 s, 10 s, then 30 s, with jitter) and sends the same command again with the
same id, marked as a retry. The Runtime then answers with what the first attempt did, and never runs it twice. When it
cannot say (the first attempt never arrived, or the Runtime restarted since), the answer is `RUNTIME_OUTCOME_UNKNOWN`:
list the newest Jobs or runs on that Runtime before trying again.

## Revoke and remove

- On the Runtime: `astera runtime clients` lists the paired controllers; `astera runtime revoke --id <clientId>`
  unpairs one. Its next command is refused with `RUNTIME_AUTH_FAILED`, and its open connections close.
- On the controller: `astera runtimes remove --id <runtimeId|name>`, or Remove in Settings › Remote Runtimes, forgets
  the Runtime here. It does **not** revoke the pairing on the Runtime.
- `astera runtime stop` stops listening. The Host and its Jobs keep running.

## Troubleshooting

- **`RUNTIME_OFFLINE`.** Check that the Runtime machine is on and reachable at that address (`ping`, your VPN's
  status), and that `astera runtime status` there says the Gateway listens. A Runtime listening on `127.0.0.1` is not
  reachable from another machine: start it with `--listen` on its LAN or VPN address.
- **`RUNTIME_IDENTITY_CHANGED`.** The machine at that address is not the one you paired, or its profile was replaced.
  If you trust the change, remove the Runtime and pair again with a new string.
- **`RUNTIME_AUTH_FAILED`.** The Runtime revoked this controller, or its profile lost the pairing. Pair again.
- **A pairing string is refused.** It works once, for 10 minutes, and five wrong tries burn it. Run
  `astera runtime pair` again.
- **The Runtime does not come back after a reboot.** Check the OS recipe: the task, LaunchAgent or unit exists and
  runs `astera runtime serve`, and Remote is on (`astera runtime status`).
- **Sessions or workers fail to start on the Runtime.** Sign the Runtime's accounts in there, in the Astera app; under
  a service, `claude` and `codex` must be on the recipe's `PATH`.
- **`RUNTIME_CAPABILITY_MISSING` for a newer feature.** The Runtime runs an older Astera; update it there.

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
