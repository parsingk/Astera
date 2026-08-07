---
name: astera-orchestration
description: Cross-vendor agent orchestration — dispatch tasks to worker agents running on another vendor (claude/codex) and collect their results. Use when supervision, completion tracking, or breaking down dependent tasks is required.
---

<!-- managed by Astera — the app owns this file. Local edits are overwritten on the next launch.
     Removing this marker makes the app treat the file as user-owned and stop updating it. -->

# Cross-vendor orchestration (discovery stub)

The full reference comes from the CLI — the single source of truth lives in the executable so it
cannot drift from the installed version.

1. Check the tooling (an empty value means this session was not started by the app, or
   orchestration is off — a clearer diagnosis than `command not found` from `astera`):
   ```bash
   echo "$ASTERA_CLI"
   ```
2. Get the full reference (`astera` is on this session's PATH):
   ```bash
   astera help
   ```
   On `command not found`, retry with the absolute path to the same program (this works regardless
   of the shell):
   ```bash
   "$ASTERA_CLI" help
   ```

## When not to use this

If the user only said "hand this off" / "give it to another agent" (or "넘겨라" / "handoff" /
"다른 에이전트에게 줘라"), this is not it — that is a transfer of ownership. Use orchestration only
when supervision, waiting for completion, or dependency coordination was explicitly requested.
