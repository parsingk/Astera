# 2026-08-20 — Six defects, and every net that missed them was written from the code

Walking the orchestration UI by hand for the first time, plus one small feature built through
review, turned up six defects. What they have in common is worth more than any of them
individually: **each safety net that should have caught one had been written by reading the
implementation instead of the requirement.**

## What the screen said, and what the code did

Four defects, all the same shape — the code did what it intended while the screen said something
else. None was caught by 2,600 tests or by a whole-branch review. All four were found within
minutes of opening the app.

| Screen said | Truth |
|---|---|
| `+4` running workers in the sidebar fold | all four had been stopped |
| a spinning glyph on a graph node | that worker's session had been killed |
| a `닫기` button in the detail window | disabled while a form was open, so it never worked |
| "you can create a job right here" | no project was open, so the button was not drawn |

The first two share a root cause: `worker-stop` closes the Dispatch and **deliberately leaves the
Task at `dispatched`**, because the orchestrator is meant to look at `worker-show` and decide for
itself. Everything else in the app agreed the Dispatch was closed — `slotsToFill` frees the slot,
`jobTaskOf` drops `provider`/`startedAt` so the row disappears. Only the sidebar's count read the
Task's *status*, and only the glyph did. The fix moved that one rule into
`core/orchestration/running.ts` where a test can reach it; while it lived in the renderer it had
been copied into two screens, and because both copies were wrong the same way, the check that
compares the two numbers passed.

## The check document had recorded the defect as correct

The F11 scenario said of the spinning glyph: *"this is how it is supposed to be drawn — if it were
drawn as a stopped shape, that would be the bug."* That sentence was written by reading the code,
not by deciding what the screen owes the reader. The code was wrong, so the document sealed the
defect as the expected answer, and every future walk would have passed.

The same document caught the `+4` defect in the next step, because that expectation was written the
other way round: *"the `+1` row disappears."* That is a statement about what a person should see.

**An expectation transcribed from the implementation inherits the implementation's bugs, and then
stops being a check at all — it becomes the thing that protects the defect.** Both halves of that
lesson are in one document, three steps apart.

## The tests had the same problem, from the plan

Building `knowledge`-in-spec through subagent review, both findings the reviewers raised were tests
that did not defend their own requirement — and both came from the plan, not from the implementers:

- The regression test for "a repository with no knowledge gets a byte-identical spec file" compared
  two calls of the same function. Both took the same branch, so a newline added **symmetrically** at
  the insertion point would have produced the same wrong string on both sides and passed. It now
  pins the newline count at that point directly.
- `knowledgeIn`, the only filesystem-touching code in the feature, had no test at all — while the
  design doc named its relative-path rule as the requirement most likely to break, with a failure
  that shows up only in the worker's output. Its evidence was one manual run that nothing preserved.

Both fixes were required to **fail once on purpose** before being accepted: a newline was inserted
until the first test failed, and `path.join` was substituted until the second reported
`knowledge\README.md`. A test that has never failed is not known to work.

## And "there is precedent" pointed the wrong way

`knowledgeIn` was left unbounded on the grounds that `loadRunConfigs`, `jdkScanner`,
`dotnetScanner` and the history strategies all read directories without a timeout. They do — but
every one of them is **user-initiated**, so a stall is a spinner someone can walk away from.
`knowledgeIn` runs on the scheduler's path with nobody watching, and a stall there does not
degrade: `startWorker` never returns, the rollback in `server.ts` never runs, and a `dispatched`
Task never appears in `--ready`, so nothing retries it. The Task is pinned until a human runs
`task-update`. The bound went in afterwards.

**A precedent is only a precedent if the failure it survived is the failure you are facing.** Count
the callers, not the calls.
