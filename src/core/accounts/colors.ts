/**
 * The colours that tell accounts apart. Not only the sidebar dot: the tab marker (WorkbenchTabs), the
 * pane border (PaneGrid) and the history rail (HistoryBrowser) all read the same value, so two accounts
 * sharing a colour breaks the distinction in four places at once.
 *
 * The first six are fixed, order included. Accounts registered before this palette existed have their
 * colour stored in accounts.json, and keeping those untouched is why new colours are only ever appended.
 *
 * The appended six are ordered by "furthest hue from everything already in the list", so a seventh
 * account lands as far from the first six as the palette allows. Reordering them loses that property.
 * Across all twelve the smallest hue gap is 16° (teal to cyan) and the mean is 30°; colors.test.ts
 * holds the floor.
 */
export const ACCOUNT_COLORS: readonly string[] = [
  '#4f9cf9', // blue
  '#f97316', // orange
  '#22c55e', // green
  '#e879f9', // fuchsia
  '#facc15', // yellow
  '#ef4444', // red
  '#a78bfa', // violet
  '#84cc16', // lime
  '#f472b6', // pink
  '#2dd4bf', // teal
  '#818cf8', // indigo
  '#06b6d4' // cyan
]

/** Saturation and lightness for the colours generated once the palette runs out. The same band the
 *  palette sits in, so a generated colour neither glares next to the twelve nor sinks into the panel. */
const GENERATED_SATURATION = 0.7
const GENERATED_LIGHTNESS = 0.6

const HEX = /^#([0-9a-fA-F]{6})$/

/** A colour's hue (0 to under 360), or null when the string is not a six-digit hex. Stored values can be
 *  anything, so this answers rather than throws. Greys have no hue but answer 0 (red): the value is only
 *  ever used for distances, so one grey occupying the red end costs nothing else. */
export function hueOf(hex: string): number | null {
  const m = HEX.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const max = Math.max(r, g, b)
  const c = max - Math.min(r, g, b)
  if (c === 0) return 0
  const h = max === r ? ((g - b) / c) % 6 : max === g ? (b - r) / c + 2 : (r - g) / c + 4
  return (h * 60 + 360) % 360
}

/** Distance between two hues around the circle: 350° and 10° are 20° apart, not 340°. */
function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return Math.min(d, 360 - d)
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x]
  const byte = (v: number): string =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${byte(r)}${byte(g)}${byte(b)}`
}

/**
 * A colour unlike any in `taken`. While the palette has a free entry that entry is used; once it is full
 * a new colour is generated.
 *
 * Walking the palette for the first *unused* entry rather than counting to the next one is the point.
 * Removing an account frees its colour, and an index derived from how many accounts exist walks straight
 * past that gap and hands out a colour another account is still wearing.
 */
export function nextAccountColor(taken: Iterable<string>): string {
  const used = new Set<string>()
  for (const c of taken) used.add(c.trim().toLowerCase())

  const free = ACCOUNT_COLORS.find((c) => !used.has(c))
  if (free) return free

  // The palette is full. Take the hue whose smallest distance to a hue in use is the largest, which is
  // the middle of the widest gap on the colour wheel. Unlike stepping by a fixed angle, this refills a
  // gap that opens up when an account is removed instead of drifting past it.
  const hues = [...used].map(hueOf).filter((h): h is number => h !== null)
  let best = 0
  let bestGap = -1
  for (let h = 0; h < 360; h++) {
    const gap = hues.length === 0 ? 360 : Math.min(...hues.map((t) => hueGap(h, t)))
    if (gap > bestGap) {
      bestGap = gap
      best = h
    }
  }
  // No colour in `used` shares the chosen hue: if one did its distance would be 0, and 0 being the
  // largest such distance would mean all 360 hues are occupied, which takes 360 accounts. So below that
  // the colour returned here differs from every colour in `taken`.
  return hslToHex(best, GENERATED_SATURATION, GENERATED_LIGHTNESS)
}
