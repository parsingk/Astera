// Wires the preview guest guards (core/preview/guards.ts decides; this file only listens). The
// <webview> in a browser tab is the developer's dev server, plus whatever that page pulls in — so it
// runs sandboxed, in its own partition, with no preload, and cannot open windows or leave http(s).
import { app, session, type BrowserWindow } from 'electron'
import {
  PREVIEW_PARTITION,
  agentNavigationAllowed,
  certificateAllowed,
  guestAttachAllowed,
  guestNavigationAllowed,
  permissionAllowed
} from '../../core/preview/guards'

export function installPreviewGuards(win: BrowserWindow, isAgentGuest: (webContentsId: number) => boolean): void {
  // The renderer's <webview> tag can carry any attribute; whatever it says, the guest gets these
  // preferences and no preload. A src outside http(s)/blank, or a foreign partition, never attaches.
  win.webContents.on('will-attach-webview', (e, prefs, params) => {
    delete prefs.preload
    prefs.nodeIntegration = false
    prefs.contextIsolation = true
    prefs.sandbox = true
    prefs.webSecurity = true
    if (!guestAttachAllowed(params)) e.preventDefault()
  })
  win.webContents.on('did-attach-webview', (_e, guest) => {
    // No windows of its own. The address goes to the renderer, whose link rule routes it — the same
    // shape as ipc.ts's `send`, guarded the same way.
    guest.setWindowOpenHandler(({ url }) => {
      if (!win.isDestroyed()) win.webContents.send('preview:popup', { url })
      return { action: 'deny' }
    })
    // Both events, because Electron splits one navigation in two. `will-navigate` is the address the
    // page asks for; `will-redirect` is where a server sends it partway through — a 302. Guarding only
    // the first leaves the whole rule to the other end: a dev server answering with a redirect walks
    // an agent's tab straight off this machine, and the agent never asked for anywhere but localhost.
    const holdToRule = (e: Electron.Event, url: string): void => {
      if (!agentNavigationAllowed(url, isAgentGuest(guest.id))) e.preventDefault()
    }
    guest.on('will-navigate', (e, url) => holdToRule(e, url))
    guest.on('will-redirect', (e, url) => holdToRule(e, url))
  })
  // Camera, microphone, notifications and the rest: a page from this machine may ask; others are refused.
  // Both handlers, because Electron splits the question in two. A prompting request (getUserMedia,
  // Notification.requestPermission) goes to the request handler; a synchronous check
  // (navigator.permissions.query, enumerateDevices) goes to the check handler, and an unset check
  // handler falls back to Electron's default rather than to this rule — so installing only the first
  // would enforce "this machine only" on one of the two paths.
  const previewSession = session.fromPartition(PREVIEW_PARTITION)
  previewSession.setPermissionRequestHandler((_wc, _permission, callback, details) => {
    callback(permissionAllowed(details.requestingUrl))
  })
  previewSession.setPermissionCheckHandler((_wc, _permission, requestingOrigin) =>
    permissionAllowed(requestingOrigin)
  )
  // Dev HTTPS (mkcert) on localhost is waved through; the app's own window and any other host are not.
  app.on('certificate-error', (e, wc, url, _error, _certificate, callback) => {
    const ok = certificateAllowed(url, wc.getType())
    if (ok) e.preventDefault()
    callback(ok)
  })
}
