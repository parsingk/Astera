import { sanitizeFontFamily } from '../../../core/terminal/font'

type FontData = { family: string }
type WithQuery = { queryLocalFonts?: () => Promise<FontData[]> }

let cache: string[] | null = null

/**
 * The installed font families, sorted, deduplicated, and limited to names that can be written into a
 * CSS font-family string.
 *
 * queryLocalFonts() is the Local Font Access API. Electron permits it unconditionally — its permission
 * handler does not intercept the API (electron#39140) — so there is no prompt and no OS-specific
 * enumeration to maintain. Call it from a click handler anyway: that is a user gesture, which keeps it
 * working if Electron ever starts requiring one.
 *
 * Cached for the life of the renderer. Installing a font mid-session is rare enough that a restart is a
 * fair price for not re-enumerating on every dropdown open.
 */
export async function listLocalFontFamilies(): Promise<string[]> {
  if (cache) return cache
  const query = (globalThis as WithQuery).queryLocalFonts
  if (typeof query !== 'function') return []
  const families = new Set<string>()
  for (const font of await query()) {
    const name = sanitizeFontFamily(font.family)
    if (name) families.add(name)
  }
  cache = [...families].sort((a, b) => a.localeCompare(b))
  return cache
}

/**
 * Whether the family draws Hangul itself.
 *
 * Measures '한' against a font stack that cannot draw it, so both sides fall back to the same last
 * resort when the family has no Hangul glyph and the widths match. A family that does have the glyph
 * measures differently. This is only used for the settings hint, so a rare wrong answer costs a
 * misleading sentence, not a broken terminal.
 */
export function hasHangulGlyph(family: string): boolean {
  const safe = sanitizeFontFamily(family)
  if (!safe) return false
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return false
  const measure = (stack: string): number => {
    ctx.font = `32px ${stack}`
    return ctx.measureText('한').width
  }
  // A family name that does not exist forces the generic fallback — the same one the real family falls
  // back to when it has no Hangul.
  const fallback = measure('"__astera_no_such_font__", monospace')
  return measure(`"${safe}", "__astera_no_such_font__", monospace`) !== fallback
}
