// The preview's viewport presets.
//
// Size tiers, not device names. What a developer checks is "does this hold together at 375?", and a
// tier labelled with its own dimensions answers that without anyone having to remember how wide a
// Pixel 7 is. The dimensions are Chrome DevTools' own, and Orca's browser landed on the same shape.
//
// This exists because DevTools cannot supply it here: the device toolbar is not offered for a
// <webview> guest — measured, the button is absent and its shortcut does nothing — while Electron's
// `webContents.enableDeviceEmulation` drives a guest perfectly well. So the pane owns the picker and
// main applies the metrics.
// node: no imports — the renderer imports this file.

export type ViewportKey =
  | 'fill'
  | 'mobileS'
  | 'mobileM'
  | 'mobileL'
  | 'tablet'
  | 'laptop'
  | 'laptopL'
  | 'desktop'

export interface Viewport {
  key: ViewportKey
  /** null for `fill`, which is the pane's own size and no emulation at all. */
  size: { width: number; height: number } | null
  /** Device pixel ratio. What decides which image a `srcset` picks. 1 on the desktop tiers. */
  deviceScaleFactor: number
  /** Chromium's "mobile" screen position: it changes how a viewport meta tag is honoured, so a page
   *  without one is laid out wide and scaled down the way a phone really does it. */
  mobile: boolean
}

/** `fill` first, then narrow to wide. Every label is built from the key's translated name plus these
 *  dimensions, so the numbers live here alone and cannot drift between languages. */
export const VIEWPORTS: readonly Viewport[] = [
  { key: 'fill', size: null, deviceScaleFactor: 0, mobile: false },
  { key: 'mobileS', size: { width: 320, height: 568 }, deviceScaleFactor: 2, mobile: true },
  { key: 'mobileM', size: { width: 375, height: 667 }, deviceScaleFactor: 2, mobile: true },
  { key: 'mobileL', size: { width: 425, height: 812 }, deviceScaleFactor: 2, mobile: true },
  { key: 'tablet', size: { width: 768, height: 1024 }, deviceScaleFactor: 2, mobile: true },
  { key: 'laptop', size: { width: 1024, height: 768 }, deviceScaleFactor: 1, mobile: false },
  { key: 'laptopL', size: { width: 1440, height: 900 }, deviceScaleFactor: 1, mobile: false },
  { key: 'desktop', size: { width: 1920, height: 1080 }, deviceScaleFactor: 1, mobile: false }
]

export function viewportByKey(key: string): Viewport | null {
  return VIEWPORTS.find((v) => v.key === key) ?? null
}

/** A size turned on its side. Rotating twice gives the original back. */
export function rotate(size: { width: number; height: number }): { width: number; height: number } {
  return { width: size.height, height: size.width }
}

/** How much to shrink a viewport so it fits the stage, the way Chrome's "fit to window" does. Never
 *  enlarges: a viewport smaller than the stage is shown at its own size, centred. A stage that has
 *  not been measured yet (zero) leaves the scale alone rather than collapsing the page to nothing. */
export function fitScale(
  size: { width: number; height: number },
  stage: { width: number; height: number }
): number {
  if (size.width <= 0 || size.height <= 0 || stage.width <= 0 || stage.height <= 0) return 1
  return Math.min(1, stage.width / size.width, stage.height / size.height)
}

/** What main applies. `null` means emulation off — the page goes back to the pane's own size. */
export interface EmulationMetrics {
  width: number
  height: number
  /** 0 tells Electron to keep the display's real ratio, which is what `fill` wants. */
  deviceScaleFactor: number
  mobile: boolean
  scale: number
}

/** The metrics for a selection. `rotated` swaps the tier's dimensions; `fill` ignores it and yields
 *  null, because there is nothing to emulate. */
export function metricsFor(
  viewport: Viewport,
  opts: { rotated: boolean; stage: { width: number; height: number } }
): EmulationMetrics | null {
  if (!viewport.size) return null
  const size = opts.rotated ? rotate(viewport.size) : viewport.size
  return {
    width: size.width,
    height: size.height,
    deviceScaleFactor: viewport.deviceScaleFactor,
    mobile: viewport.mobile,
    scale: fitScale(size, opts.stage)
  }
}

/** Metrics main will accept. Chromium's emulation wedges on a non-finite or non-positive number and
 *  leaves the page unusable, so the numbers are checked where they cross into the main process rather
 *  than trusted from the renderer. `deviceScaleFactor` may be 0, which means "keep the real one". */
export function areMetricsSane(m: unknown): m is EmulationMetrics {
  if (m === null || typeof m !== 'object') return false
  const o = m as Record<string, unknown>
  const positive = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v > 0
  const zeroOrPositive = (v: unknown): boolean =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0
  return (
    positive(o.width) &&
    positive(o.height) &&
    zeroOrPositive(o.deviceScaleFactor) &&
    positive(o.scale) &&
    typeof o.mobile === 'boolean'
  )
}
