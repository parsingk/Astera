# ADR-004 — The app writes orchestration state itself, instead of only through the CLI

**Status:** accepted, 2026-08-19

## Context

The `job-authoring` slice (`docs/superpowers/plans/2026-08-19-job-authoring.md`) set out to let a
person build and watch a Run from the Jobs sidebar instead of typing `astera` commands in a
coordinator session. The plan and the roadmap it drew from had made three predictions about how far
that would go. All three turned out to be wrong once the slice was actually implemented, and this ADR
is the record of what changed and why — written from the execution ledger
(`.superpowers/sdd/2026-08-19-job-authoring/progress.md`), not from what the plan expected.

- **`src/main/ipc.ts`'s orchestration IPC is read-only.** Before this slice, `orch.list` and
  `orch.runDetail` were the only orchestration channels the renderer had, and the doc comment on
  `OrchApi` said so explicitly: "Read-only by design. … there is no mutating counterpart here." The
  stated reason was that `task-create`, `worker-start`, `gate-resolve` and the rest were
  `COORDINATOR_ONLY` commands "the orchestrator reaches through the CLI."
- **Roadmap item 4b's "not building this": a screen that makes Tasks one at a time through a form.**
  The roadmap had explicitly scoped Task authoring out of the app — a Task was something a coordinator
  (a person or an agent in a terminal) created with `task-create`, and the Jobs sidebar only showed the
  result.
- **Half of roadmap item 4 (the scheduler) got pulled forward.** Automatic dispatch — the app deciding
  on its own when to call `worker-start` — was future work belonging to a later roadmap slice, not to
  job-authoring.

All three were reversed inside this one slice, and the reversal did not stop where the plan expected
it to. In particular, letting the app dispatch workers on its own ran straight into a problem the plan
had not scoped at all: with more than one worker running at once, they cannot all work in the same
project folder without stepping on each other's uncommitted changes, which forced a decision — made by
the user mid-execution, not predicted by the plan — about who reconciles that in the end.

## Decision

**1. Collapse the write side into one channel, `orch.command`, instead of adding mutating IPC calls
one command at a time.**

*Reasoning at the time.* The renderer had no way to change orchestration state at all — `orch.list` and
`orch.runDetail` only ever read `getState()`. The obvious next step, once the sidebar needed to create
Runs and Tasks, was to add a narrow, purpose-built IPC handler per action (`orch.createTask`,
`orch.startWorker`, …), mirroring the CLI's own commands one by one.

*What changed.* Instead, `src/main/ipc.ts` added exactly one new handler,
`ipcMain.handle('orch.command', (_e, projectPath, cmd, args) => …)` (`ipc.ts:1856-1863`), that calls
`orchHandleCommand(orch.deps, { sessionId: UI_CALLER }, cmd, args ?? {})` — the same `handleCommand`
function `src/main/orchestration/server.ts` dispatches every CLI command through. `UI_CALLER` is the
literal string `'astera:app'` (`ipc.ts:93`). No command-specific channel exists; the renderer names the
command by its CLI string (`'task-create'`, `'worker-start'`, `'gate-create'`, `'task-update'`,
`'dispatch-show'`, …) and passes the same argument keys the CLI would. The guard is `assertAllowedPath`
only — the same one `orch.list` runs, and deliberately *not* followed by `repoPathOf`/`runsForProject`
narrowing (unlike `orch.runDetail`, which does apply that narrowing). The reasoning for one channel is
recorded at the call site itself (`ipc.ts:1850-1852`): a door per command means the transition table,
the circuit breaker, the duplicate-report guard and the audit log would each need to exist twice, and a
fix to one door and not the other silently diverges.

This also surfaced that "read-only" had never been a statement about permission. `COORDINATOR_ONLY`
(`server.ts:230-235`, checked as `isWorker && COORDINATOR_ONLY.has(cmd)`) blocks only **worker**
sessions — a session that owns an open Dispatch. `UI_CALLER` has never owned a Dispatch, so `isWorker`
is always false for it, and every command was already open to it before `orch.command` existed. What
was missing was the IPC door, not authorization through it.

