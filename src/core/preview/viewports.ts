// The preview's viewport widths. Width only — no user agent or touch emulation; the point is to see
// where a responsive layout breaks, not to impersonate a device.
// node: no imports — the renderer imports this file.

export type ViewportKey = 'desktop' | 'tablet' | 'mobile'

/** `width: null` fills the pane. The two fixed widths are common breakpoint probes: a portrait tablet
 *  and a current phone. */
export const VIEWPORTS: readonly { key: ViewportKey; width: number | null }[] = [
  { key: 'desktop', width: null },
  { key: 'tablet', width: 768 },
  { key: 'mobile', width: 390 }
]
