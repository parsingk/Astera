// Crops a screenshot of one element out of a preview guest and saves it as a PNG. The path goes into
// the prompt; Claude Code opens image paths it is given, which is how the agent gets to see the
// element rather than read about it. The writing and the eviction rule live in shots.ts, shared with
// the agent browser's screenshot().
import { ipcMain, webContents } from 'electron'
import { isSaneRect } from '../../core/preview/pick/rect'
import type { CaptureResult } from '../../core/preview/pick/types'
import { evictShots, previewShotsDir, savePng } from './shots'

function guestFor(id: unknown): Electron.WebContents | null {
  if (typeof id !== 'number' || !Number.isInteger(id)) return null
  const guest = webContents.fromId(id)
  if (!guest || guest.isDestroyed() || guest.getType() !== 'webview') return null
  return guest
}

export function registerPreviewCapture(userData: string): void {
  const dir = previewShotsDir(userData)
  void evictShots(dir)
  ipcMain.handle('preview.captureElement', async (_e, guestId: unknown, rect: unknown): Promise<CaptureResult | null> => {
    const guest = guestFor(guestId)
    // Chromium's capture wedges on NaN or Infinity, so the rect is checked here rather than trusted.
    if (!guest || !isSaneRect(rect)) return null
    try {
      return await savePng(await guest.capturePage(rect), dir)
    } catch {
      return null
    }
  })
}