*What to check to reverse it.* Delete the `orch.command` handler (`ipc.ts:1856-1863`), the
`OrchApi.command` method and its doc (`src/core/types.ts:733-742`), and the preload wiring
(`src/preload/index.ts`). Every renderer caller of `window.api.orch.command` then fails to compile —
as of this ADR that is `NewRunModal.tsx` (`run-create`), `NewTaskModal.tsx` (`task-create`), and
`RunDetail.tsx`'s `startTask`/`stopTask`/`restartTask`/`askQuestion` (`worker-start`, `dispatch-show`
+ `worker-stop`, `task-update`, `gate-create`). None of that break is silent — the type system finds
every call site. Separately, restore a "read-only" description to the comments that actually cite
this ADR by name — `ipc.ts:1854-1855`, `types.ts:711`, and `RunDetail.tsx:75-81`'s header (added once
this same fix round found `RunDetail.tsx` carrying the same stale claim, after this ADR's own text had
already been drafted). A fourth comment, `ipc.ts:1798-1800`, narrates the same reversal in prose but
does not name the ADR — check it too; reversing this has to update every place that describes the old
behavior, not only the ones that cite this file by number. The app's own scheduler does **not** go
through this channel (it calls `orchHandleCommand` directly via `deps`, `ipc.ts`'s slot-fill loop), so
removing `orch.command` does not by itself disable auto-dispatch — see Decision 3.

**2. Build the per-Task authoring screen the roadmap had decided not to build.**

*Reasoning at the time.* Roadmap item 4b scoped this out on purpose: Task creation needs `--deps`,
optional `--validate`/`--review`, and a title/spec pair, and building a form for all of that seemed
like duplicating what a coordinator already does better in a terminal — the Jobs sidebar's job was to
show a Run's state, not to construct one.

*What changed.* Task 7 added `NewRunModal` (`src/renderer/src/components/NewRunModal.tsx`), opened by
a `+ 새 작업` button that exists both above the populated Run list and on the empty state
(`JobsView.tsx`). It collects an objective, a provider, and a concurrency limit, and always sends
`auto: true` on `run-create` — a UI-created Run has no switch for this; it is always auto-dispatched
(see Decision 3). Task 8 added `NewTaskModal` (`NewTaskModal.tsx`), opened by `+ Task 추가` inside
`RunDetail`'s graph pane. Its dependency picker is the graph itself: while the form is open, clicking a
node toggles that Task's id into `deps` and marks it with a small accent-coloured `✓` (a different
visual channel from the teal filter ring the same graph uses the rest of the time, so the two meanings
never collide on one node). Task 9 layered four per-node buttons onto the same graph —
`띄우기`/`멈추기`/`물어보기`/`다시 띄우기` — covering `worker-start`, `worker-stop` (found via
`dispatch-show`, since `worker-stop` takes a Dispatch id, not a Task id), `gate-create`, and the
`task-update`-as-escape-hatch restart. All four route through `orch.command` (Decision 1); none of them
opened a new IPC surface of their own.

