// The preview's DevTools window.
//
// `webview.openDevTools()` lets Electron create the window, and that window is not ours: it carries
// Electron's own icon and its own title, so it does not read as part of this app in the taskbar or
// the alt-tab list. `setDevToolsWebContents` is the documented way to host DevTools in a window the
// application creates, which is what this module does — one window per guest, with the app icon and
// a title naming the page it is inspecting.
import { BrowserWindow, ipcMain, webContents, type NativeImage } from 'electron'

/** Guest webContents id → the window hosting its DevTools. Absent means closed. */
const hosts = new Map<number, BrowserWindow>()

/** Keeps a title readable and bounded — it comes from the renderer, which took it from a page. */
function windowTitle(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
  return text === '' ? 'DevTools' : `DevTools — ${text.slice(0, 80)}`
}

/** Registers `preview.toggleDevTools`. Called from createWindow, which owns the app icon.
 *  Resolves to whether DevTools is open after the call. */
export function registerPreviewDevTools(icon: NativeImage): void {
  ipcMain.handle('preview.toggleDevTools', (_e, guestId: unknown, title: unknown) => {
    if (typeof guestId !== 'number' || !Number.isInteger(guestId)) return false
    const guest = webContents.fromId(guestId)
    // Only a guest page. The renderer is this app's own code, but an id is just a number and every
    // other guard in the preview is written the same way — the check costs nothing.
    if (!guest || guest.isDestroyed() || guest.getType() !== 'webview') return false

    const open = hosts.get(guestId)
    if (open) {
      open.close() // its 'closed' handler drops the entry and tells the guest
      return false
    }

    const host = new BrowserWindow({
      width: 1000,
      height: 700,
      icon,
      title: windowTitle(title),
      autoHideMenuBar: true
    })
    // DevTools sets its own document title once it loads; this keeps the one we chose.
    host.on('page-title-updated', (e) => e.preventDefault())
    hosts.set(guestId, host)

    const forget = (): void => {
      if (hosts.get(guestId) === host) hosts.delete(guestId)
    }
    host.on('closed', () => {
      forget()
      // Closing the window is how the user closes DevTools, so the guest has to be told — otherwise it
      // still believes they are open and the toolbar button stays lit with nothing behind it.
      if (!guest.isDestroyed() && guest.isDevToolsOpened()) guest.closeDevTools()
    })
    // The page closed DevTools from its own side, or the guest went away with the tab.
    guest.once('devtools-closed', () => {
      forget()
      if (!host.isDestroyed()) host.close()
    })
    guest.once('destroyed', () => {
      forget()
      if (!host.isDestroyed()) host.close()
    })

    guest.setDevToolsWebContents(host.webContents)
    guest.openDevTools({ mode: 'detach' })
    return true
  })
}
