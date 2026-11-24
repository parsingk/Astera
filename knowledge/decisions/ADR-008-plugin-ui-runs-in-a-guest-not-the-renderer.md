# ADR-008: Plugin UI runs in a sandboxed guest, never in the app's renderer

**Status:** proposed, 2026-11-24. To be accepted, or revised, after the Phase 2 spike measures it on Electron 41.

## Context

Plugin Platform V2 lets a plugin contribute UI: a panel, a sidebar view, actions. Today a plugin is a Node process
running as the person ("trusted host plugin", with a warning before install), and it reaches Astera only through
a JSON-RPC pipe whose every command is checked against the plugin's permissions (`core/host/pluginGate.ts`).

The app's renderer is not a place for someone else's code. The main window runs with `sandbox: false`, leaves
context isolation to Electron's default, has no Content-Security-Policy, and its preload exposes the whole app
API (`window.api`, about 360 IPC handlers, none of which checks the sender). That is defensible while only
Astera's own code runs there. A plugin component imported into it would hold every one of those handlers:
files, sessions, credentials settings, Kubernetes writes. No permission list could take that back.

ADR-006 already answered a neighbouring question for the frontend preview: the pane grid is DOM, so a native
`WebContentsView` (always painted above the DOM) would force every menu, dialog and toast to dodge it, while a
`<webview>` composes with the grid like a terminal slot. `main/preview/guest.ts` forces sandbox, context
isolation and web security on every guest and confines guests to known partitions.

## Decision (proposed)

1. **Plugin UI never runs in the app's renderer.** No plugin script, component or stylesheet is loaded into the
   main window's document.
2. **A plugin panel is a sandboxed guest.** First choice: a `<webview>` with a partition of its own per plugin,
   attached under the same main-process guard as preview guests, with no preload except Astera's own bridge
   script. Its content comes from the installed package through a privileged custom scheme that serves only that
   plugin's files, with a CSP header that blocks remote loads by default. Fallback, if the spike finds the guest
   unworkable: a cross-origin `<iframe sandbox="allow-scripts">` on the same scheme.
3. **The bridge trusts the guest, not the message.** Identity comes from which guest sent a message (its
   webContents), never from a plugin id in the payload. Messages are JSON DTOs validated against a schema, checked
   against the plugin's granted capabilities, scoped to a project, size- and rate-limited, with timeouts.
4. **Two trust levels, shown as such.** `trusted host plugin`: today's Node plugins, native code with the
   person's rights, warned before install, never described as sandboxed. `restricted UI`: guest-only plugins with
   capability-checked access. A plugin that needs both is installed as trusted.
5. **The renderer is hardened first.** Explicit `contextIsolation`/`nodeIntegration`, a sandboxed preload, a CSP,
   and a sender check on every IPC handler land before any plugin UI does.

## Alternatives rejected

**Importing plugin React components into the renderer.** Simplest to build, and it hands the plugin the whole
app API; see Context.

**`WebContentsView`.** Same reason as ADR-006: it paints above the DOM, so every overlay in the app would have
to hide or clip it, and every pane move would push coordinates to main.

**A same-origin `<iframe>`.** It shares the renderer's origin and can reach `window.parent.api`.

## What the spike must show before acceptance

- A `<webview>` on a custom scheme with a per-plugin partition loads the package's page, and the CSP header holds
  (a remote script and `fetch` are refused).
- The bridge preload is the only one that attaches; a plugin cannot set its own.
- A message's sender identifies the plugin; a forged plugin id in a payload is refused.
- Closing the panel, disabling or removing the plugin destroys the guest and its pending calls.
- Opening DevTools on the guest works (Plugin Inspector).
