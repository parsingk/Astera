---
name: astera-browser
description: Open and check the web app this project is developing, in a browser the agent controls. Use when the person asks to open the page, see whether it renders, check the console for errors, reload after a change, or click through a flow — on this project's own dev server (localhost). Not for the open web.
---

<!-- managed by Astera — the app owns this file. Local edits are overwritten on the next launch.
     Removing this marker makes the app treat the file as user-owned and stop updating it. -->

# Checking the app in the agent's browser (discovery stub)

The full reference comes from the CLI — the single source of truth lives beside the executable so it
cannot drift from the installed version.

1. Make sure the terminal is at its prompt — not at a trust or permission dialog — then read the
   guide. This is also the tool check: if the command is not found, this session was not started by
   Astera. Say so and stop; do not reach for another browser.
   ```
   astera browser help
   ```
2. Write one script per round, in a file, and run it. Everything you want to see comes back through
   `log()`:
   ```
   astera browser js --file check.js
   ```
   where `check.js` is, for example:
   ```js
   await open()
   await click('#login')
   await waitFor('.dashboard')
   log(await consoleErrors())
   ```
   `open()` with no address opens this project's dev server as started from Astera's Run — that is
   how you know which localhost port is yours. If none is running there, it says so; pass the address
   then (`open('http://localhost:5173/')`). `--file` is used rather than a heredoc because it works in
   every shell — the guide covers reading the script from stdin where your shell supports it.

   If this answers `{"error":"agent browser is off"}`, the setting is off. Tell the person where it
   is — Settings, **Agent browser** — and stop rather than looking for another way to open the page.
