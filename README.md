<div align="center">

<img src="assets/banner.jpg" width="640" alt="Astera — build beyond the stars" />

**Run and orchestrate many Claude Code and Codex sessions from one desktop app.**

[![CI](https://github.com/parsingk/Astera/actions/workflows/ci.yml/badge.svg)](https://github.com/parsingk/Astera/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/parsingk/Astera?logo=github)](https://github.com/parsingk/Astera/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/parsingk/Astera/total)](https://github.com/parsingk/Astera/releases)
[![License](https://img.shields.io/github/license/parsingk/Astera?color=blue)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-555)

[Download](#install) · [What it does](#what-it-does) · [Documentation](#documentation) · [Report a bug](https://github.com/parsingk/Astera/issues/new)

</div>

Astera is a desktop app for people who keep more than one agent session going at once. It
holds the sessions side by side, switches accounts for you when a usage limit lands, isolates work in
git worktrees, and lets one agent hand tasks to another and wait for the results.

> **Status:** Windows and macOS. It drives the `claude` and `codex` CLIs, so it is only as
> capable as whichever of those you have installed.

## Install

Download the latest release from
**[Releases](https://github.com/parsingk/Astera/releases/latest)** and run it — `astera-<version>-setup.exe`
on Windows, `astera-<version>-universal.dmg` on macOS. On Windows the app updates itself from there
afterwards, asking before it downloads.

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
> and [docs/releasing.md](docs/releasing.md) for the mechanics.

You will also need:

- **Windows 10 or 11**, or **macOS 12 (Monterey) or later**
- **[Claude Code](https://claude.com/claude-code) and/or the Codex CLI** on your `PATH` — Astera runs
  them, it does not replace them

## What it does

**Sessions**
- Many `claude` / `codex` sessions in one window, as tabs and as split panes
- Per-project terminal, and a file explorer with an editor, file operations, and local history
- Git status shown in the file tree

**Accounts**
- Several accounts per vendor, each isolated through its own `CLAUDE_CONFIG_DIR` / `CODEX_HOME`
- **Account rolling:** when a session hits a usage limit, Astera detects it from the transcript,
  works out the reset time, and resumes the work on the next account
- Optional syncing of settings and personal content directories between accounts

**Scheduling and remote control**
- Schedule sessions to start at a given time
- Slack notifications when a turn finishes or a limit is hit, and Slack-side replies back into a
  session — so you can keep an eye on a run from your phone

**Cross-vendor orchestration**
- A coordinator session dispatches tasks to worker sessions — including workers on the *other* vendor
- Workers report back through the bundled `astera` CLI; the coordinator waits on completion,
  dependencies, questions, and escalations
- Each task can run in its own git worktree so parallel workers do not collide

**Also**
- Korean and English UI
- Customisable keybindings
- Auto-update from GitHub Releases

## Orchestration quickstart

Turn orchestration on in settings, then start a session. That session gets the `astera` CLI on its
`PATH` and a skill describing how to use it, so you can simply ask it to coordinate work. To read the
full reference yourself:

```bash
astera help
```

If `astera` comes back as `command not found`, the absolute path is in `$ASTERA_CLI` — the two are
the same program. An empty `$ASTERA_CLI` means the session was not started by Astera, or
orchestration is off.

## Build from source

Building needs **Node.js 22.12+**, and a C++ toolchain for `node-pty`'s native rebuild (via
`electron-builder install-app-deps`): the **Visual Studio Build Tools (C++)** on Windows, or the
**Xcode Command Line Tools** (`xcode-select --install`) on macOS.

```bash
npm ci
npm run dev        # run in development
npm run typecheck  # tsc over both the node and web projects
npm run build      # bundle
npm run dist       # package for the current platform into dist-installer/
npm run dist:win   # Windows installer
npm run dist:mac   # macOS universal dmg + zip
```

`npm run dist` reads the committed icon assets (`build/icon.ico` on Windows, `build/icon.icns` on
macOS, and the shared `resources/tray.png` on both) rather than generating them. If you change the logo, replace
`resources/logo-source.png` and re-run the matching script on its own platform — `powershell -File
scripts/gen-icon.ps1` (ico/png) on Windows, `sh scripts/gen-icon-mac.sh` (icns) on
macOS — then commit the regenerated assets.

Note on tests: this project has a Vitest suite colocated as `*.test.ts`, but the test sources are not
distributed in this repository, so `npm test` here reports no test files. CI therefore runs typecheck
and a full bundle build.

## Documentation

- [Slack bot setup](docs/slack-bot-setup.md) — creating the app, tokens, and permissions
- [Releasing](docs/releasing.md) — how a version gets cut and published
- [Code signing policy](docs/code-signing.md) — who signs the releases, what is signed, and privacy

## Contributing

Issues and pull requests are welcome. A couple of things worth knowing before you start:

- Run `npm run typecheck` and `npm run build` before opening a PR — that is what CI checks.
- The test sources are not in this repository, so a PR cannot add or change tests. If your change
  needs one, describe the case in the PR and it will be covered on the maintainer's side.
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
