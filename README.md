<div align="center">

<img src="assets/banner.jpg" width="640" alt="Astera — build beyond the stars" />

**Run and orchestrate many Claude Code and Codex sessions from one desktop app.**

[![CI](https://github.com/parsingk/Astera/actions/workflows/ci.yml/badge.svg)](https://github.com/parsingk/Astera/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/parsingk/Astera)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D4?logo=windows&logoColor=white)

[Download](#install) · [What it does](#what-it-does) · [Documentation](#documentation) · [Report a bug](https://github.com/parsingk/Astera/issues/new)

</div>

Astera is a Windows desktop app for people who keep more than one agent session going at once. It
holds the sessions side by side, switches accounts for you when a usage limit lands, isolates work in
git worktrees, and lets one agent hand tasks to another and wait for the results.

> **Status:** 1.0.0, Windows only. It drives the `claude` and `codex` CLIs, so it is only as capable
> as whichever of those you have installed.

## Install

Download the latest `astera-<version>-setup.exe` from
**[Releases](https://github.com/parsingk/Astera/releases/latest)** and run it. The app updates itself
from there afterwards; it asks before downloading, since the payload is around 100 MB.

> Releases are not code-signed yet, so Windows SmartScreen may warn on first run — click
> **More info → Run anyway**. Signing through the SignPath Foundation's open-source program is being
> set up; see [docs/releasing.md](docs/releasing.md) for the details.

You will also need:

- **Windows 10 or 11**
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

Building needs **Node.js 22.12+** and the **Visual Studio Build Tools (C++)**, which `node-pty`
requires for its native rebuild.

```bash
npm ci
npm run dev        # run in development
npm run typecheck  # tsc over both the node and web projects
npm run build      # bundle
npm run dist       # bundle + Windows installer into dist-installer/
```

`npm run dist` reads `build/icon.ico`, which is committed. If you change the logo, replace
`resources/logo-source.png` and re-run `powershell -File scripts/gen-icon.ps1` to regenerate every
icon asset.

Note on tests: this project has a Vitest suite colocated as `*.test.ts`, but the test sources are not
distributed in this repository, so `npm test` here reports no test files. CI therefore runs typecheck
and a full bundle build.

## Documentation

- [Slack bot setup](docs/slack-bot-setup.md) — creating the app, tokens, and permissions
- [Releasing](docs/releasing.md) — how a version gets cut and published

## Contributing

Issues and pull requests are welcome. A couple of things worth knowing before you start:

- Run `npm run typecheck` and `npm run build` before opening a PR — that is what CI checks.
- The test sources are not in this repository, so a PR cannot add or change tests. If your change
  needs one, describe the case in the PR and it will be covered on the maintainer's side.
- Bug reports are much easier to act on with the app version, your Windows version, and the relevant
  lines from `%APPDATA%\astera\rolling.log` when the problem involves account rolling.

## Acknowledgements

- The cross-vendor orchestration model — a coordinator dispatching tasks to worker sessions through a
  local CLI, blocking questions, and ownership checks — takes its cues from
  [Orca](https://github.com/stablyai/orca)'s agent orchestration. The implementation here is our own.
- The Windows code-signing pipeline follows the fail-open SignPath flow Orca uses for its releases —
  see [docs/releasing.md](docs/releasing.md).

## License

[Apache License 2.0](LICENSE).
