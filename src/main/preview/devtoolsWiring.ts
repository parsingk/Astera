// How a DevTools window and its guest close each other (preview/devtools.ts). Its own module so it runs without Electron.

interface HostWindow {
  on(event: 'closed', f: () => void): unknown
  isDestroyed(): boolean
  close(): void
}

interface Guest {
  once(event: 'devtools-closed' | 'destroyed', f: () => void): unknown
  off(event: 'devtools-closed' | 'destroyed', f: () => void): unknown
  isDestroyed(): boolean
  isDevToolsOpened(): boolean
  closeDevTools(): void
}

/** Closing the window closes the guest's DevTools; the guest closing them, or going away, closes the window. Either way
 *  the guest's listeners for this window go with it (second pass M2-3: each window the person closed left two). */
export function wireDevtoolsWindow(host: HostWindow, guest: Guest, forget: () => void): void {
  const fromGuest = (): void => {
    forget()
    if (!host.isDestroyed()) host.close()
  }
  host.on('closed', () => {
    guest.off('devtools-closed', fromGuest)
    guest.off('destroyed', fromGuest)
    forget()
    // Closing the window is how the user closes DevTools, so the guest has to be told — otherwise it
    // still believes they are open and the toolbar button stays lit with nothing behind it.
    if (!guest.isDestroyed() && guest.isDevToolsOpened()) guest.closeDevTools()
  })
  // The page closed DevTools from its own side, or the guest went away with the tab.
  guest.once('devtools-closed', fromGuest)
  guest.once('destroyed', fromGuest)
}
