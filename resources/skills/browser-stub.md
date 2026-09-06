---
name: astera-browser
description: Open and check the web app this project is developing, in a browser the agent controls. Use when the person asks to open the page, see whether it renders, check the console for errors, reload after a change, or (later) click through a flow — on this project's own dev server (localhost). Not for the open web.
---

<!-- managed by Astera — the app owns this file. Local edits are overwritten on the next launch.
     Removing this marker makes the app treat the file as user-owned and stop updating it. -->

# Checking the app in the agent's browser (discovery stub)

The full reference comes from the CLI — the single source of truth lives beside the executable so it
cannot drift from the installed version.

1. Check the tooling. An empty value means this session was not started by Astera, or the agent
   browser is off in its settings — say so and stop; do not reach for another browser.
   ```bash
   echo "$ASTERA_CLI"
   ```
2. Make sure the terminal is at its prompt — not at a trust or permission dialog — then read the guide:
   ```bash
   astera browser help
   ```
   If `astera` comes back as command not found, call it as `"$ASTERA_CLI"` — the same program.
3. Write one script per round. Everything you want to see comes back through `log()`:
   ```bash
   astera browser js <<'EOF'
   await open('http://localhost:5173/')
   log(await consoleErrors())
   log(await networkErrors())
   EOF
   ```
