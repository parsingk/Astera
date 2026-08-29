<div align="center">

<img src="assets/banner.jpg" width="640" alt="Astera — build beyond the stars" />

**Keep Claude Code and Codex working while you are away.**

[![CI](https://github.com/parsingk/Astera/actions/workflows/ci.yml/badge.svg)](https://github.com/parsingk/Astera/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/parsingk/Astera?logo=github)](https://github.com/parsingk/Astera/releases/latest)
[![License](https://img.shields.io/github/license/parsingk/Astera?color=blue)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-555)

[Download](#install) · [What it does](#what-it-does) · [Jobs](#jobs) · [Documentation](#documentation) · [Report a bug](https://github.com/parsingk/Astera/issues/new)

**English** · [한국어](README.ko.md) · [日本語](README.ja.md) · [Español](README.es.md)

<img src="assets/hero.jpg" width="960" alt="Astera running four sessions in one window as a 2x2 grid — three Claude Code and one Codex, on two Claude accounts and a Codex one — with the accounts and the project history in the sidebar" />

</div>

Astera is a desktop workbench for long-running Claude Code and Codex work. Keep several sessions
moving without staying at the desk: schedule them, switch accounts when a usage limit lands, and
resume the same work. Concurrent sessions stay isolated in their own git worktrees, and Slack keeps
the loop open from your phone. When the work has dependencies, a Job coordinates tasks across both
vendors, checks the result, and waits when a human decision is needed.

> **Status:** Windows, macOS and Linux. It drives the `claude` and `codex` CLIs, so it is only as
> capable as whichever of those you have installed.

## Built for long-running agent work

- **Leave sessions unattended.** Start work at a scheduled time, get notified in Slack when a turn
  ends or a limit is reached, and continue on the next configured account without losing the thread.
- **Run work in parallel without sharing a checkout.** Keep Claude Code and Codex sessions together
  in one window while each session can work from its own git worktree.
- **Coordinate work that has more than one step.** Model dependencies as a Job, run ready tasks on
  either vendor, and use builds, tests, reviews, and human decisions as completion gates.

## What it does

**Project workspaces**
- Many `claude` / `codex` sessions in one window, as tabs and as split panes
- A terminal per project

**Accounts**
- Several accounts per vendor, each isolated through its own `CLAUDE_CONFIG_DIR` / `CODEX_HOME`
- **Account rolling:** when a session hits a usage limit, Astera detects it from the transcript,
  works out the reset time, and resumes the work on the next account
- **Resume strategy:** keep the CLI's original conversation — the default — or opt into
  **Smart Resume (experimental)**, which starts the next session from a compact checkpoint instead
- Optional import of a new account's setup from your default one: `settings.json`, the MCP server
  list, and the `skills`, `commands` and `agents` directories

<div align="center">
<img src="assets/rolling.gif" width="820" alt="Diagram: a running session hits its weekly limit, Astera reads the reset time from the transcript, switches to the next account, and the same conversation carries on" />
<img src="assets/rolling-demo.gif" width="820" alt="Screen recording: a session hits a usage limit, Astera switches to the next account with the same conversation restored, and when there is nowhere left to go it says when it will resume" />
<p><a href="https://github.com/parsingk/Astera/blob/main/assets/astera-demo-rolling.mp4">▶ Full recording (28s)</a></p>
</div>

**Scheduling and remote control**
- Schedule sessions to start at a given time
- Slack notifications when a turn finishes or a limit is hit, and Slack-side replies back into a
  session — so you can keep an eye on a run from your phone

<div align="center">
<img src="assets/schedule.gif" width="820" alt="Diagram: at 03:00 a scheduled session starts on its own, runs the command left for it, finishes, and Slack reports the result" />
<img src="assets/schedule-demo.gif" width="820" alt="Screen recording: a session showing its schedule, and the command going in on its own when the time comes" />
<p><a href="https://github.com/parsingk/Astera/blob/main/assets/astera-demo-schedule.mp4">▶ Full recording (22s)</a></p>
</div>

**Run**
- A run configuration has a kind — Shell, npm, Node.js, Gradle, Maven, cargo, go, Python, pytest,
  Docker Compose, Dockerfile or .NET — and holds only the fields that kind actually has
- The command is assembled when you run it, so the Gradle wrapper, the package manager your lockfile
  implies and the quoting your shell needs are worked out then, not typed into a box
- Your build files are read, so a project's npm scripts are already there as configurations, and a
  Gradle or Maven project starts with the standard tasks and goals. A detected one shows in italics
  until you edit it, which saves it as yours

**Editor and shortcuts**
- One key shows and hides the explorer — `Ctrl`/`Cmd`+`Shift`+`E` for the file tree, the run toolbar
  and the run console, leaving the panes where they are
- One tab bar per pane, holding both kinds of tab: a file sits beside the session that is changing
  it, a split shows the two at once, and `Ctrl`+`Tab` walks the active pane's row
- A real editor, not a text box: CodeMirror with syntax highlighting for TypeScript, JavaScript,
  Python, Go, Rust, C/C++, Java, PHP, SQL, HTML, CSS, Markdown, JSON, YAML and XML, open across tabs
- **Markdown side by side:** a markdown file opens as editor, split, or preview, and
  `Ctrl`/`Cmd`+`Shift`+`V` cycles the three — in split, the two panes follow each other's scrolling
- A file tree with git state on each entry (new, modified, deleted, conflict), and create, rename,
  move, copy, delete and reveal-in-Finder/Explorer
- **Local history:** a snapshot is taken before a delete, so an agent's cleanup — or your own — is
  recoverable. Kept 30 days, up to 200 MB per project
- Every shortcut is remappable in settings, defaulting to `Cmd` on macOS and `Ctrl` elsewhere:
  splitting panes, moving focus between them, cycling sessions, closing a file tab

**Appearance**
- Seven themes — Vega, Orion, Umbra, Aurora, Antares, Quasar and Sirius — picked from cards that each draw
  themselves in their own palette, so you choose by looking rather than by name
- A theme is more than colours: the corner radius, the shadows, the UI typeface and the row density
  come with it, so Quasar puts more on screen than Umbra does
- Switching one changes what is already open — a running terminal's colours are swapped in place, so
  it keeps its scrollback
- The terminal font is chosen separately, including the fallback for CJK text

**Also**
- Korean, English, Japanese, and Spanish UI, plus a System option that follows the OS locale
- Auto-update from GitHub Releases

## Jobs

Jobs is opt-in. Turn on **Agent orchestration** in settings to add the Jobs sidebar. A job is a
dependency graph whose tasks can run under either vendor, and there are two ways to run one.

<div align="center">
<img src="assets/jobs.gif" width="820" alt="Diagram: a coordinator follows a job's dependency graph, starts the two ready tasks on both vendors at once, uses a test suite to prove one done, waits for both dependencies before continuing, and leaves an unresolved decision for a person" />
<img src="assets/jobs-demo.gif" width="820" alt="Screen recording: a job advancing through its dependency graph — a worker hits a usage limit and resumes by itself, both dependencies report, and the last task passes a validation and a cross-vendor review" />
<p><a href="https://github.com/parsingk/Astera/blob/main/assets/astera-killer-demo.mp4">▶ Full recording (30s)</a></p>
</div>

### 1. Build it in the Jobs sidebar

1. Make sure the project is a git repository with a branch checked out.
2. Click **New job**, enter the **Objective**, choose a **Coordinator account**, set **Run at once**,
   and optionally add a schedule.
3. Add tasks with instructions, one or more worker accounts, and any dependencies. Builds, tests and
   cross-vendor reviews can be attached as completion checks.
4. Click **Run**. A normal job opens its coordinator; a scheduled job activates its schedule.

The Jobs view shows the dependency graph, active workers, questions and timeline. Parallel tasks can
use separate git worktrees, and the finished result stays out of your checked-out branch until you
click **Merge**. See the [complete Job lifecycle](docs/jobs.md) for details.

### 2. Run it with the `astera-orchestration` skill — an agent coordinates

Turn on **Agent orchestration before starting the coordinator session**. At startup that session
receives the `astera` CLI on its `PATH` and the `astera-orchestration` skill. You can ask naturally:

> Use the `astera-orchestration` skill to coordinate this work: refactor the authentication module,
> add regression tests after the refactor, and verify the test suite.

The skill can also be invoked explicitly as `/astera-orchestration`. It is for multi-step work that
needs supervision, completion tracking or dependency coordination. The coordinator creates the run
and tasks, dispatches Claude and Codex workers, waits for their reports and brings questions back to
you. Runs created this way also appear in the Jobs sidebar when they belong to the open project.

Skills are loaded when a session starts, so enable Agent orchestration first and then open a new
coordinator session. A simple one-off handoff does not need an orchestration run.

To read the coordinator CLI reference:

```bash
astera help
```

If `astera` is not on `PATH`, use the path in `$ASTERA_CLI`. An empty value means the session was not
started by Astera, or Agent orchestration is off.

## Install

Download the latest release from
**[Releases](https://github.com/parsingk/Astera/releases/latest)** and run it — `astera-<version>-setup.exe`
on Windows, `astera-<version>-universal.dmg` on macOS, and `astera-<version>-x86_64.AppImage` or
`astera-<version>-amd64.deb` on Linux. On Windows the app updates itself from there afterwards,
asking before it downloads.

> **macOS builds are not notarized yet**, which costs you two things. Gatekeeper blocks the first
> launch, so after dragging the app to Applications, clear the quarantine flag macOS put on it:
>
> ```bash
> xattr -cr /Applications/Astera.app
> ```
>
> That removes the "downloaded from the internet" marker, which is the only thing standing in the way
> — the app itself is signed (ad-hoc), so nothing else about it changes. System Settings →
> **Privacy & Security** → **Open Anyway** works too if you prefer clicking; the Control-click →
> **Open** shortcut does not, macOS 15 (Sequoia) removed it.
>
> And auto-update stays off until the build is notarized, so a new version means downloading the dmg
> again. On Windows, SmartScreen may warn on first run — click **More info → Run anyway**.
>
> Signing through the SignPath Foundation's open-source program (Windows) and an Apple Developer ID
> (macOS) is being set up — see the [Code signing policy](docs/code-signing.md) for who signs what,
> and [docs/releasing.md](docs/releasing.md) for the mechanics. The Linux builds are unsigned, which
> is what that channel expects.

> **On Linux**, neither artifact runs straight from the download. Give the AppImage the executable
> bit:
>
> ```bash
> chmod +x astera-<version>-x86_64.AppImage
> ```
>
> and install the deb through apt rather than `dpkg -i`, so its dependencies come with it:
>
> ```bash
> sudo apt install ./astera-<version>-amd64.deb
> ```
>
> The deb declares the supported floor, so apt refuses an older system instead of installing
> something that cannot start.

You will also need:

- **Windows 10 or 11**, **macOS 12 (Monterey) or later**, or **Ubuntu 22.04 / Debian 12 or later**
- **[Claude Code](https://claude.com/claude-code) and/or the Codex CLI** on your `PATH` — Astera runs
  them, it does not replace them

## Build from source

Building needs **Node.js 22.12+**, and a C++ toolchain for `node-pty`'s native rebuild (via
`electron-builder install-app-deps`): the **Visual Studio Build Tools (C++)** on Windows, the
**Xcode Command Line Tools** (`xcode-select --install`) on macOS, or **build-essential** and
**python3** on Linux, where node-pty ships no prebuild and is always compiled.

```bash
npm ci
npm run dev        # run in development
npm run typecheck  # tsc over both the node and web projects
npm run build      # bundle
npm run dist       # package for the current platform into dist-installer/
npm run dist:win   # Windows installer
npm run dist:mac   # macOS universal dmg + zip
npm run dist:linux # Linux AppImage + deb
```

`npm run dist` reads the committed icon assets (`build/icon.ico` on Windows, `build/icon.icns` on
macOS, and the shared `resources/tray.png` on both) rather than generating them. If you change the logo, replace
`resources/logo-source.png` and re-run the matching script on its own platform — `powershell -File
scripts/gen-icon.ps1` (ico/png) on Windows, `sh scripts/gen-icon-mac.sh` (icns) on
macOS — then commit the regenerated assets.

Tests are colocated as `*.test.ts` and run with `npm test` (Vitest). CI runs the typecheck, the suite,
and a full bundle build.

## Documentation

- [Slack bot setup](docs/slack-bot-setup.md) — creating the app, tokens, and permissions
- [Releasing](docs/releasing.md) — how a version gets cut and published
- [Code signing policy](docs/code-signing.md) — who signs the releases, what is signed, and privacy

## Contributing

Issues and pull requests are welcome. A couple of things worth knowing before you start:

- Run `npm run typecheck`, `npm test` and `npm run build` before opening a PR — that is what CI checks.
- A change to behaviour is expected to come with a test. One rule worth knowing before you touch the
  rolling tests: the usage-limit phrases are split with `+` on purpose, because Astera watches session
  output for them — see [CONTRIBUTING](.github/CONTRIBUTING.md).
- Bug reports are much easier to act on with the app version, your OS version, and the relevant
  lines from `rolling.log` when the problem involves account rolling — `%APPDATA%\astera\rolling.log`
  on Windows, `~/Library/Application Support/astera/rolling.log` on macOS.

## Acknowledgements

- The cross-vendor orchestration model — a coordinator dispatching tasks to worker sessions through a
  local CLI, blocking questions, and ownership checks — takes its cues from
  [Orca](https://github.com/stablyai/orca)'s agent orchestration. The implementation here is our own.
- The Windows code-signing pipeline follows the fail-open SignPath flow Orca uses for its releases —
  see [docs/releasing.md](docs/releasing.md).
- macOS releases are meant to be signed and notarized with an Apple Developer ID, and the workflow is
  ready for it. Unlike the Windows path, this one is not optional: without it, `electron-updater`'s
  macOS auto-update (built on Squirrel.Mac) refuses to install updates at all — so until the
  certificate is in place, builds ship ad-hoc signed and do not auto-update.

## License

[Apache License 2.0](LICENSE).
