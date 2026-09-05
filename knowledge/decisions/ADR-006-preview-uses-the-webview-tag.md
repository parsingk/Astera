# ADR-006 — The preview embeds pages with `<webview>`, not `WebContentsView`

**Status:** accepted, 2026-09-05

## Context

The frontend preview puts a live page — the developer's own dev server — inside a pane, beside the
session that is editing it. Something has to render that page inside the app's window.

Electron offers three ways, and its own documentation marks the one this app chose as "not
recommended". A later reader who knows that label and does not know why it was accepted will change
it, so the reasoning is recorded here rather than only in the design note (`docs/` is git-ignored and
does not travel with the repository).

The constraint that decides it is the pane grid. Panes are **DOM**: `PaneGrid` places every slot
absolutely, as a percentage rectangle at the grid's top level, and hides an inactive one with
`display: none`. Slots are never nested inside one another, because changing a slot's DOM parent
makes React unmount and remount it — which destroys an xterm's scrollback, and would destroy a
preview's scroll position and any half-typed form. Everything else in the app — the run
configuration menu, context menus, confirmation dialogs, toasts — stacks over those slots as
ordinary DOM.

## Decision

Render the preview with the `<webview>` tag.

## Alternatives rejected

**`WebContentsView`** — Electron's recommended path, and the one to reach for on a clean slate. The
main process owns the view and positions it over the window; the renderer measures its slot and
sends the rectangle across. It was rejected because a native view **always paints above the DOM**.
Every menu, popover, dialog and toast that overlaps the pane would be drawn underneath it, so each
one would have to hide or clip the view while it is open, and every pane drag, split and resize
would have to push new coordinates to main. That is a tax on the whole application's UI, paid
forever, to embed one kind of pane.

**`<iframe>`** — cheapest, and a dev server will usually allow framing. Rejected because it cannot
carry the feature: DevTools cannot be opened for the framed document alone, a cross-origin frame
cannot be scripted or captured (which is what the next slice, clicking an element and sending it to
the agent, is built on), and a login redirect to a provider that refuses framing breaks the page.

## Consequences

`<webview>` is a DOM element and has been an out-of-process iframe since Electron 5, so it composes
with the grid exactly as a terminal slot does: absolute placement, `display: none` when inactive,
menus over the top, no remount on a pane move.

The cost is the label. The tag is deprecated in documentation but present and working in Electron 41,
and its known drawbacks — slightly worse performance than an iframe, historical focus quirks — are
acceptable for a preview pane. If Electron removes it, the migration is to `WebContentsView` plus the
overlay bookkeeping described above; the work is contained in `BrowserPane` and `PaneGrid`, not spread
through the app.

Turning the tag on means the main process, not the renderer, decides what a guest may do:
`installPreviewGuards` strips any preload and forces sandbox, context isolation and web security on
every attach, confines guests to one partition, denies every window they try to open, and limits
certificate and permission exceptions to loopback origins. See `src/main/preview/guest.ts` and the
pure rules it wires in `src/core/preview/guards.ts`.
