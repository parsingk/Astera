# ADR-008: Plugin UI runs in a sandboxed guest, never in the app's renderer

**Status:** accepted, 2026-11-25

## Context

Plugin Platform V2 lets a plugin contribute UI: a panel, a sidebar view, actions. Today a plugin is a Node process
running as the person ("trusted host plugin", warned before install), and it reaches Astera only through a
JSON-RPC pipe whose every command is checked against the plugin's permissions (`core/host/pluginGate.ts`).

The app's renderer is not a place for someone else's code. Its preload exposes the whole app API (`window.api`,
about 360 IPC handlers): files, sessions, settings, Kubernetes writes. A plugin component imported into that
document would hold every one of them, and no permission list could take that back. The Phase 2 entry gate
hardened the renderer first (explicit isolation, `sandbox: true`, a CSP, an IPC sender check: `main/ipcGuard.ts`),
so that only Astera's own code holds the API.

ADR-006 answered a neighbouring question for the frontend preview: the pane grid is DOM, so a native
`WebContentsView` (always painted above the DOM) would force every menu, dialog and toast to dodge it, while a
`<webview>` composes with the grid like a terminal slot.

## Decision

1. **Plugin UI never runs in the app's renderer.** No plugin script, component or stylesheet is loaded into the
   main window's document.
2. **A plugin panel is a `<webview>` guest with a partition of its own.** Its pages come from the installed
   package through a privileged scheme (`astera-plugin://<host>/...`) handled on that plugin's session only, which
   serves files inside the package and nothing else, with a Content-Security-Policy header that blocks network,
   inline script and frames by default. The host is the plugin id with a scope written `scope+name`
   (`pluginSchemeHost`), which no npm name can be: `@acme/x` parses as host `acme`, a plugin named `acme`.
3. **Main decides how a guest attaches.** The main window already has a `will-attach-webview` guard for preview
   guests (`main/preview/guest.ts`), which refuses any partition but the preview's. It routes a plugin partition to
   the plugin rule instead: refused unless the `src` is that plugin's scheme host, whatever preload the element
   asked for replaced with Astera's bridge, sandbox, context isolation and web security forced on. A plugin guest's
   `window.open` and navigations never reach the preview's link handling.
4. **The bridge trusts the guest, not the message.** A call's plugin is read from the guest that sent it (its
   session's partition, recorded when it attached), never from a plugin id in the payload. Calls are JSON DTOs,
   checked against the plugin's granted capabilities, scoped to a project, size- and rate-limited, with timeouts.
   A contributed command or panel is registered as `<plugin id>:<its id>` (`contributionKey`): no npm name,
   contribution id or core action id holds a colon, so a plugin's command never reads as a core action.
5. **Two trust levels, shown as such.** `trusted host plugin`: today's Node plugins, native code with the
   person's rights, warned before install, never described as sandboxed. `restricted UI`: guest-only plugins with
   capability-checked access. A plugin that needs both is installed as trusted.
6. **Closing a panel ends its guest.** Removing the element destroys the guest; its pending calls are rejected
   and its mapping dropped on `destroyed`. Disabling or removing the plugin closes its panels first.

## Measured (Electron 41.7.1, a standalone harness with hidden windows, 2026-11-25)

- A `<webview>` on `astera-plugin://hello/` in partition `plugin-hello` loaded the package's page; the session
  served the CSP header. The plugin's own session refused another plugin's host (403) and a path escaping the
  package, plain (normalized away), `%2e%2e%2f` or `%5c` encoded (403).
- In the guest: no `require`, `process` or `module`; the bridge present; the preload the element named never ran.
  `fetch` and a remote `<script>` to a closed loopback port, an injected inline script, an inline `onclick`, and a
  frame of another plugin's page were all refused by the CSP (`connect-src`, `script-src-elem`, `script-src-attr`,
  `frame-src`); `window.open` was denied; `window.top` is the guest itself, so the host document is out of reach.
- A call carrying `pluginId: "other"` was answered as `hello`, the plugin its guest belongs to.
- `will-attach-webview` refused a non-plugin partition, a partition/host mismatch and an `https:` src.
- Removing the element destroyed the guest: one pending call was rejected, the mapping emptied.
- DevTools opened on the guest into a hidden window (`setDevToolsWebContents`), as the preview's DevTools does.

Measured again in the app and in harnesses when main took it up (2026-11-25, the plugin panels review):

- The CSP does not cover WebRTC: a plugin page's STUN and TURN reached listeners on this machine and the LAN. With
  the plugin session's proxy set to one that refuses, loopback included (`proxyRules: 'http://127.0.0.1:9'`,
  `proxyBypassRules: '<-loopback>'`), and the guest's WebRTC IP policy `disable_non_proxied_udp`, it gathered no
  candidate and sent nothing, and the plugin scheme was still served.
- With no `will-download` listener a plugin page could start a download that Electron answers with a Save As dialog;
  with no `select-bluetooth-device` listener Electron picks the first device. The plugin session refuses downloads and
  pairing, and its guests pick no device.
- An element's `webpreferences` attribute can name another partition than its `partition` attribute, and Electron
  builds the guest in that one: such an attach is refused before either rule, and a plugin guest's preferences are
  rebuilt from Astera's own.
- `close()` on a guest leaves its page drawn with its scripts running; ending its renderer first stops them.
- That ending reaches the `<webview>` element as `close` and `destroyed`, never `render-process-gone` (the workbench
  tab, 2026-11-25): a tab that waits only for a crash keeps a dead element on screen.
- A session without the plugin scheme's handler hands an `astera-plugin://` URL to the operating system (Windows
  offered a Store app for it on the person's screen during the review). The app's own session and the preview sessions
  refuse `openExternal`; links leave the app only through main's own checks.

What the harness cannot answer is how the app's React renders the element: attributes React does not know can be
dropped silently (the preview slice met that with `allowpopups`), so the first app integration checks the
attributes on the real DOM.

## Alternatives rejected

**Importing plugin React components into the renderer.** Simplest to build, and it hands the plugin the whole
app API.

**`WebContentsView`.** Same reason as ADR-006: it paints above the DOM, so every overlay would have to hide or clip
it, and every pane move would push coordinates to main.

**A same-origin `<iframe>`.** It shares the renderer's origin and can reach `window.parent.api`. A cross-origin
`<iframe sandbox>` on the plugin scheme stays a fallback, unused while the guest works.
