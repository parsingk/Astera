// Applies a viewport preset to a preview guest.
//
// `webContents.enableDeviceEmulation` is the whole mechanism, and it lives on WebContents, so the
// renderer cannot reach it. Chrome's own device toolbar is not an option here: DevTools does not offer
// it for a <webview> guest (measured — the button is absent and Ctrl+Shift+M does nothing), while this
// API drives a guest correctly. Doing it this way also keeps the debugger free, so the pane's DevTools
// button never has to compete with emulation for the one debugger a guest can have.
import { ipcMain, webContents } from 'electron'
import { areMetricsSane, type EmulationMetrics } from '../../core/preview/viewports'

/** Per guest, the last emulation call chained onto the previous one. Rapid switching sends several
 *  calls before any completes, and interleaving them leaves the page at whichever finished last
 *  rather than whichever was asked for last. */
const queues = new Map<number, Promise<void>>()

function guestFor(id: unknown): Electron.WebContents | null {
  if (typeof id !== 'number' || !Number.isInteger(id)) return null
  const guest = webContents.fromId(id)
  // Only a guest page. The renderer is this app's own code, but an id is just a number, and every
  // other guard in the preview is written the same way.
  if (!guest || guest.isDestroyed() || guest.getType() !== 'webview') return null
  return guest
}

function apply(guest: Electron.WebContents, metrics: EmulationMetrics | null): void {
  if (!metrics) {
    guest.disableDeviceEmulation()
    return
  }
  guest.enableDeviceEmulation({
    screenPosition: metrics.mobile ? 'mobile' : 'desktop',
    screenSize: { width: metrics.width, height: metrics.height },
    viewSize: { width: metrics.width, height: metrics.height },
    viewPosition: { x: 0, y: 0 },
    deviceScaleFactor: metrics.deviceScaleFactor,
    scale: metrics.scale
  })
}

export function registerPreviewEmulation(): void {
  ipcMain.handle('preview.emulate', async (_e, guestId: unknown, metrics: unknown) => {
    const guest = guestFor(guestId)
    if (!guest) return false
    // Chromium's emulation wedges on a non-finite or non-positive number and leaves the page in a
    // state nothing short of a reload recovers from, so the numbers are checked here, at the boundary,
    // rather than trusted from the renderer.
    const wanted = metrics === null ? null : areMetricsSane(metrics) ? metrics : undefined
    if (wanted === undefined) return false
    const id = guest.id
    const prev = queues.get(id) ?? Promise.resolve()
    const next = prev
      .catch(() => {})
      .then(() => {
        // Re-check: the queue may have waited while the tab closed
        const live = guestFor(id)
        if (live) apply(live, wanted)
      })
    queues.set(id, next)
    try {
      await next
      return true
    } finally {
      // Only clear if still the tail; a later call may have replaced the entry
      if (queues.get(id) === next) queues.delete(id)
    }
  })
}
