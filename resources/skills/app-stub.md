---
name: astera-app
description: Launch, drive and photograph this project's own desktop app (an Electron app first) where the person never sees it (a hidden desktop on Windows, a virtual display on Linux, the background on macOS). Use whenever you need to launch, click through or photograph this project's own desktop app — whether the person asked or you are checking your own change, including a native dialog or a drop of files — instead of launching it on the person's screen or taking their pointer or keyboard. Not for web pages in a browser (use astera-browser) and not for the open web.
---

<!-- managed by Astera — the app owns this file. Local edits are overwritten on the next launch.
     Removing this marker makes the app treat the file as user-owned and stop updating it. -->

# Checking the project's app on a hidden desktop (discovery stub)

The full reference comes from the CLI, beside the executable, so it cannot drift from the installed
version.

1. Make sure the terminal is at its prompt, not at a trust or permission dialog, then read the guide.
   This is also the tool check: if the command is not found, this session was not started by Astera.
   Say so and stop. Do not reach for a mouse, keyboard or desktop screenshot tool instead.
   ```
   astera app help
   ```
2. Write one script per round, in a file, and run it. Everything you want to see comes back through
   `log()`:
   ```
   astera app js --file check.js
   ```
   where `check.js` is, for example:
   ```js
   await launch({ config: 'Electron dev' })
   await click('#open-settings')
   await waitFor('.settings-panel')
   log(await screenshot())
   log(await consoleErrors())
   ```
   The app must pass `--remote-debugging-port=%ASTERA_APP_CDP_PORT%` to Electron on Windows, or
   `--remote-debugging-port=$ASTERA_APP_CDP_PORT` on Linux and macOS, or only the native helpers work
   (and on macOS none do); the guide says how.

   If this answers `{"error":"agent app workspace is off"}`, the setting is off. Tell the person where
   it is (Settings, **Agent app workspace**) and stop rather than launching the app on their screen.
