// The screenshot store: where element and page screenshots are written, and the rule that keeps the
// folder small. No Electron here on purpose — the agent browser's helpers (agentBrowser/helpers.ts)
// write through this too, and their tests run where `electron` cannot be loaded. capture.ts, the
// Design Mode IPC, is the Electron-facing half and calls in.
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { evictionPlan } from '../../core/preview/pick/shots'
import type { CaptureResult } from '../../core/preview/pick/types'

/** The two things this needs from Electron's NativeImage, so tests pass a plain object. */
export interface CapturedImage {
  getSize(): { width: number; height: number }
  toPNG(): Buffer
}

/** Where screenshots are written. Kept as one function so the session spawn, which grants a Claude
 *  session read access to exactly this folder (--add-dir), names the same path this writes to. */
export function previewShotsDir(userData: string): string {
  return path.join(userData, 'preview', 'shots')
}

/** Applies the eviction rule to the store. Errors are swallowed: a failed cleanup must not fail a
 *  capture, and the next capture tries again. */
export async function evictShots(dir: string): Promise<void> {
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

/** Writes the image as a PNG under `dir` and reports where; null for an image with no pixels, which
 *  is what capturePage returns for a guest that is not painting. */
export async function savePng(image: CapturedImage, dir: string): Promise<CaptureResult | null> {
  const size = image.getSize()
  if (size.width === 0 || size.height === 0) return null
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `${randomUUID()}.png`)
  await writeFile(file, image.toPNG())
  void evictShots(dir)
  return { path: file, width: size.width, height: size.height }
}
