// isOwnDocument decides whether a will-navigate target is the app's own window, split out of
// index.ts for the same reason as ozone.ts's shouldForceWaylandOzone: index.ts calls
// app.requestSingleInstanceLock() and friends at module scope, so importing it at all requires a real
// Electron runtime — a pure decision function has to live elsewhere to be covered by vitest.

/** Is `url` the document a BrowserWindow was loaded with — including a full reload back to that same
 *  target? main/index.ts's will-navigate handler uses this to let a reload of the app's own window
 *  through while still preventing every other navigation.
 *
 *  `devServerUrl` and `indexFileUrl` are seams (the same shape as shouldForceWaylandOzone's `exists`)
 *  so the call site's own values are covered by the test rather than read here: `devServerUrl` is
 *  `process.env['ELECTRON_RENDERER_URL']`, set only in `npm run dev`, where the renderer is served
 *  from Vite's dev server — same-origin covers that server's HMR/reload traffic too. `indexFileUrl`
 *  is the file:// URL the production build's loadFile call navigates to; file: URLs carry no origin
 *  (WHATWG gives them "null"), so that branch compares the file the URL names instead. The IPC guard asks
 *  this of every call (ipcGuard.ts), so a URL naming the same file another way must still pass: a `#` link
 *  in a chat reply moves the page to `index.html#...`, and Chromium writes the drive letter upper case and
 *  leaves `[ ] ~` unescaped where Node's pathToFileURL does not (security gate final review C1, I1). */
export function isOwnDocument(
  url: string,
  devServerUrl: string | undefined,
  indexFileUrl: string,
  windows: boolean = process.platform === 'win32'
): boolean {
  if (devServerUrl) {
    try {
      return new URL(url).origin === new URL(devServerUrl).origin
    } catch {
      return false
    }
  }
  return sameFile(url, indexFileUrl, windows)
}

/** Two file: URLs naming the same file: the fragment and the query left out, escapes decoded, and on Windows
 *  without regard to case (its file system ignores it, and the drive letter is spelled both ways). */
function sameFile(a: string, b: string, windows: boolean): boolean {
  try {
    const ua = new URL(a)
    const ub = new URL(b)
    if (ua.protocol !== 'file:' || ub.protocol !== 'file:' || ua.host !== ub.host) return false
    const pa = decodeURIComponent(ua.pathname)
    const pb = decodeURIComponent(ub.pathname)
    return windows ? pa.toLowerCase() === pb.toLowerCase() : pa === pb
  } catch {
    return false
  }
}
