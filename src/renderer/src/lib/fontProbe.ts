import { sanitizeFontFamily } from '../../../core/terminal/font'
import { fontCoversHangul } from '../../../core/terminal/hangulCoverage'

type FontData = { family: string; blob: () => Promise<Blob> }
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

/** One FontData per distinct family — the first face queryLocalFonts() reports for it, since
 *  Hangul coverage is a family-level question here (a family's regular and bold weight do not
 *  disagree about which scripts they draw). Built once and reused by both exports below. */
let familyDataCache: Map<string, FontData> | null = null
// The in-flight build, so two callers that arrive before the first one finishes share it instead
// of each calling queryLocalFonts() themselves — the settled-result cache above only helps once
// the first call has already completed.
let familyDataInFlight: Promise<Map<string, FontData>> | null = null

async function familyData(): Promise<Map<string, FontData>> {
  if (familyDataCache) return familyDataCache
  if (familyDataInFlight) return familyDataInFlight
  familyDataInFlight = (async () => {
    const map = new Map<string, FontData>()
    const query = (globalThis as WithQuery).queryLocalFonts
    if (typeof query === 'function') {
      for (const font of await query()) {
        const name = sanitizeFontFamily(font.family)
        if (name && !map.has(name)) map.set(name, font)
      }
    }
    familyDataCache = map
    return map
  })()
  try {
    return await familyDataInFlight
  } finally {
    familyDataInFlight = null
  }
}

/** How many families to probe at once. Each probe is a handful of small ranged reads against a
 *  Blob, not a full-file read, so this is about bounding concurrent promises rather than disk or
 *  memory pressure — 16 is the batch size the approach was prototyped and measured with. */
const BATCH_SIZE = 16

const hangulCache = new Map<string, boolean>()

/** Whether one family draws Hangul, decided by reading its font file's cmap table for U+AC00
 *  rather than by measuring rendered glyph width — see hangulCoverage.ts for why the width
 *  comparison this replaces was unsound. Memoised per family for the renderer's life; a family
 *  whose file fails to parse is recorded as non-covering rather than left to error again later. */
export async function familyCoversHangul(family: string): Promise<boolean> {
  const cached = hangulCache.get(family)
  if (cached !== undefined) return cached

  const data = (await familyData()).get(family)
  if (!data) {
    hangulCache.set(family, false)
    return false
  }

  const covers = await probe(data)
  hangulCache.set(family, covers)
  return covers
}

async function probe(data: FontData): Promise<boolean> {
  try {
    const blob = await data.blob()
    return await fontCoversHangul((start, end) => blob.slice(start, end).arrayBuffer())
  } catch {
    // A file that fails to parse is simply not Hangul-capable for this purpose, not an error that
    // should abort listHangulFamilies() or surface to the user.
    return false
  }
}

let hangulFamiliesCache: string[] | null = null
// Same in-flight sharing as familyData(): the settled-result cache above is null for the whole
// duration of the scan, so without this, onMouseDown and onFocus firing on the same click (or any
// other pair of near-simultaneous callers) would each start a full, independent batch scan —
// twice the concurrent blob reads and roughly double the wall-clock work.
let hangulFamiliesInFlight: Promise<string[]> | null = null

/**
 * The subset of installed families that actually draw Hangul, sorted. Cached for the renderer's
 * life, same rationale as listLocalFontFamilies().
 *
 * Processes families in bounded batches (BATCH_SIZE) rather than all at once — probing every
 * installed family's font file is the kind of fan-out that is fine at 16 concurrent reads and
 * would just create contention at 300+.
 */
export async function listHangulFamilies(): Promise<string[]> {
  if (hangulFamiliesCache) return hangulFamiliesCache
  if (hangulFamiliesInFlight) return hangulFamiliesInFlight
  hangulFamiliesInFlight = (async () => {
    const data = await familyData()
    const names = [...data.keys()]
    const result: string[] = []

    for (let i = 0; i < names.length; i += BATCH_SIZE) {
      const batch = names.slice(i, i + BATCH_SIZE)
      const covers = await Promise.all(
        batch.map(async (name) => {
          const cached = hangulCache.get(name)
          if (cached !== undefined) return cached
          const value = await probe(data.get(name) as FontData)
          hangulCache.set(name, value)
          return value
        })
      )
      batch.forEach((name, idx) => {
        if (covers[idx]) result.push(name)
      })
    }

    hangulFamiliesCache = result.sort((a, b) => a.localeCompare(b))
    return hangulFamiliesCache
  })()
  try {
    return await hangulFamiliesInFlight
  } finally {
    hangulFamiliesInFlight = null
  }
}
