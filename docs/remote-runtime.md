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
(a Linux server with no desktop, no X11 or Wayland, waits for v1.1). The desktop session is for setting it up: the app
installs Astera's command line and signs the accounts in. Once set up, the OS recipes below keep it running across
reboots without anyone logged in on Linux, and from your login on Windows and macOS. Any of the three can be a
controller.

Use a private network: your LAN, a VPN, or Tailscale. Do not forward the Runtime's port to the internet. Astera offers
no relay and opens no port for you.

## Set up the Runtime

On the machine that will do the work, in the Astera app: Settings › Remote Runtimes › This computer. Choose the address
to accept connections on (this machine's LAN or Tailscale addresses, or this computer only; every interface is not
offered) and turn it on. Once it is on, the same place makes a pairing string (read-only or full control, with a name;
it shows the time left and a copy button), lists the paired controllers with an Unpair button each, and turns it off.

Or from a shell, with Astera's command line turned on (Settings › CLI):

```text
astera runtime start --listen 100.64.0.5     listen on that address (default 127.0.0.1, port 47831)
astera projects add --path D:\work\repo        a folder the controllers may run in
astera runtime pair --full-control --name laptop   a one-time pairing string, valid 10 minutes
```

`--listen` takes an address of that machine, such as its Tailscale or LAN address. `start` makes this machine's
identity the first time (a key and certificate kept owner-only in the profile), starts a Host if none runs, and waits
until it listens. Every later Host start, by the app or a command, listens again while Remote is on.

**Projects.** A controller starts sessions only in the Runtime's registered projects; a folder that is not one is
refused. Register them on the Runtime, with `astera projects add` or in the app. Jobs are not held to projects: a
full-control controller can run a Job in any folder of the Runtime, and the app lists it under "Unregistered" for that
Runtime.

**Accounts.** The Claude and Codex accounts a Runtime uses are signed in on the Runtime machine, in the Astera app, once.
A controller picks among them; no credential ever travels to or from the controller.

## Pair a controller

Pair with the string the Runtime prints. `astera runtime pair` prints one string,
`astera-pair:v1:<address>:<port>:<code>:<fingerprint>`, and its parts. The code is a secret that works once, for 10
minutes, and five wrong tries burn it. Give the string to the controller directly; do not paste it into a chat or a
ticket. A pairing is read-only unless `--full-control` is given: a read-only controller may read but not change
anything. Give full control only to a controller that runs Jobs or sessions there.

In the app: Settings › Remote Runtimes, paste the string, Pair. From the command line:

```text
astera runtimes add --pair -
astera runtimes list
```

`--pair -` reads the string from standard input: paste it and end the input (Ctrl+D, or Ctrl+Z then Enter on Windows),
or pipe it in. Prefer it to `--pair '<string>'`: a value on the command line is in the process list, where another user
of the machine can read it and redeem the code first, and in your shell history. `--code -` and `--fingerprint -` work
the same way.

A Runtime names itself with an id, and makes a new id whenever it makes a new key, so a reinstalled Runtime pairs as a
new one. If a Runtime paired here already has that id under another key, another machine is claiming to be it: the
pairing is refused with `CONFLICT` and the paired one is left as it was. Only if you know why, `astera runtimes add`
with `--replace` lets it take that place.

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
  with it, and a session that starts waiting for you notifies you here. A terminal session open on both machines has
  one size: the window of the side that typed last. The other side shows the whole screen at a smaller font and says
  so, until someone types there.
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
  facts), GitHub reads, a GitHub lifecycle Run's GitHub side (`runs get`), the New Job window's check of a folder
  inside one of the Runtime's projects (`github-preflight`), and `requests show` for your own requests.
- **Changes**, with a full-control pairing only: creating, running, stopping and resuming Jobs and runs, adding tasks,
  answering questions, creating, typing into, resizing and ending sessions, a Job carried through GitHub
  (`jobs create --github-lifecycle`, made from an objective: issue → Job is not offered remotely) and carrying a run
  through GitHub again (`runs reconverge`). Such a Job takes the Runtime's own Settings › GitHub defaults, and the
  pushes, pull requests and CI reruns it leads to are the Runtime's Host's, with the Runtime's own `gh` login; your
  credentials never reach it.
- **Never remotely**: anything on this machine only (`host`, `skills`, `higgsfield`, `mcp`, `runtime`, `runtimes`,
  `projects add`, `browser js`, `app js`), How It Works records, GitHub writes of your own (`github-pr-create`,
  `github-ci-rerun`, Jobs from issues and job sources), and the Host's own management.

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

