# ADR-007: UI actions are one registry, built on the shortcut action list

**Status:** accepted, 2026-11-24

## Context

The Workspace & Plugin Platform V2 work asks for a command registry and a command palette: every action a person
can take is registered once, with a title, an enablement condition and its key bindings, and the palette, the
shortcuts and later plugins all go through it.

Two things already exist that look like half of that. `core/keys/binding.ts` keeps a list of 18 actions
(`ActionSpec`: id, default chords, settings wording, whether the action yields to a focused terminal), and the
person's overrides are stored by action id in `keybindings.json`. The actions' behaviour, though, lives in a
keydown if-chain inside `App()`, and the other things a person does most (start a session, start a Job, open
Kubernetes) are buttons that set modal state in the same component.

The word "command" is already taken. `handleCommand`, `orch.command` and `door.command('run-create', ...)` are the
Host's command surface, the one the CLI, the SDK, MCP and the app all call. A second thing called a command, in
the renderer, would make every conversation about either ambiguous.

## Decision

1. **One list.** `ActionSpec` is the spec of every UI action. An action with no shortcut has empty `defaults`;
   it is still listed in Shortcut settings, so any action can be given a key.
2. **Handlers are registered, not listed.** The renderer registers a handler per action id under an owner
   (`core` today, a plugin id later), gets a disposer back, and can dispose everything an owner registered.
   Registering an id that already has a handler is refused, never silently replaced.
3. **The renderer owns the registry.** The handlers are UI work: opening a dialog, focusing a pane, starting a
   run from the selected configuration. Anything with a side effect outside the renderer already goes through an
   IPC handler or a Host command, and those keep doing their own checks at the moment they run. The registry
   does not duplicate them.
4. **Ids stay as they are.** `run.run`, `sidebar.home` and the rest keep their names, because they are the keys
   of the person's saved bindings. New core actions use the same `area.verb` shape. Plugin actions will carry
   their plugin id as a prefix, which is what keeps them from colliding with core ones.
5. **Enablement is a typed predicate for now.** A core action answers "available, or not, and why" from the
   current context in code. The restricted declarative `when` grammar the spec asks for arrives with plugin
   manifests, where the condition has to be data.
6. **Matching is ordered substring tiers**, the rule `core/files/fileMatch.ts` already argues for: the first row
   is what Enter takes, so the person must be able to predict it.
7. **Code says "action".** In code and design notes the UI side says "action"; "command" stays the Host
   command surface's word there. The person sees the palette under the name everyone knows it by, "Command
   palette" ("명령 팔레트").

## Alternatives rejected

**A command list beside `ACTIONS`.** Two lists with overlapping ids and titles means two sources of truth for a
shortcut, and a palette that can disagree with Shortcut settings.

**A registry in the Host.** The Host cannot open a dialog or move a pane. Core actions would still need renderer
handlers, and a round trip in front of every keypress would buy nothing: the Host already validates the work an
action asks it for. Plugin actions in Phase 2 are dispatched to the plugin from the renderer's registry entry.

**Renaming to `core.*` ids.** It would orphan every saved override, or need a migration of `keybindings.json`
for no behaviour change. Prefixing plugin ids solves the collision the namespace was for.

**A declarative `when` language now.** Only core actions exist until plugins can contribute, and a grammar
written before its first data consumer is guesswork. It is written with manifest v2.

**Fuzzy scoring.** It ranks well on long lists with short queries and costs predictability; the action list is
short and the existing file matcher already chose predictability on purpose.

## Consequences

The keydown listener keeps the keyboard rules that are about key routing (focus in a terminal, a modal open,
key repeat) and hands the matched id to the registry. Moving the existing 18 handlers out of the if-chain is
part of the same work, so the palette can run everything Shortcut settings lists.

`ActionId` stays a closed union of core ids until plugin actions exist; widening it is part of Phase 2.

An action whose handler is not registered (its owner was disposed, or it is not wired yet) is listed as
unavailable rather than hidden, so a missing handler is visible instead of a silent no-op.
