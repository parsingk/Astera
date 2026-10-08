// The size of an agent app workspace's app window, and the part of its page a mirror frame captures.
// Pure, so the renderer (the mirror tab reports its size), the app's main process (which forwards it)
// and the Host (which sizes the window and takes the frames) share one rule.
//
// Why the Host sizes the app at all (measured 2026-10-06, Windows 11, a 3840x2160 monitor at 150%): an
// Electron app that calls `maximize()` on the hidden desktop (the Astera app does) is maximized to the
// person's work area in device pixels (3840x2088), while its renderer kept laying out at the size it was
// created at (960x600 CSS px). `Page.getLayoutMetrics` answered 3840x2088, so a frame clipped to that
// size carried the app in its top left quarter and black everywhere else. Sizing the window alone did not
// hold (pageSizedByCdp says what was seen); the device metrics override made the page, the metrics and
// the capture agree at once, at any size.

export interface AppSize {
  width: number
  height: number
  /** The mirror tab's devicePixelRatio, when it said one: frames are captured at it, so a tab on a 150% screen shows
   *  a picture of its own pixels instead of a smaller one stretched (and blurred). It never sizes the window. */
  scale?: number
}

/** The densest screen a frame is captured for. */
export const MAX_VIEW_SCALE = 3

/** The window size when no mirror tab has said how big it is: the size the Astera app itself opens at. */
export const DEFAULT_APP_SIZE: AppSize = { width: 1280, height: 800 }
/** Smaller than this and most apps' layouts break; a mirror tab squeezed that far is shown scaled. */
export const MIN_APP_SIZE: AppSize = { width: 480, height: 320 }
/** No window is made larger than a 4K screen, however large the tab. */
export const MAX_APP_SIZE: AppSize = { width: 3840, height: 2160 }
/** How long the mirror tab waits after its last resize before it reports the size (one window resize
 *  per drag of a splitter, not one per frame of it). */
export const SIZE_REPORT_DEBOUNCE_MS = 250
/** A size within this many CSS pixels of the last one is the same size: a fit is not redone for it. */
export const SIZE_TOLERANCE_PX = 4

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** A reported size as whole CSS pixels inside MIN_APP_SIZE..MAX_APP_SIZE, or null when it is not a size
 *  (a hidden tab measures 0 by 0, and that says nothing about how big the app should be). */
export function clampAppSize(v: unknown): AppSize | null {
  if (typeof v !== 'object' || v === null) return null
  const { width, height } = v as { width?: unknown; height?: unknown }
  if (!finite(width) || !finite(height) || width <= 0 || height <= 0) return null
  const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(n)))
  const scale = (v as { scale?: unknown }).scale
  return {
    width: clamp(width, MIN_APP_SIZE.width, MAX_APP_SIZE.width),
    height: clamp(height, MIN_APP_SIZE.height, MAX_APP_SIZE.height),
    ...(finite(scale) && scale > 0 ? { scale: Math.min(MAX_VIEW_SCALE, Math.max(1, Math.round(scale * 100) / 100)) } : {})
  }
}

export function sameSize(a: AppSize | null, b: AppSize | null, tolerance = SIZE_TOLERANCE_PX): boolean {
  if (a === null || b === null) return a === b
  return Math.abs(a.width - b.width) <= tolerance && Math.abs(a.height - b.height) <= tolerance
}

/** What the mirror tab sends after a resize settles: the clamped size, or null when there is nothing to
 *  send (not a size, or the size it last sent). */
export function sizeToReport(last: AppSize | null, measured: { width: number; height: number; scale?: number }): AppSize | null {
  const next = clampAppSize(measured)
  if (next === null || (sameSize(last, next, 1) && (last?.scale ?? 1) === (next.scale ?? 1))) return null
  return next
}

/** The size a window's client area is given, in device pixels, for a page of `css` at `dpr`. */
export function deviceSize(css: AppSize, dpr: unknown): AppSize {
  const r = finite(dpr) && dpr > 0 ? dpr : 1
  return { width: Math.round(css.width * r), height: Math.round(css.height * r) }
}

export interface FrameClip {
  /** The page's viewport in CSS pixels with its scrollbars, which is what the size override sets. */
  css: AppSize
  /** Page.captureScreenshot's clip: the whole viewport at the viewer's scale, `maxWidth` pixels wide at most. */
  clip: { x: 0; y: 0; width: number; height: number; scale: number }
  /** The frame's size in pixels. */
  frame: AppSize
}

/** The capture of the page's whole viewport, or null when nothing gives its size (the capture then
 *  takes whatever the page has). `inner` is the page's window.innerWidth and innerHeight, which count
 *  its scrollbars; Page.getLayoutMetrics' client sizes leave a scrollbar out (a page with a 15 px
 *  vertical scrollbar reads 1265 wide at an override of 1280), so they are only the fallback. */
export function frameClip(metrics: Record<string, unknown>, maxWidth: number, inner?: unknown, viewScale = 1): FrameClip | null {
  const vp = (metrics.cssVisualViewport ?? metrics.cssLayoutViewport) as { clientWidth?: unknown; clientHeight?: unknown } | undefined
  const own = Array.isArray(inner) && finite(inner[0]) && finite(inner[1]) && inner[0] > 0 && inner[1] > 0 ? { w: inner[0], h: inner[1] } : null
  const w = own ? own.w : vp?.clientWidth
  const h = own ? own.h : vp?.clientHeight
  if (!finite(w) || !finite(h) || w <= 0 || h <= 0) return null
  const want = finite(viewScale) && viewScale > 1 ? viewScale : 1
  const scale = maxWidth > 0 && w * want > maxWidth ? maxWidth / w : want
  return {
    css: { width: w, height: h },
    clip: { x: 0, y: 0, width: w, height: h, scale },
    frame: { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) }
  }
}

/** Whether the page's viewport has drifted from the size the window was given: the app maximized or
 *  resized itself after the fit, or the fit did not take. */
export function needsRefit(viewport: AppSize, target: AppSize): boolean {
  return !sameSize(viewport, target)
}

/** Whether the page's size is set through CDP (Emulation.setDeviceMetricsOverride) instead of its
 *  window's. Measured on the Windows hidden desktop (desktop.e2e.test.ts): a window restored from
 *  maximized and resized with SetWindowPos often leaves its page at the old size, and after a few
 *  resizes the page stops following the window at all, while the device metrics override takes at once
 *  and the capture follows it. macOS has no window to size (the app runs in the person's session).
 *  Linux sizes the window on its own Xvfb (no window manager), and its drag() reads the page's offset
 *  in its window from the window and page sizes, which an override would make wrong.
 *
 *  The override is a page layer workaround for the mismatch between the window (sized in the person's
 *  device pixels) and the renderer (scale 1 on a display it does not have), not a window size: it holds
 *  for the page target the manager is connected to, so a popup or a second window of the app keeps its
 *  own size, and a CDP socket that drops takes the override with it until the next launch or relaunch. */
export function pageSizedByCdp(platform: string): boolean {
  return platform !== 'linux'
}
