# ADR-005 — Cite by symbol name, not by line number

**Status:** accepted, 2026-08-20

## Context

A comment that cites `foo.ts:396` is correct the moment it is written and wrong the moment anything
above line 396 changes — including a change made by the same commit, higher up in the same file. The
number looks precise, so review does not reliably catch it: it reads as evidence, not as a claim that
needs checking.

The `job-authoring` slice (ADR-004) surfaced this concretely. Its branch merged with **four** stale
line-number citations still in it. One of them was created by the very commit that fixed another —
fixing a citation elsewhere in a file shifted lines below it, and a second, unrelated citation further
down in the same file went stale as a side effect of the fix. All four survived eleven per-task
reviews and a whole-branch review before merge. The post-merge cleanup (`6e03791`) shows the shape of
the problem even in the fix: it repaired a self-citation in `coordinator.ts` from `(:396)` to
`(:402)` — correct at that moment, but still just another line number, one more edit away from being
wrong again rather than a name that would not need repairing at all.

Converting this repository's own existing citations for this ADR reproduced the same finding
independently, at larger scale. Of the roughly two dozen `file.ts:NN`-style citations already living in
`src/`, more than half no longer pointed at what they claimed — several by dozens of lines, into a
different function or a different file's field entirely (`core/run/config.ts:41-42` named a spot that
now belongs to `RunContext.platform` in `core/run/build.ts`; `state.ts:264-284` had moved on to a
different function's message-push entirely, with `closeDispatch`'s own now thirty-odd lines further
down). One citation had drifted in the way that matters most: the comment's own words, not just the
number, were wrong — `main/terminalManager.ts:15` was described as "TerminalManager's exists()", but
the line is a module-level function named `onPath`; no method called `exists` exists on that class.
This code is one to three weeks old and had already been through review. Precision does not stop the
drift — only removing the thing that drifts does.

## Decision

**Cite our own files by symbol name — the function, constant, type, or test name at the cited location
— never by line number.** `git.ts:76-84` becomes `git.ts` 의 `toFullRef`. A name survives the code
moving up or down in the file; a grep finds it again regardless of how much has shifted. A line number
is a snapshot of `git blame`, presented as if it were durable.

**The one exception is `node_modules/**`.** We do not own the symbol names in third-party code, so a
line number can be the only handle available — pinning a vendored file's exact release makes the
number meaningful in a way it never is for our own code, which every one of us can edit tomorrow. This
is a rule, not an enumerated exception list: any citation into `node_modules` is allowed, not just the
two that exist today (both to `node_modules/node-pty/src/windowsPtyAgent.ts:255`).

**Where the cited spot has no symbol of its own** — one line inside a long function, not a declaration
— cite the enclosing symbol plus a short, distinctive quoted fragment from that line. The fragment is
searchable and does not drift the way a number does; the enclosing symbol gives the reader a place to
start reading. (`server.ts` 의 `handleCommand`, `'worker-start'` 분기 is this shape in practice.)

**No opt-out mechanism.** If a genuinely line-bound case turns up later — a test fixture holding a
literal stack trace, say — add the exception then, in that file, with the reasoning written down next
to it. A list of pre-approved exceptions invites the next citation to quietly join it instead of being
converted.

A guard test (`src/main/lineNumberCitations.test.ts`) scans `src/**/*.ts` and `src/**/*.tsx` for
`file.ts:NN` and `file.ts:NN-MM` citations and fails on any that are not into `node_modules`. It does
not try to detect "is this a comment" — it scans every line, on purpose, because a false positive is a
smaller problem to fix later than getting comment-detection right now would be to build.

**This rule covers all committed prose, not only what the guard test can reach.** `docs/` and
`.superpowers/` are git-ignored and absent from a fresh clone, so a test that runs in CI cannot
meaningfully guard them — but a stale citation in a design note is exactly as misleading as one in a
source comment, just harder to catch mechanically. Apply the rule there by hand; there is no
substitute for the guard test in those directories, only the discipline the guard test is meant to
stand in for everywhere else.

