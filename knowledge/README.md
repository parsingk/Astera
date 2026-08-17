# knowledge

Long-lived engineering knowledge about this repository: why it is shaped the way it is, what was
decided and why, and what happened. Everything here is **committed on purpose** — it travels with
the repository and is meant to be read by whoever (or whatever) works on it next.

That is the opposite of `docs/`, which is git-ignored except for a short whitelist. `docs/` is where
design notes, specs and plans stay local by default; a note written there is not published unless
someone deliberately adds it. Put a thing here when it should outlive the branch that produced it.

## What goes where

**`architecture/`** — how a subsystem actually works, at the level a newcomer needs before changing
it. One file per subsystem, named after it. Describe the shape and the constraints, not the code:
the code is already in the repository and will drift from any prose that restates it.

**`decisions/`** — one file per decision that closed off alternatives. `ADR-NNN-short-slug.md`,
numbered in the order they were accepted. A decision belongs here when a later reader would
otherwise "fix" it: a version floor, a platform trade-off, an interface that could obviously have
been simpler. Record what was rejected and why — that is the half that stops the rework.

**`agents/`** — guidance for coding agents working in a particular area, where it is too specific
for `CLAUDE.md` and too situational for `CONTRIBUTING.md`. Conventions that are real but not
enforced by a type or a test.

**`history/`** — what actually happened, dated. Not a changelog (git has one) but the account a
changelog cannot carry: what broke, what the symptom looked like, how it was found. Written when a
piece of work taught something that the diff alone does not show.

## When not to write here

Do not restate what the code already says, what `git log` already records, or what a type already
enforces. A file here earns its place by carrying something that would otherwise be lost — a
measurement, a rejected alternative, a symptom and its cause. If it can be derived from the
repository in a minute, leave it out.

Keep files short enough to stay true. A long document goes stale silently; a short one gets fixed.

## Not the product feature

Astera's development direction proposes that the app itself read a repository's knowledge before
planning work and update it afterwards. That feature does not exist yet, and this directory is not
its contract — it is this repository's own knowledge base. If that feature is built, the directory
it reads will be configurable, because most repositories that already keep architecture notes and
ADRs keep them somewhere else (`docs/adr/` and `docs/decisions/` are both common), and a tool that
only finds its own convention finds nothing.