## What this computer can see of a Runtime

A paired Runtime answers a report of how it is set up for agents: its extensions (MCP servers, skills, commands and
agents, each with whether it is on and for which providers), its agent profiles, whether "Run agents without permission
checks" is on there, its policy (mode, how many Rules, and whether Enforce can start for each provider), what its
sandbox gives each provider, the names of its credentials and of each MCP server's secrets with whether they are
hidden, its secret store's check, and how many findings it has. The report holds names, states and counts, and
never a value, a path, a command line or a Rule's text. A Runtime on an older Astera cannot report, and this computer
says to update Astera there.

The Runtime keeps two slow answers for up to 10 minutes. Whether the sandbox runtime can run is kept either way, so a
fix there can take that long to show. Whether a Codex account is ready on Windows is kept only when it is ready, so a
fix to Codex setup shows at once, and an account that stops being ready can take up to 10 minutes to show. Both are
dropped when a setup runs from Astera on the Runtime. It works out a skill's hash again only when the skill changed.
A Runtime that cannot read its own extensions says "Could not read its extensions", never an empty list, and nothing
is compared against it.

### Read it

- **In the app.** Settings › Remote Runtimes, Details beside a Runtime: its identity, health (last seen, whether it
  answers now, Astera there and here, OS), agents, protection, extensions, credentials, secret store and findings
  there. The detail says when its report was read. The app reads a report when Settings › Remote Runtimes or the
  Findings section opens, at most once every five minutes per Runtime, failed attempts included, and at once when you
  press Refresh. It never reads one in the background. When the Runtime does not answer, the detail shows the last
  report kept, with its read time, under the line that says so.
- **From the command line:**

  ```text
  astera runtimes ping   --id office                  does it answer now, and with which Astera and OS
  astera runtimes get    --id office                  its report, read now and compared with this computer
  astera runtimes expect --id office --add skill-a    expect this computer's skill-a there too
  ```

  `get` keeps the report as the last one read. When the Runtime is offline, does not answer in time, or is too old to
  report, `get` shows the last report kept with its read time and still exits 0. When the Runtime refuses the asker, or
  sends a report this computer cannot read, `get` exits non-zero and the report kept stays as it was. `ping` exits 0
  whether the Runtime answers or not, and non-zero when the Runtime no longer accepts this pairing, a different computer
  answers at that address, or the two Astera versions cannot talk to each other. `--json` is described in
  [cli.md](cli.md).
- **From MCP.** `list_runtimes` and `get_runtime` say each Runtime's Astera version and platform as it last said them,
  and when this computer last reached it. They never carry the report.

### Expect extensions there

For each Runtime, choose which of this computer's extensions it should have too: tick them in the Extensions part of
its detail, or run `astera runtimes expect --id <runtime> --add <ids>` with ids from `astera ext list`. The list can be
set before the first report is read, and for a Runtime too old to report. `--add` refuses an id this computer does not
have; `--remove` also takes an id that is still in the stored list. An id that is no longer on this computer is left
out of what is shown and compared, but stays in the stored list: it comes back if the extension returns here, and
`--remove` clears it. An agent session can list the ids but not change them: taking one off the list hides what `get`
would say of it, as ignoring a finding does.

Each expected extension reads as missing, different, off, secret missing or same there:

- **missing:** it is not there.
- **different:** a skill, command or agent whose content differs from this computer's. Line endings and OS files
  (`.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`) do not count, so the same skill checked out on Windows and on macOS
  reads the same. It does not say which side is newer: updating it here makes every Runtime that expects it different
  until it is updated there.
- **off:** it is there but turned off, or not given to a provider this computer gives it to.
- **secret missing:** an MCP server with a stored secret here whose name its entry there lacks. Only names are
  compared.
- **same:** none of these.

Each state but same is a `runtime-missing-extension` finding, in Settings › Security & Access › Findings and
`astera agent-profiles audit`. It is read from the report kept on this computer, names the state and when that report
was read, and opens the Runtime's detail. A Runtime with expected extensions and no report kept gives a "Not read yet"
line instead. A Runtime that said, when this computer last reached it, that it runs an older Astera than this one is an
`outdated-runtime` finding. A new report shows in Findings the next time they are read. Ignoring a
`runtime-missing-extension` finding holds for that Runtime and extension even when its state changes, from missing to
different for example, and ignoring `outdated-runtime` holds for that Runtime through later versions.

Nothing installs from here. Install, update, turn on or add the secret on that computer, in its own Settings › MCP &
Skills. This computer never changes a Runtime's extensions, profiles, Rules or credentials.

