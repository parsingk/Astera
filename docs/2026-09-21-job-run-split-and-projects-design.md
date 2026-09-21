# The Job/Run split, and projects as entities — design

**Source specification:** `docs/ASTERA_PUBLIC_HEADLESS_CLI_IMPLEMENTATION_SPEC_20260919.md` ("the CLI
spec" below), §13 *Project Commands*, §16 *Jobs / Runs Commands*, §17 *Job Creation*, §27 *Stable
IDs*, §43 *JSON Schema 안정성*.

**Builds on:** the orchestration model as it stands (`src/core/orchestration/state.ts`,
`types.ts`), and the scheduled-Job template/fire pair that already lives in it.

**Why this comes before any public CLI.** The CLI spec §43 treats the CLI's JSON as an API. Publishing
it on a model that is about to change means breaking it on the first release. This document changes
the model; the CLI is designed on top of it afterwards.

---

## 1. What this delivers

Two things a person can do that they cannot do today:

1. **Re-run a finished Job.** Today the only way to run the same plan twice is to put a schedule on
   it. The ↻ on the run rail is the *run configuration*'s, not the Job's (`RunToolRail.tsx`).
2. **Name a project.** Today a project is a path that Astera infers; nothing registers one, nothing
   gives it an id, and two windows onto the same repository have no shared name for it.

And one thing that stops being a trap: the flat `runs` array stops mixing three kinds of thing.

## 2. Decisions taken in conversation (2026-09-21)

1. **Projects become first-class entities with ids.** The alternative considered was "the path is the
   id", which costs nothing to build; it was rejected in favour of ids that survive a folder move.
2. **Jobs and runs become two levels**, as the CLI spec draws them. What settled it was that the two
   levels already exist for scheduled Jobs (§3) and their namelessness has already caused a bug.
3. **An ordinary Job is a Job with one run.** No special case: the first execution of a plain Job is
   run 1 of that Job, the same shape a scheduled Job's first fire has.
4. **The CLI folds the second level away in the common path.** `astera jobs get job_1` answers with
   the latest run inline; `runs` commands exist for when there is more than one. Someone whose Jobs
   run once never types `runs`.
5. **Command names move to the noun-verb surface with no aliases.** A removed spelling answers with
   the name that replaced it rather than silently doing the old thing (see §10).

## 3. What is already there

This is not a new layer. It is a layer that exists without a name.

`spawnScheduledRun` (`state.ts:141`) takes a Run carrying a `schedule`, calls it a **template**, and
on each fire builds a **child** Run with `templateId` and `fireOrdinal`, deep-copying the tasks with
fresh ids. The comments already use the vocabulary this document is about to make real:

> 템플릿은 정의를 담는 그릇이고 그 편집은 명시적이어야 한다
> 회차는 읽기 전용 실행 기록이다

The template never runs: `slotsToFill` skips it outright (`schedule.ts:44`, *"템플릿은 자신이 돌지
않는다 — 발화마다 자식 Run 이 생기고 그것이 돈다"*). The renderer already nests them —
`JobRun.children` in `core/types.ts:603` — and already renders the ordinal (`'{n}회차'`,
`JobsView.tsx:496`).

**And the namelessness has cost something.** `state.ts:204` records it:

> Run A 를 몰던 코디네이터의 `check --wait` 가 조용히 방금 생긴 회차의 배달을 기다리며 영원히
> 서고, `--run` 없는 `task-create` 는 템플릿에 떨어져 그 뒤 모든 회차로 복사된다

The workaround is `latestOrdinaryRun`, a function whose whole job is to pick "the run that is neither
a template nor a fire" out of one array. It goes away here.

## 4. The model

```text
Project ──< Job ──< JobRun ──< Task ──< Dispatch
              │
              └──< Task (definition, never dispatched)
```

| Type | What it is | Lives in |
|---|---|---|
| `Project` | a registered repository | `projects: Project[]` |
| `Job` | the plan: objective, concurrency, coordinator account, convergence policy, schedule | `jobs: Job[]` |
| `JobRun` | one execution of that plan | `runs: JobRun[]` |
| `Task` | owned by a Job (a definition) **or** by a JobRun (an instance) | `tasks: Task[]` |

Fields move by the question "is this the plan, or is this what happened".

**To `Job`:** `objective`, `projectId`, `cwd`, `concurrency`, `coordinatorAccountId`, `convergence`,
`schedule`.

**To `JobRun`:** `coordinatorSessionId`, `autoDispatch`, `ordinal`, `startedAt`, `result`.

**Gone:** `Run.pendingStart` and `Run.templateId`/`Run.fireOrdinal`.

`pendingStart` exists today to say "the person has not pressed 실행 yet". In the new model a Job that
has not been started has **no runs**, which says the same thing without a flag two other flags are
already confused with (its own JSDoc explains that `autoDispatch` cannot express it). `templateId` is
replaced by `JobRun.jobId`, and `fireOrdinal` by `JobRun.ordinal`, which every run has.

### 4.1 Task ownership

A Task belongs to exactly one owner, and the owner's kind is explicit:

```ts
// exactly one of these is set
interface Task {
  jobId?: string   // a definition: part of the plan, never dispatched
  runId?: string   // an instance: part of one execution
  // ...unchanged
}
```

This is the field that makes the `--run`-less `task-create` bug impossible to write: a definition and
an instance are no longer the same shape holding different ids.

**A Job does not have to carry definitions.** Starting a run copies from, in order: the Job's own
definitions if it has any, otherwise the tasks of its latest run. That is what `spawnScheduledRun`
already does from a template, generalised by one step so that an ordinary Job — which has never had
definitions — can be re-run by copying its last execution.

### 4.2 Naming, and a collision to resolve

`JobRun` is **already taken**: it is the renderer-facing view type in `core/types.ts:530`, the thing
`view.ts` builds for the sidebar, complete with `children`. And `Run`, `RunConfig`, `RunStatus` and
`runId` all belong to run configurations (`src/core/run/`, `main/runManager.ts`) — a separate,
user-visible feature whose own comment says *"addressed everywhere by runId"*.

So the domain cannot call the new type `Run`, and `JobRun` needs the name freed first.

**Settled (2026-09-21):** the view type `JobRun` is renamed `JobRow` — it is a row in the Jobs list,
it is a view model, and it lives in `view.ts`, `snapshot.ts` and a handful of renderer files. The
domain type takes the `JobRun` name. The CLI surface still says `runs`, which is unambiguous there
because run configurations are not exposed to the CLI at all.

**The rename ships on its own, before anything else here.** It touches no behaviour, it frees the
name, and doing it inside the model change would bury a mechanical diff inside a substantive one.

## 5. Ids and migration

`orchestration.json` outlives processes and a Run is kept for 30 days (`RUN_TTL_MS`), so this is a
real migration, not a formality.

**The rule that makes it cheap: the existing Run's id becomes the JobRun's id.** Everything that
points at a run today — `Task.runId`, the Dispatches under those Tasks, every `runId` already written
into the Job Continuity journal — keeps pointing at the same thing. Only the new Job wrapper needs a
fresh id (`job_…`). Doing it the other way round means rewriting the journal.

| Today | After |
|---|---|
| ordinary Run `run_x` | Job `job_new` + JobRun `run_x` (ordinal 1), tasks keep `runId = run_x` |
| template Run `run_t` (has `schedule`) | Job `job_new`, its tasks become the Job's **definitions** (`jobId`) |
| child Run `run_c` (`templateId = run_t`) | JobRun `run_c` of that Job, `ordinal = fireOrdinal` |
| Run with `pendingStart` | Job with **no** runs; its tasks become definitions |

**Where it runs:** `OrchestrationStore.load`, in the same place as the two field migrations already
there (`store.ts:140-175`), which mutate the parsed object in place *before* `before` is captured
(`store.ts:180`). That ordering matters: the journal diffs `before` against the post-load state, so a
migration that ran after the capture would be journaled as though a person had done it.

`isValidState` gains `jobs` and `projects` to the arrays it checks. A file from before this change has
neither, so the migration keys off their absence rather than a version number — the same
shape-not-version policy the file already uses.

## 6. Projects

Today a project is derived, never stored: `runsForProject(state, projectPath, worktrees)`
(`view.ts:46`) maps each `Run.cwd` back to its repository and compares paths. `ProjectSettings`
(`core/projects/settings.ts`) is a path → default-account map and nothing else.

```ts
interface Project {
  id: string          // proj_…
  path: string        // absolute, the repository root
  name: string        // defaults to the last path segment; a person can change it
  addedAt: string
}
```

Stored in `OrchState.projects` rather than a new file, so one write and one recovery policy cover it
and the CLI reads Jobs and projects from one consistent snapshot.

**`Job.projectId` is authoritative; `Job.cwd` stays.** The path-derivation in `runsForProject` is kept
as the answer for Jobs whose `projectId` is absent — every Job that exists today. Two sources of truth
is exactly what the `accountId`/`accountIds` migration comment warns against, so this is explicitly a
*read fallback for migrated rows*, not a second writer: nothing new is created without a `projectId`.

**Registration is not automatic.** A project appears when a person adds it, or when a Job is created
in a repository that has none — that second path is what keeps the migration honest, since it is how
every existing Job's repository gets an entry.

## 7. What the CLI sees

The second level is present but optional. This is what §2.4 buys.

```text
astera jobs list                  # jobs; runs are not mentioned
astera jobs get job_1             # the latest run folded in
astera jobs run job_1             # starts a run, answers with its id
astera jobs wait job_1            # waits on the latest run

astera runs list --job job_1      # only interesting once there is more than one
astera runs get  run_7
astera runs wait run_7
astera runs cancel run_7
```

The CLI spec asks for both spellings itself (§21 lists `jobs wait <job-id>` and
`runs wait <run-id>`), so folding costs no conformance.

## 8. The journal

`deriveEvents` (`core/continuity/events.ts`) compares state before and after a write, so no command
can forget an event. The event names already say `JOB_RUN_*`; what changes is that they now name a
real object instead of a Run that was sometimes a plan and sometimes an execution.

- `JOB_RUN_STARTED` fires when a JobRun is created, which is also when a person presses 실행. Today it
  fires on a state transition of a Run that already existed.
- The migration itself is journaled as nothing, by construction (§5).

## 9. What this does not do

- **The state does not move.** It stays in the Electron main process. Moving it is Host slice 3, and it is
  deliberately a separate step: a move is safest when the thing being moved is not simultaneously
  changing shape.
- **No CLI.** Command names, JSON envelope, exit codes and installation are the next design.
- **No new scheduling behaviour.** A scheduled Job fires exactly as it does now; it simply has a name
  for what it produces.
- **No Task-level re-run.** Re-running is per Job. The existing per-Task retry (`worker-start
  --retry-of`, the graph node's 띄우기) is untouched.
- **No change to Dispatch.** `ATTEMPT_*` in the journal keeps meaning a Dispatch attempt; the word
  "attempt" is not reused for this new level, for that reason.

## 10. Command names

The internal CLI's names move to the noun-verb surface (`jobs list` rather than `run-list`), with **no
aliases**, because the old spellings would now be wrong rather than merely old: `run-create` creates
what is now a Job, and `runs` means something else in the new vocabulary.

A removed name answers with its replacement instead of failing blankly — today the server answers
`unknown command: <cmd>` (`server.ts:1942`):

```text
run-list was renamed to `jobs list` (astera help)
```

The users of the old names are coordinator agents that read `astera help` before their first command
(`handover.ts:78`), so a named replacement is a self-correcting turn rather than a break. The window
that matters is an app update reaching a coordinator whose context still holds the old guide.

Only commands that go public get new names; coordinator-only commands (`worker-start`,
`dispatch-show`, `send`, `check`, `ask`) keep theirs.

## 11. Tests

**Pure (`core/orchestration`)**
- a Job with no runs is not started; starting one creates run 1
- starting a Job with definitions copies definitions; with none, copies the latest run's tasks
- a Task has exactly one owner; a definition is never selected for dispatch
- `ordinal` comes from a counter on the Job, not from counting runs (the rule `fireOrdinal` already
  has: deleting a run must not renumber the others)
- a scheduled Job fires into a JobRun, and the Job itself is never dispatched

**Migration (`main/orchestration/store`)**
- an ordinary Run becomes Job + one JobRun **keeping the run's id**, and its Tasks still resolve
- a template and its children become one Job with definitions and N runs, ordinals preserved
- a `pendingStart` Run becomes a Job with no runs
- a file already in the new shape is left alone
- `before` is captured after the migration: the journal records nothing for it

**Projects**
- a Job created in an unregistered repository registers it
- a migrated Job with no `projectId` still lists under its repository through the path fallback
- renaming a project does not move any Job

**Regression**
- the existing scheduled-Job tests keep passing unchanged in meaning
- `npm run typecheck`, `npm test`

## 12. Order of work

Three pieces, in this order, because the first two ship on their own and the third is the only one
that has to land whole.

1. **Rename the view type `JobRun` → `JobRow`** (§4.2). Mechanical, no behaviour, frees the name.
2. **The projects registry** (§6). Independent of the Job/Run split: nothing in it needs the second
   level to exist.
3. **The Job/JobRun split** (§4, §5) with its migration, wiring and UI. This one cannot be usefully
   halved — the app does not run with half a model — so it is sliced by test surface rather than by
   shippability: pure model, then migration, then wiring, then screens.

## 13. Open questions

1. **Does a person see runs before there are two?** The Jobs list already nests children for
   scheduled Jobs. For an ordinary Job with one run, showing a single "1회차" row would be noise; the
   recommendation is to show nothing until a second run exists, matching what the CLI does.
2. **Project removal.** Unregistering a project that still has Jobs: refuse, or orphan them onto the
   path fallback? Not needed for the CLI's read commands, so it can wait.
