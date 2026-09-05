// Rect checks and the one transform Design Mode needs.
// node: no imports — the renderer imports this file.
import type { Rect } from './types'

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** A rect with real numbers and a real size. The origin may be negative: an element scrolled so its top
 *  edge is above the fold has exactly that, and it is an ordinary thing to click. This is what a picked
 *  payload is checked against. */
export function isFiniteRect(rect: unknown): rect is Rect {
  if (rect === null || typeof rect !== 'object') return false
  const r = rect as Record<string, unknown>
  return finite(r.x) && finite(r.y) && finite(r.width) && finite(r.height) && r.width > 0 && r.height > 0
}

/** A rect capturePage can take: the above, and inside the view. Chromium's capture wedges on NaN or
 *  Infinity and has nothing to return for a region outside the viewport, so this is checked again at
 *  the main-process boundary.
 *
 *  **Not the payload's check.** Using it there rejected every element scrolled past the top of the
 *  window — the click did nothing at all, with no error and no way to tell why. `clampToView` is what
 *  turns a picked rect into one this accepts. */
export function isSaneRect(rect: unknown): rect is Rect {
  return isFiniteRect(rect) && rect.x >= 0 && rect.y >= 0
}

/** The part of `rect` that is actually on screen, or null when none of it is. An element taller than
 *  the window is normal, and asking to capture the part hanging off the edge gets nothing useful back
 *  — or, from a page that tampered with the picker, a demand for a region of any size at all. */
export function clampToView(rect: Rect, view: { width: number; height: number }): Rect | null {
  const left = Math.max(0, rect.x)
  const top = Math.max(0, rect.y)
  const right = Math.min(view.width, rect.x + rect.width)
  const bottom = Math.min(view.height, rect.y + rect.height)
  if (right <= left || bottom <= top) return null
  return { x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) }
}

/** The rect in the scaled view's pixels. capturePage takes view coordinates — measured: under a
 *  viewport preset drawn at scale 0.5, the page's (200,100,200×100) box was captured only by
 *  (100,50,100×50). Sizes never round to zero: a one-pixel element still gets a one-pixel crop. */
export function scaleRect(rect: Rect, scale: number): Rect {
  return {
    x: Math.round(rect.x * scale),
    y: Math.round(rect.y * scale),
    width: Math.max(1, Math.round(rect.width * scale)),
    height: Math.max(1, Math.round(rect.height * scale))
  }
}