### Who counts as an agent there

An MCP client or a CLI inside an agent session counts as an agent on the Runtime, as the same caller would on that
machine itself, and so does a client that does not say which it is. The Astera app and the command line in a person's
own shell are a person. The CLI knows it is in an agent session from `ASTERA_SESSION` or `ASTERA_GATEWAY_TOKEN`.

An agent controller meets every rule an agent meets on the Runtime itself. It cannot start work as a profile that runs
without permission checks while the Runtime's own "Run agents without permission checks" is off, answer a permission
request, or type into a terminal that waits at a permission prompt or a question. It cannot read the report either:
that answers a person only, and an agent controller gets `RUNTIME_PERMISSION_DENIED`.

An older Astera CLI, from before this release, cannot say whether it runs in an agent session, so it counts as an agent
until you update Astera on the computer that CLI runs on; its refusals say so.

On the Runtime, Settings › Remote Runtimes › This computer shows each paired controller's surface (app, CLI or MCP),
its Astera version and when it was last seen.

### A sandboxed session only reads a Runtime

A sandboxed session can only read a Runtime. From a session Astera runs in a sandbox, `astera --runtime …` and the MCP
tools given a `runtimeId` read as usual, but a command that starts or changes work there is refused on this computer
before anything is sent. When this computer's Host cannot say whether the session is sandboxed, it counts as
sandboxed, and so does an `ASTERA_SESSION` that names a session the Host does not hold. An MCP server whose client
passed it neither `ASTERA_SESSION` nor `ASTERA_GATEWAY_TOKEN` cannot tell which session it serves, so it refuses every
remote change: send the change with `astera --runtime <id|name> …` from the session's shell instead. A shell with
neither variable is a person's own and is not limited.

This rule guards against accidents and defaults. An agent that clears its environment, or speaks the remote protocol
with the pairing's token directly, is not stopped by it, so it is not a hard boundary. Only revoking the pairing stops a
controller you no longer trust.

### What it does not do

- It installs, updates, turns on or removes nothing on a Runtime, and edits none of its profiles, Rules or
  credentials.
- It reads nothing in the background: a report is read when you open Settings › Remote Runtimes or Findings, press
  Refresh, or run `astera runtimes get`.

## Keep it running: OS recipes

`astera runtime serve` keeps exactly one Host running on this profile while Remote is on and restarts a Host that
crashes (after 1, 2, 5, then 30 seconds). It exits 0 when it is stopped (SIGTERM, Ctrl+C); 75 when an update begins
while it runs (the app writes an update hold and retires the Host), so nothing of the old version stays open and its
supervisor starts the new one; and 78 when this machine cannot start a Host at all (Astera's command line was never set
up there). A `serve` started during an update waits for it to finish. It never turns Remote on by itself: run
`astera runtime start` once first. Each recipe below starts `serve` and starts it again after any exit but 0 and 78.

On a Runtime supervised this way, run `astera runtime stop` before `astera host stop`: while Remote is on, `serve`
starts a new Host after a stop.

### Windows

A logon task for your own user that runs a small PowerShell script around `astera runtime serve`. Save the script as
`%LOCALAPPDATA%\astera\runtime-serve.ps1`:

```powershell
param([string]$Astera = "$env:LOCALAPPDATA\astera\bin\astera.cmd", [string]$Hold = "$env:APPDATA\astera\host\update-hold")
while ($true) {
  # An update in progress: start nothing until its hold ends, so no file of the old version is held.
  if (Test-Path $Hold) {
    $until = (Get-Content $Hold -Raw | ConvertFrom-Json).until
    if ($until -gt [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) { Start-Sleep 10; continue }
  }
  # Astera's command line is gone (uninstalled, or turned off in Settings): stop rather than retry.
  if (-not (Test-Path $Astera)) { exit 1 }
  & $Astera runtime serve
  # 0: stopped on purpose. 78: a configuration no restart changes. Anything else (75 after an update, a crash): again.
  if ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq 78) { exit $LASTEXITCODE }
  Start-Sleep 5
}
```

Then register the task, in PowerShell:

```powershell
$script   = "$env:LOCALAPPDATA\astera\runtime-serve.ps1"
$action   = New-ScheduledTaskAction -Execute 'powershell.exe' `
            -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
            -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'Astera Runtime' -Action $action -Trigger $trigger -Settings $settings
