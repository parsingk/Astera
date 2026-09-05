// Rect checks and the one transform Design Mode needs.
// node: no imports — the renderer imports this file.
import type { Rect } from './types'

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** A rect capturePage can take: finite everywhere, a positive size, a non-negative origin. Chromium's
 *  capture wedges on NaN or Infinity, so this is checked at the main-process boundary too. */
export function isSaneRect(rect: unknown): rect is Rect {
  if (rect === null || typeof rect !== 'object') return false
  const r = rect as Record<string, unknown>
  return finite(r.x) && finite(r.y) && finite(r.width) && finite(r.height) && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0
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