## Consequences

Every future comment that would have cited a line number now has to name something instead, which is
occasionally more words (`server.ts` 의 `handleCommand`, `'worker-start'` 분기의 `pendingSessionId`
reads longer than `server.ts:460`). That cost is the point: a symbol name is slightly more to type and
survives the next edit, where a line number is slightly less to type and is a coin flip by the next
commit.

The guard test also catches a bare self-reference with no filename at all — `(:402)` or `(:1870 부근)`,
pointing at "this same file" — as long as the colon sits directly after an opening parenthesis, the
shape every such citation in this codebase actually used (`(:NN)`, `(:NN-MM)`, or `symbol(:NN)`). That
shape cannot be confused with a ternary (whose colon has a space before it, not a paren) or a ratio
(whose colon has a digit before it, not a paren), so widening the regex to `\(:\d+(?:-\d+)?(?:\s*부근)?\)`
added no false positives: scanning the whole `src/` tree for it turned up exactly the citations that
needed converting and nothing else. Historical examples of this shape include `App.tsx`'s `:710` and
`coordinator.ts`'s `:402` (fixed by `6e03791`), and ten more found across `descriptor.ts`,
`limitProbe.test.ts`, `FileExplorer.tsx` and `useFileOps.ts` when the guard was widened to catch this
shape — all now converted.

A gap remains for bare self-references that do **not** have a `(` immediately before the colon —
`removeSelection:214` (a bare `word:NN`, no parenthesis at all) or `transferTo's destDir (around
:322-323)` (a parenthesis, but with a word between it and the colon), both still living in
`useFileOps.ts`. Widening the regex to reach those would risk exactly the ternary/ratio false positives
the original design avoided, so they are left as a known gap the same way the fully-bare form used to
be: if one goes stale it fails the same way the four that motivated this ADR did, silently, and someone
will have to notice by reading rather than by the test failing red.

Anyone who sees `git.ts` 의 `toFullRef` and reaches for the file to add back a precise-looking line
number should stop — that instinct is exactly what this ADR exists to head off, and the guard test will
turn the addition red the moment `toFullRef` moves again.

## Alternatives considered

**Keep line numbers, but require CI to re-verify them against a symbol table on every change.** Would
catch drift after the fact instead of preventing the citation from being able to drift, and needs
tooling (a maintained cross-file symbol-to-line index, kept in sync with every refactor) this repository
has no other use for. Rejected: the citation itself is the wrong artifact; fixing how we validate it
does not fix that.

**Allow line numbers alongside symbol names, e.g. `toFullRef` (`git.ts:76`).** Attractive because it
adds a fast jump-to-line for the reader. Rejected: the number is exactly the part that goes stale, and
keeping it "for convenience" is how three of this ADR's four motivating citations survived eleven
reviews — the precise-looking half of the citation crowds out the durable half, and an editor's
"go to definition" on the symbol name is the jump-to-line this trades away nothing to get.

**Build an opt-out list for cases where a line number seems genuinely necessary.** Rejected explicitly
— see Decision. A list invites additions by default; a deliberate, visible exception at the point of
need does not.

**Do nothing, and rely on review.** This is the status quo the four citations disproved: eleven
per-task reviews and a whole-branch review did not catch any of them, because a line number reads as a
fact already checked rather than a claim to check.

## Reversing this

Line numbers would be worth it again only if this repository stopped changing shape fast enough for
citations to drift within a review cycle — which would have to mean either the codebase reaching a
long stable plateau, or tooling arriving that keeps a citation's line number in sync with the symbol it
names automatically (an IDE-integrated "citation" comment type that re-numbers itself on save, say).
Short of that, check whether the four-citation incident this ADR records was a one-off before reverting
it — rerun the search this ADR's guard test performs against a few months of `git log` and see whether
new line-number citations, had they existed, would have survived to merge as often as these four did.
If they would not have, the guard test is not doing the job it was written for and this ADR should be
revisited on that evidence, not on the annoyance of typing a symbol name instead of a number.