*What to check to reverse it.* Delete `NewRunModal.tsx`, `NewTaskModal.tsx`, and the node-button block
inside `RunDetail.tsx`'s `Graph`/`node()` (`showStart`/`showGate`/`showStop`/`showRestart` and their
handlers). Remove the `+ 새 작업` / `+ Task 추가` entry points from `JobsView.tsx` and `RunDetail.tsx`.
Check `App.tsx`'s `newRunOpen` state and its join into `modalOpenRef` (`App.tsx:1620`, and the `||
newRunOpen` at `:1680`) — both become dead once the modal is gone. Check the `jobs.new.*`, `jobs.task.*`
and `jobs.node.*` keys in all four i18n catalogs (`src/core/i18n/messages/{ko,en,ja,es}.ts`) — they
become unused, and `jobs.empty.hint`'s current wording (which now advertises both the sidebar button
and the coordinator session) would need to go back to mentioning only the coordinator session.

**3. Let the app dispatch its own workers, and merge their git worktrees back into the project folder
itself — the largest reversal, and the one the plan never scoped.**

*Reasoning at the time.* Automatic dispatch was roadmap item 4, planned for a later slice. This slice's
Runs were expected to behave exactly like a coordinator's: Tasks reach `ready` and then wait for a
human (or a coordinator script) to call `worker-start` by hand, one at a time, the same as today.

*What changed.* Task 3 hung a scheduler off every orchestration write: the shared `setState` callback
(`ipc.ts:1383-1389`) fires `void runScheduler().catch(...)` after every `store.save` + push, and
`runScheduler` fills open slots via `slotsToFill` (`src/core/orchestration/schedule.ts`) for any Run
with `autoDispatch: true`, up to `Run.concurrency` (`DEFAULT_CONCURRENCY = 3` when unset). A Run created
from the UI is **always** `autoDispatch` — `NewRunModal.tsx` hard-codes `auto: true` on `run-create`;
there is no switch. So a UI-created Run starts running itself the moment its Tasks become `ready`, with
no further action from anyone.

This is where the reversal outgrew what the plan anticipated, and where a real user decision (recorded
in the ledger, not predicted by the plan) had to be made: with `concurrency` above 1, several workers
run at once, and they cannot all sit in the project folder without one worker's uncommitted changes
blocking a place for the others to land. The user's decision was **the app merges automatically, and
calls a person in only when it cannot merge safely** — minimizing human involvement to "only when
everything else is done or genuinely stuck," rather than asking for review of every merge.

Two rules followed from that decision, and both are load-bearing for the rest of the design:

- **`Run.concurrency` decides *where* every ordinary worker in that Run runs, not just how many run
  at once.** `concurrency <= 1` means the Run's single worker runs in the project folder itself,
  sequentially (`worktree: 'current'`); `concurrency >= 2` means every ordinary Task's worker gets its
  own git worktree (`worktree: 'new'`) — never a mix among ordinary Tasks, because mixing is exactly
  the "one worker in the shared folder" case the merge step exists to avoid. This is also why the
  `띄우기` button in `RunDetail.tsx` only renders when `run.concurrency` (or the default) is `<= 1`
  **and** the Run has a `provider` — the renderer cannot name a worktree (`nameForTask` needs
  `node:path`, which cannot enter `tsconfig.web.json`), so a manual start is only offered in the one
  placement it can honor without inventing a name.

  **The one exception is the app's own integration Task, which always runs in the project folder
  regardless of `concurrency`** (`ipc.ts:1325-1344`: `isIntegrationTask(task) || limit <= 1 ?
  { worktree: 'current' } : { worktree: 'new', … }`, with the comment directly above it calling this
  out as "the only exception to the rule above"). It is an exception rather than a violation because
  that Task's entire job *is* merging into the project folder — running it in its own worktree would
  merge into a branch that itself has diverged from `origin`, producing nothing of value, and would put
  `buildSpecFile`'s commit obligation (committing the worktree's own branch before finishing) in direct
  conflict with what the integration spec itself instructs (`git merge --no-edit` *from* the project
  folder, `integrate.ts`'s `buildIntegrationSpec`). The original
  reason for never mixing (an uncommitted change left in the project folder blocks a place for anything
  else to land) still holds here: the integration spec requires a clean tree at the end, and
  `workingInProjectFolder` blocks the app's own automatic merge while that Dispatch is open.
- **When a Task's dependency finishes in its own worktree, the app merges that worktree into the
  project folder before starting the dependent Task** (`integrateWorktrees`, `src/main/ipc.ts`, using
  `git merge-tree --write-tree` as a conflict precheck that never touches the working tree, then a real
  `git merge --no-edit` when the precheck is clean). The app refuses to merge — and instead opens a
  Gate for a human — when the project folder has uncommitted changes to **tracked** files (untracked
  files are let through, because git itself refuses cleanly if one collides), or when the repository is
  on a detached `HEAD` or mid-rebase/bisect/cherry-pick/revert/merge (detected via `gitDir()`'s marker
  files, not `isCleanWorktree`, which is a different question about worktree removal and treats a
  single **untracked** file as enough to call the tree dirty (`clean: false`) — using it here would
  make the app refuse to merge on the ordinary case of an untracked scratch file sitting in the project
  folder). When the precheck instead finds a real conflict, the app does **not** ask a
  human — it creates an **integration Task**, marked by `parentId = <the waiting Task's id>`, and hands
  the conflict to an agent. `parentId` was read by nothing before this (`state.ts` only validated and
  stored it); it is now reserved app-wide as this one marker, and as a direct, mechanical consequence
  `--parent` was removed from `task-create`'s documented syntax in the orchestration guide
  (`resources/skills/orchestration-guide.md:190`, with the reservation explained at `:207-217`) — a
  coordinator setting it on an ordinary Task would make the scheduler mistake that Task for its own
  integration marker, skip the merge step, and run it in the project folder instead of a worktree —
  the one combination the placement rule forbids for an *ordinary* Task (the exception above is for the
  app's own integration Task specifically, identified by `parentId` actually pointing at a Task that is
  really waiting on a merge, not by the mere presence of the field) — and suppress the real integration
  Task from ever being created.

*What to check to reverse it.* This reversal has the most surface area of the three, because five
things shipped together and none of them makes sense alone:

1. The scheduler hook itself (`ipc.ts:1383-1389`'s `void runScheduler()` inside `setState`, and
   `runScheduler`/`slotsToFill`) — check that nothing besides the app's own auto-dispatch calls into it;
   the CLI's `worker-start` path does not, so it survives untouched.
