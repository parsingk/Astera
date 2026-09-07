---
name: astera-orchestration
description: Cross-vendor agent orchestration — dispatch tasks to worker agents running on another vendor (claude/codex) and collect their results. Use when supervision, completion tracking, or breaking down dependent tasks is required.
---

<!-- managed by Astera — the app owns this file. Local edits are overwritten on the next launch.
     Removing this marker makes the app treat the file as user-owned and stop updating it. -->

# Cross-vendor orchestration (discovery stub)

The full reference comes from the CLI — the single source of truth lives in the executable so it
cannot drift from the installed version.

1. Get the full reference (`astera` is on this session's PATH). This is also the tool check: if the
   command is not found, this session was not started by the app, or orchestration is off — say so
   and stop.
   ```
   astera help
   ```
   If `astera` is not found but the variable below is set, call the same program by its absolute
   path. The variable is an environment variable, so read it the way your shell reads those —
   `"$ASTERA_CLI"` in bash or zsh, `$env:ASTERA_CLI` in PowerShell (there `$ASTERA_CLI` alone is an
   unrelated, empty PowerShell variable).

## When not to use this

If the user only said "hand this off" / "give it to another agent" (or "넘겨라" / "handoff" /
"다른 에이전트에게 줘라"), this is not it — that is a transfer of ownership. Use orchestration only
when supervision, waiting for completion, or dependency coordination was explicitly requested.
