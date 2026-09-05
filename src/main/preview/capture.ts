// Crops a screenshot of one element out of a preview guest and saves it as a PNG. The path goes into
// the prompt; Claude Code opens image paths it is given, which is how the agent gets to see the
// element rather than read about it.
import { ipcMain, webContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isSaneRect } from '../../core/preview/pick/rect'
import { evictionPlan } from '../../core/preview/pick/shots'
import type { CaptureResult } from '../../core/preview/pick/types'

/** Twice the card's 56 CSS pixels, so it stays sharp on a retina display and no larger. */
const THUMBNAIL_WIDTH = 112

function guestFor(id: unknown): Electron.WebContents | null {
  if (typeof id !== 'number' || !Number.isInteger(id)) return null
  const guest = webContents.fromId(id)
  if (!guest || guest.isDestroyed() || guest.getType() !== 'webview') return null
  return guest
}

/** Applies the eviction rule to the store. Errors are swallowed: a failed cleanup must not fail a
 *  capture, and the next capture tries again. */
async function evict(dir: string): Promise<void> {
  try {
    const names = await readdir(dir)
    const files = await Promise.all(
      names.filter((n) => n.endsWith('.png')).map(async (n) => {
        const p = path.join(dir, n)
        return { path: p, mtimeMs: (await stat(p)).mtimeMs }
      })
    )
    await Promise.all(evictionPlan(files, Date.now()).map((p) => unlink(p).catch(() => {})))
  } catch {
    /* the folder may not exist yet */
  }
}

export function registerPreviewCapture(userData: string): void {
  const dir = path.join(userData, 'preview', 'shots')
  void evict(dir)
  ipcMain.handle('preview.captureElement', async (_e, guestId: unknown, rect: unknown): Promise<CaptureResult | null> => {
    const guest = guestFor(guestId)
    // Chromium's capture wedges on NaN or Infinity, so the rect is checked here rather than trusted.
    if (!guest || !isSaneRect(rect)) return null
    try {
      const image = await guest.capturePage(rect)
      const size = image.getSize()
      if (size.width === 0 || size.height === 0) return null
      await mkdir(dir, { recursive: true })
      const file = path.join(dir, `${randomUUID()}.png`)
      await writeFile(file, image.toPNG())
      void evict(dir)
      // Resized first: a full-width element's crop is a large PNG, and this one only ever fills a
      // 56-pixel card. `resize` keeps the aspect ratio when only a width is given.
      const thumb = size.width > THUMBNAIL_WIDTH ? image.resize({ width: THUMBNAIL_WIDTH }) : image
      return { path: file, width: size.width, height: size.height, thumbnail: thumb.toDataURL() }
    } catch {
      return null
    }
  })
}
