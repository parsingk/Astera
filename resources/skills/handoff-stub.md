---
name: astera-handoff
description: Leave a structured handoff memo for whoever continues this work in a fresh session. Use after finishing a meaningful step: a sub-task done, a test or build result in hand, a decision made, a large change finished, or just before moving to the next stage. Not every turn.
---

<!-- managed by Astera — the app owns this file. Local edits are overwritten on the next launch.
     Removing this marker makes the app treat the file as user-owned and stop updating it. -->

# Leaving a handoff memo

If this session ever has to start over without its conversation — a usage limit, a restart, a resume
from history — the next agent gets a briefing the app assembles from facts: git, the last command,
the recent requests. That briefing cannot carry two things: **what the person told you not to do**,
and **why you chose the approach you chose**. This memo is the only way those survive. Leave one at
meaningful steps, in your own words.

## When

After a meaningful step, not on a schedule:

- a sub-task is done
- you have a test, build or lint result in hand
- you just made a design decision, or the person just stated a constraint
- a large structural change is finished
- you are about to move to the next stage of the work

Not after every response, not after every tool call, not for reading files. A memo a minute is noise;
a memo per milestone is a handoff.

## What

Only what the work supports. Do not summarise the conversation; do not claim something is done that
you have not seen done; no secrets; no code blocks. The person's constraints go in **their words**.
Strings are cut at 300 characters and the briefing shows at most 10 items per list (20 for files),
so put the important items first.

## How

Write the document to a file in the shell's temp directory — never inside the project — run the
command below, then delete the file so nothing is ever committed (heredocs behave differently
across shells, which is why a file is more reliable than one):

```bash
astera handoff --memo - < handoff.json
```

where `handoff.json` (in the temp directory) is, for example:

```json
{
  "objective": "make the failing ordering test pass",
  "completed": ["ran the suite: 5 of 6 pass", "found the cause: list() returns readdir order"],
  "currentProblems": ["the ordering test still fails"],
  "nextActions": ["write a save time into each note in put()", "sort list() on it", "run npm test"],
  "constraints": ["do not sort on the id — the id format is about to change"],
  "decisions": [{ "decision": "store a save time", "reason": "the constraint rules out sorting on the id" }],
  "verification": [{ "type": "test", "status": "failed", "summary": "1 of 6" }],
  "relevantFiles": ["src/store.js", "test/store.test.js"]
}
```

Every field is optional except that the memo must say something. Lists are plain strings.
`verification[].type` is one of `test`, `build`, `lint`, `typecheck`, `review`, `other`; `.status` is
`passed`, `failed` or `unknown`. A new memo replaces your previous one for this session, so write the
current state, not a diff.

If the command answers `{"error":"smart resume is off"}`, the setting is off — tell the person where
it is (Settings, **Session resume strategy**) and carry on without a memo. `unknown session: …`
right after a tab opened means the app has not caught up to this session yet; try once more.

If `astera` is not found but the environment variable is set, call the same program by its absolute
path: `"$ASTERA_CLI"` in bash or zsh, `& $env:ASTERA_CLI` in PowerShell (there `$ASTERA_CLI` alone is
an unrelated, empty variable). If neither exists, this tab was opened before Smart Resume was turned
on; say so — a new tab is the fix.
