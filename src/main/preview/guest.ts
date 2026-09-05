// Wires the preview guest guards (core/preview/guards.ts decides; this file only listens). The
// <webview> in a browser tab is the developer's dev server, plus whatever that page pulls in — so it
// runs sandboxed, in its own partition, with no preload, and cannot open windows or leave http(s).
import { app, session, type BrowserWindow } from 'electron'
import {
  PREVIEW_PARTITION,
  certificateAllowed,
  guestAttachAllowed,
  guestNavigationAllowed,
  permissionAllowed
} from '../../core/preview/guards'

export function installPreviewGuards(win: BrowserWindow): void {
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
    guest.on('will-navigate', (e, url) => {
      if (!guestNavigationAllowed(url)) e.preventDefault()
    })
  })
  // Camera, microphone, notifications and the rest: a page from this machine may ask; others are refused.
  session.fromPartition(PREVIEW_PARTITION).setPermissionRequestHandler((_wc, _permission, callback, details) => {
    callback(permissionAllowed(details.requestingUrl))
  })
  // Dev HTTPS (mkcert) on localhost is waved through; the app's own window and any other host are not.
  app.on('certificate-error', (e, wc, url, _error, _certificate, callback) => {
    const ok = certificateAllowed(url, wc.getType())
    if (ok) e.preventDefault()
    callback(ok)
  })
}
