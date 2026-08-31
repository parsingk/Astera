---
name: astera-task
description: Record a piece of work in Astera's How It Works. Use when the person starts a task with /astera-task, and again when that task is finished.
---

<!-- managed by Astera — the app owns this file. Local edits are overwritten on the next launch.
     Removing this marker makes the app treat the file as user-owned and stop updating it. -->

# Recording one piece of work

The person invoked this skill with an objective. Astera records what changed between the start of
that work and its end, and writes it up for someone who does not read code. **You mark both ends.**

1. Check the tooling. An empty value means this tab was opened before work-unit tracking was
   turned on — say so, and that a new tab is the fix:
   ```bash
   echo "$ASTERA_CLI"
   ```
2. Declare the start, with the objective the person gave you, verbatim:
   ```bash
   astera session-task-start --objective "<their words>"
   ```
   If this reports that it interrupted an earlier task, tell the person — that one is waiting for
   them on the How It Works screen.
3. Do the work. It may take many turns and many messages from them; **it is all one task.** Do not
   start another one partway through.
4. When the objective is met, declare the end. Report what you actually ran:
   ```bash
   astera session-task-complete \
     --check tests=passed --check build=skipped \
     --summary "<one line on what is different now>"
   ```
   `--check` takes `<name>=<passed|failed|skipped>` and repeats. **Never claim a check you did not
   run** — `skipped` is a real answer and is worth more than a guess. The app does not run these
   and cannot catch a false one.
5. If you cannot finish, **do not call `session-task-complete`**. Say what is left; the person
   decides. If the work is being abandoned:
   ```bash
   astera session-task-cancel --reason "<why>"
   ```

## What this is not

It does not change your work. It records what your work changed.

Do not use it inside a Jobs Run — a Run records itself, and the commands are refused there.

If `astera` comes back as command not found, call it as `"$ASTERA_CLI"`.