2. `auto: true` on the UI's `run-create` call (`NewRunModal.tsx`) — removing it without deciding what a
   UI-created Run does instead would leave a Run whose Tasks reach `ready` and never move, because
   `띄우기` is not offered for `concurrency >= 2` (see below).
3. `integrateWorktrees` and the `pendingMerges` check the scheduler runs before dispatching a Task with
   a dependency (`ipc.ts`'s slot-fill loop) — before removing it, check whether any Task in a live
   `orchestration.json` currently carries a `parentId` set by this mechanism; an integration Task left
   mid-flight has nothing else that will ever finish it once the scheduler stops looking for it.
4. `parentId`'s reservation, and `--parent`'s removal from the guide — restoring the flag means checking
   that no other feature adopted `parentId` for a different purpose in the meantime (this ADR reserves
   it as exactly one marker; a second meaning would need reconciling, or the field would need to be
   split rather than shared).
5. The placement rule (`concurrency` deciding project-folder-vs-worktree) and the `띄우기` button's
   `canManualStart` gate (`RunDetail.tsx`) both exist **because of** the auto-scheduler. Turning the
   scheduler off without revisiting these leaves a manual-start button that only makes sense in a world
   where nothing else is dispatching automatically — and a `concurrency >= 2` Run with the scheduler
   off would have no way to start any worker from the UI at all.

## Consequences

The single largest consequence of this ADR is that **the app now writes to the user's git repository
on its own, without being asked each time it does.** A Run created from the sidebar with the default
concurrency (3) creates git worktrees under the worktree root and local branches for them the moment
its Tasks become dispatchable, and later merges commits into the project folder's checked-out branch
automatically once a dependency finishes — all without a confirmation dialog, because the user's own
decision was to minimize how often a person is called in. The app never forces a conflicted merge
through: it either completes a clean merge or refuses and hands the conflict to an agent (an
integration Task) or, if the repository itself is not in a state it can safely act on, to a person (a
Gate).

The `orch.command` channel being a single generic pass-through means the renderer can, in principle,
name any project path `assertAllowedPath` accepts and issue a command against a Run that does not
belong to the currently open project — `orch.runDetail` narrows to `runsForProject`, but `orch.command`
does not. This is not a new authorization hole (the caller was never authorization-gated to begin with,
per Decision 1), and the shipped Jobs UI never does this — every call site passes the currently open
project's path — but it is a correctness gap a future bug in the renderer could hit, recorded here
rather than silently accepted.

`parentId` going from "read by nothing" to "the app's one reserved marker" means any future feature
that wants a "child Task" concept of its own cannot reuse the same field without colliding with this
one; it would need a new field, or a case to distinguish the two meanings.

## Alternatives considered

**Add authorization specifically for the app's caller id, either narrowing what `UI_CALLER` may call or
widening `COORDINATOR_ONLY` to include it.** Rejected — there was nothing to narrow or widen.
`COORDINATOR_ONLY` was never a coordinator-vs-app distinction; it has only ever separated worker
sessions (which own a Dispatch) from everyone else. Adding a check here would be inventing a rule the
system never had.

**One IPC handler per orchestration command** (`orch.createTask`, `orch.startWorker`, `orch.gateCreate`,
…), mirroring the CLI one command at a time. Rejected for the reason recorded at the `orch.command` call
site itself: a second door means the transition table, the circuit breaker, the duplicate-report guard,
and the audit log all have to exist in two places, and the day only one of them gets fixed, there is no
way to tell which door is right.

**Keep merging a human's job; have the app only detect and flag when a merge is needed.** This was the
posture before the user's decision recorded in Decision 3, and it was explicitly reversed: "앱이 직접
git 병합하고, 충돌할 때만 에이전트에게 넘긴다. 사람을 부르는 것은 모든 작업이 끝났을 때로 최소화한다."
The user was asked to confirm this three times before it was accepted as the direction, specifically
because of how much it changes what the app is allowed to do to the user's repository unattended.

**Always run every worker in the project folder, regardless of concurrency, and let the user sort out
conflicting local changes themselves.** Rejected — this is exactly the failure mode discovered when the
default concurrency (3) was first exercised end to end: several workers editing the same uncommitted
working tree corrupt each other's changes with no merge step to separate them. The placement rule
(concurrency decides worktree-vs-project-folder) exists to make that combination structurally
impossible rather than to warn about it after the fact.
