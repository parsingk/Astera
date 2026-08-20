# ADR-003 — `Run.cwd` carries both ownership and execution, and is normalised only where that is safe

**Status:** accepted, 2026-08-18

## Context

An orchestration `Run` has one path field, `cwd`, and two unrelated consumers read it.

- **Ownership.** The Jobs sidebar asks which Runs belong to the open project, and
  `runsForProject` (`src/core/orchestration/view.ts`) answers by comparing `Run.cwd` to the project
  root. The comparison is *equality*, not containment, on purpose: `orchestration.json` is a single
  app-wide store, so "at or below" would also match a Run whose cwd is a nested repository below this
  project — a Run belonging to that nested project, not this one.
- **Execution.** `worker-start` passes `Run.cwd` to the coordinator as `runCwd`
  (`src/main/orchestration/server.ts` → `src/main/orchestration/coordinator.ts`). With the default
  `--worktree current` that value *is* the worker's working directory, and with `--worktree new` it
  is the repository the new worktree is cut from.

Those two readings pull in opposite directions, and building the sidebar surfaced it.

A Run created from a subdirectory (`run-create --cwd D:\proj\src`) matched no project root, so it was
invisible in every list. The obvious repair — normalise the stored cwd up to the owning project root
at creation — fixes ownership and, as a bonus, fixes something the orchestration guide already warns
about: a non-root `--cwd` puts every worker in the wrong directory.

But normalisation is not free, because the field is also the execution site. Two cases showed it:

- **Across a repository boundary.** A coordinator in a vendored clone or submodule at
  `D:\proj\vendor\lib` — a directory no session has ever been rooted at, so not a normalisation
  candidate — walks up to `D:\proj`, which is. Workers then run in the parent repository, and
  `--worktree new` cuts a worktree of the *wrong* repository. This is the same leak the equality
  test was chosen to prevent, reappearing on the write side and affecting execution rather than
  display.
- **Out of a worktree.** A registered worktree lives under the worktree root
  (`~/astera-worktrees` by default), outside the repository, so no `repoPath` candidate contains it. The
  symmetrical-looking repair — add the worktree's own path as a candidate and lift the result to its
  `repoPath` — would make `Run.cwd` the repository root. Workers started with `--worktree current`
  would then leave the worktree and run in the main checkout. Isolation is the whole reason a
  worktree exists.

## Decision

**Keep one field, and normalise it only where normalisation cannot move execution.**

1. **Write side, bounded.** `run-create` maps `--cwd` up to the owning project root
   (`projectRootOf` in `src/core/files/tree.ts`, deepest containing candidate wins), but the walk-up
   **stops at the git repository boundary**: candidates outside `repoRoot(cwd)` are discarded before
   selection. Normalisation is best effort, never validation — a path with no candidate is stored as
   given rather than rejected, because failing here would stop the coordinator from creating a Run at
   all.
2. **Read side, for worktrees.** `runsForProject` puts `Run.cwd` through `repoPathOf`, exactly as the
   `orch.list` handler already does to the path the renderer sends. Both sides are canonicalised the
   same way, so a worktree-rooted Run is owned by its repository — while the stored value, and
   therefore the worker's working directory, stays the worktree.
3. **Do not split the field.** Storing a raw `cwd` for execution and a derived `projectRoot` for
   display is the honest fix, and it is deliberately not taken yet.

## Consequences

A Run created from a subdirectory now appears under its project, and its workers start at the project
root instead of one level down. A Run created inside a registered worktree appears under its
repository from both the worktree's tab and the repository's, and its workers stay in the worktree.

The cost is that the rule is no longer one sentence. Two mappings are now in play and they run in
opposite directions — `projectRootOf` on the way in, `repoPathOf` on the way out — and neither
replaces the other. A future change to either has to be checked against the other; the reason they
compose is that both reduce a path to the same canonical project, not that either is more correct.

The repository-boundary bound costs one `git rev-parse` per `run-create`. The call is guarded: a
rejection falls back to the un-normalised path rather than failing the command, following the same
convention `handleExit` uses for `probeLimit`.

Normalisation still does nothing for a worktree the app did not create (it is not in the registry) or
for a project no session has ever opened (`knownProjectPaths()` has not seen it, and it is cached).
Those Runs are stored as given and remain invisible. That is the accepted price of "best effort, never
blocks".

Splitting the field remains available and gets easier, not harder, from here: both consumers now read
through a named function, so introducing a second stored value is a change to those two call sites
rather than a search for everything that touches `cwd`.

**A third reader arrived with the Validator slice — configuration ownership.** `Run.cwd` now also
decides *whose run configurations apply*: `run-configs` lists the configurations of the project at
`Run.cwd`, and `task-create --validate <configId>` names one of those. This is the trigger the
"Alternatives considered" section below predicted, and it has a functional consequence rather than a
merely conceptual one. `RunConfigStore.get` is an exact-string lookup, so **a Run created inside a
registered worktree sees none of the stored configurations** — decision 2 above deliberately keeps
`Run.cwd` at the worktree so `--worktree current` workers stay isolated, and the worktree path is not
a key in the configuration store. `run-configs` then returns only the auto-detected seeds, and a
coordinator that names an id belonging to the repository root gets `NO_CONFIG` → a Gate → a human
called in because of a configuration that does exist, one directory up.

That is left as it is for now. Whether configuration ownership should follow the repository (so a
worktree Run inherits the repository's configurations) or the worktree (so a worktree can carry its
own) is a judgement, not an oversight, and the repair is the field split this ADR already scoped:
give the display/ownership side its own derived `projectRoot` and let configuration lookup read that,
while execution keeps the raw `cwd`.

## Alternatives considered

**Loosen the ownership test to containment.** One-line change, fixes the subdirectory case with no
write-side machinery. Rejected: it re-opens the nested-repository leak the equality test exists to
prevent, and `orchestration.json` being app-wide means that leak crosses projects rather than staying
inside one.

**Add the worktree's own path to the write-side candidates and lift with `repoPathOf`.** Proposed
during review, and symmetric with the read path, which is what makes it attractive. Rejected: it
makes `Run.cwd` the repository root, so `--worktree current` workers leave their worktree for the main
checkout. Trading execution isolation for a display fix is the wrong direction — the read side can be
made to agree without touching where anything runs.

**Split into `cwd` (raw, execution) and `projectRoot` (derived, display).** The design this ADR is
deferring. It removes the conflict at the source rather than routing around it, and it is what should
happen if the two readings ever need to differ deliberately. Not taken now because the field's two
uses still agree in every case the bounded rules produce, and adding a stored field immediately after
deleting a dead one (`Run.status`, same slice) would be paying migration and schema cost for a
distinction nothing yet exercises. Revisit when a Run's workers need to run somewhere its project
does not own — the Validator slice, which will run project-level build and test commands against a
Run, is the likely trigger.

**Normalise at read time instead of write time.** Symmetric, and it would keep the stored value
untouched for both consumers, which is the cleanest reading of the problem. Rejected on a mechanical
constraint: the candidate list needs `knownProjectPaths()`, which is async and does filesystem work,
while the fold that produces the sidebar payload (`snapshotFor`) is synchronous and runs on every
orchestration state change. The worktree half of the read side is exempt because `repoPathOf` is a
pure lookup over a list main already holds.