```

The script is the restart: Task Scheduler's own "restart on failure" does not restart a task whose program exits with
an error code. `astera.cmd` runs from the app's install folder, so the script waits out an update's hold and `serve`
leaves when one begins: the installer then finds no Astera program running. A task for your own user needs no
administrator. A task that runs before you log in (the "run whether the user is logged on or not" kind, S4U) needs an
administrator to register, so this recipe starts at login. Measured on Windows 11 with a standard user: the task
registers and runs with no window; `serve` brought a killed Host back within 20 seconds and the loop a killed `serve`
within 12; the script waited out a hold, ran again after a 75, and stopped at 0, at 78 and when `astera.cmd` was gone.

To remove it, unregister the task first (`Unregister-ScheduledTask -TaskName 'Astera Runtime'`), then delete the script;
do this before you uninstall Astera or turn its command line off.

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
- A controller reads and changes Jobs, Runs, Tasks and sessions by their ids. It has no command to read or write an
  arbitrary file, list a folder, or run a shell on the Runtime. A Run's changed files and diffs come from git, by file
  ids the Runtime gave.
- **Full control is the Runtime user's power.** A full-control controller starts agents and terminal sessions there and
  types into them, and those run any command the Runtime's user can, in any folder that user can reach. Pair with full
  control only a controller you would trust with that user account; the rest keep the read-only default.
- Logs on both sides never carry tokens, pairing codes or terminal output.
- **What the report never carries.** A Runtime's report never carries secret values, tokens or keys; paths, command
  lines, an MCP server's command, arguments, folder or URL, environment values, Rule text or the Gateway's error text;
  or account labels and config folders beyond what `accounts list` gives. A probe's own words, which can name a path,
  stay in the Runtime's Host log; only its code crosses. Values stay on that computer. Astera never copies them.
- Astera copies no secret, login or credential between computers, in either direction, so there is no replication to
  approve. Each machine keeps its own, signed in there.
- A controller's Job reads leave out which controller made a Job and whose revoke paused it, so one controller never
  sees another's pairing.
- The sandboxed session rule above is a guard against accidents, not a boundary against a hostile controller. Revoke a
  pairing you no longer trust.
- Connections that have not signed in have a budget of their own, and few from one address, so sockets that say nothing
  cannot hold paired controllers off. One pairing holds at most twelve connections at once, and a controller closes a
  connection it has not used for two minutes, so idle agent sessions with Astera MCP do not hold them. More than 32
  sockets from one address are dropped before TLS, which the controller reports as `RUNTIME_OFFLINE`.
- A controller that asks and never reads its answers is closed: once its output has not moved for 45 seconds, or when
  answers waiting for every controller pass their budget and it holds the most. An answer that cannot be sent for that
  budget is `RUNTIME_BUSY` for a read, and `RUNTIME_OUTCOME_UNKNOWN` for a change, which ran: ask again with the same
  request id to read its answer.
- `astera runtime start`, `astera runtime pair` and `astera projects add` are refused inside an agent session Astera
  started (`ASTERA_SESSION` is set): opening this machine to the network is for a person, at their own shell or in the
  app.
- `astera runtime status` and `astera runtime clients` carry `health`. `burnedCodes` counts pairing codes that wrong
  guesses used up since the Host started: if it is not 0 and you did not mistype, someone who can reach the port is
  guessing. `unsavedRevocations` names controllers revoked here whose revocation could not be written to disk yet; the
  Host keeps trying, and they stay refused meanwhile, but a Host restart before it lands would let them back in.

## When an answer is lost

A command that changes something carries a request id. If the connection drops before its answer comes back, the
controller reconnects (waiting 1 s, 2 s, 5 s, 10 s, then 30 s, with jitter) and sends the same command again with the
same id, marked as a retry. The Runtime then answers with what the first attempt did, and never runs it twice. When it
cannot say (the first attempt never arrived, or the Runtime restarted since), the answer is `RUNTIME_OUTCOME_UNKNOWN`:
list the newest Jobs or runs on that Runtime before trying again.

## Revoke and remove

- On the Runtime: Unpair beside a controller in Settings › Remote Runtimes › This computer (on or off), or list
  them with `astera runtime clients` and unpair one with `astera runtime revoke --id <clientId>`. Its next command
  is refused with `RUNTIME_AUTH_FAILED`, and its open connections close.
- **Scheduled Jobs.** Revoking a controller's pairing also pauses the scheduled Jobs it made, as a person's pause
  does: their open workers end, and a fire already running stops. The Runtime's Jobs view says "Paused: made from
  {name}, which was unpaired". Only a person on the Runtime can resume them, in the Astera app there or at that user's
  own shell. Every controller, and an agent on the Runtime itself, is refused resuming, running, starting or deleting
  such a Job, starting a worker or reopening a Task of it, and `runs resume` and `runs reconverge` on it.
- The revoke's answer says how many scheduled Jobs it paused, and how many scheduled Jobs on the Runtime have no maker
  on record. Every Job made from this release on records who made it, a controller or the Runtime itself, so only Jobs
  made before this release have no maker. None is guessed: they are counted and left as they are, paused or not, so
  review them on the Runtime. Jobs made on the Runtime itself are never paused by a revoke, and are not counted.
- A Job with a worker held by `worker-retain` is not paused, and the answer and the Host log name it: release the worker
  and pause the Job yourself. A Job whose worker is still starting is named too, and its pause is tried again once
  after the start window, about two minutes. If that retry also fails, or the Host restarts before it, the Job keeps
  its schedule until you pause it; the Host log names the Job, so pause it by hand.
- Sessions the controller started and its Jobs without a schedule keep running, as a disconnect leaves them. The
  person on the Runtime can stop them.
- On the controller: `astera runtimes remove --id <runtimeId|name>`, or Remove in Settings › Remote Runtimes, forgets
  the Runtime here. It does **not** revoke the pairing on the Runtime.
- Turning off (in Settings › Remote Runtimes › This computer, or with `astera runtime stop`) stops listening and
  spends any pairing string not used yet. Pairings stay, the Host and its Jobs keep running.

## Troubleshooting

- **`RUNTIME_OFFLINE`.** Check that the Runtime machine is on and reachable at that address (`ping`, your VPN's
  status), and that `astera runtime status` there says the Gateway listens. A Runtime listening on `127.0.0.1` is not
  reachable from another machine: start it with `--listen` on its LAN or VPN address.
- **`RUNTIME_IDENTITY_CHANGED`.** The machine at that address is not the one you paired, or its profile was replaced.
  If you trust the change, remove the Runtime and pair again with a new string.
- **`RUNTIME_AUTH_FAILED`.** The Runtime revoked this controller, or its profile lost the pairing. Pair again.
- **A pairing string is refused.** It works once, for 10 minutes, and five wrong tries burn it. Run
  `astera runtime pair` again, with `--full-control` if this controller is to change things there.
- **The Runtime does not come back after a reboot.** Check the OS recipe: the task, LaunchAgent or unit exists and
  runs `astera runtime serve`, and Remote is on (`astera runtime status`).
- **Sessions or workers fail to start on the Runtime.** Sign the Runtime's accounts in there, in the Astera app; under
  a service, `claude` and `codex` must be on the recipe's `PATH`.
- **`RUNTIME_CAPABILITY_MISSING` for a newer feature.** The Runtime runs an older Astera; update it there.

## Error codes

| Code | Exit | Meaning |
|---|---|---|
| `RUNTIME_NOT_FOUND` | 4 | no paired Runtime has that id or name, or a name matches two; for a remote terminal, the pty is not on the Runtime any more |
| `RUNTIME_OFFLINE` | 3 | the Runtime could not be reached |
| `RUNTIME_AUTH_FAILED` | 5 | the Runtime does not know this controller: revoked, or never paired |
| `RUNTIME_IDENTITY_CHANGED` | 5 | the Runtime's key is not the one pinned at pairing |
| `RUNTIME_PROTOCOL_MISMATCH` | 9 | the two machines speak different remote protocols; update the older |
| `RUNTIME_CAPABILITY_MISSING` | 9 | the command has no remote form, or that Runtime cannot do it |
| `RUNTIME_BUSY` | 6 | too many connections or calls in flight on the Runtime; try again shortly |
| `RUNTIME_PERMISSION_DENIED` | 5 | a read-only pairing asked for a change; pair again with `astera runtime pair --full-control` on the Runtime. Or an agent controller asked for the report, which answers a person only |
| `RUNTIME_OUTCOME_UNKNOWN` | 6 | an answer was lost and the Runtime cannot say whether the change ran |
| `REMOTE_TIMEOUT` | 7 | no answer in time; the command may still finish |
| `REMOTE_REPLY_TOO_LARGE` | 1 | the answer was over 64 MiB |

The code is in `error.code` of the envelope; read it from there, never from the sentence. `RUNTIME_PROJECT_NOT_FOUND`,
`RUNTIME_ACCOUNT_NOT_FOUND` and `REMOTE_OPERATION_CONFLICT` are reserved names this version does not send: a missing
project or account, or a refusal because of the Runtime's state, comes back with the Runtime's own error.
