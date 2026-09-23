---
name: astera-orchestration
description: Cross-vendor agent orchestration — dispatch tasks to worker agents running on another vendor (claude/codex) and collect their results. Use when supervision, completion tracking, or breaking down dependent tasks is required. Also use it, through the astera CLI, to plan a Job for later, to read or message another agent session, or to install a missing Astera skill.
---

<!-- managed by Astera — the app owns this file. Local edits are overwritten on the next launch.
     Removing this marker makes the app treat the file as user-owned and stop updating it. -->

# Cross-vendor orchestration (discovery stub)

The full reference comes from the CLI — the single source of truth lives in the executable so it
cannot drift from the installed version.

1. Get the full reference (`astera` is on this session's PATH). This is also the tool check: if the
   command is not found, this session was not started by the app — say so and stop.
   ```
   astera help
   ```
   If `astera` is not found but the variable below is set, call the same program by its absolute
   path. The variable is an environment variable, so read it the way your shell reads those —
   `"$ASTERA_CLI"` in bash or zsh, `$env:ASTERA_CLI` in PowerShell (there `$ASTERA_CLI` alone is an
   unrelated, empty PowerShell variable).

   **If the Run you were handed has completion convergence on, that reference has a whole section on
   it** — read it before your first `worker-start`; the app repairs a checked or reviewed Task itself,
   and refuses commands you would otherwise reach for while that is happening.

## Outside a Run

The same reference has a section (12) for any session, coordinator or not. `astera jobs create`
and `astera tasks add --job` plan work a person starts later. `astera sessions list`, `read` and
`send` see or message another agent session. `astera skills install` puts back a missing Astera
skill. **`sessions send` types into whatever the other session shows**, a permission prompt or a
first-run screen included, so `sessions read` it right before you send.

## When not to use this

If the user only said "hand this off" / "give it to another agent" (or "넘겨라" / "handoff" /
"다른 에이전트에게 줘라"), this is not it — that is a transfer of ownership. Use orchestration only
when supervision, waiting for completion, or dependency coordination was explicitly requested.
