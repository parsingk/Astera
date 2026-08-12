/** Reads bytes [start, end) of a font file. */
export type ByteReader = (start: number, end: number) => Promise<ArrayBuffer>

/** Anything past this many cmap subtable entries, or table-directory entries, is not a font this
 *  probe was written for — real fonts have a handful of cmap subtables (single digits) and a
 *  couple dozen table-directory entries. This is generous headroom over that (10x+) while still
 *  refusing to walk a multi-megabyte "count" field a malformed file might hand us. */
const MAX_ENTRIES = 4096

/** cmap table length beyond which reading it as one chunk would be an unreasonable allocation for
 *  a table whose whole job is a compact character-to-glyph map. Real cmap tables — even ones with
 *  many subtables covering many scripts — are well under a megabyte; this is 8x that. */
const MAX_CMAP_LENGTH = 8 * 1024 * 1024

const TTCF_TAG = 0x74746366 // 'ttcf'
const CMAP_TAG = 0x636d6170 // 'cmap'
const CODE_POINT = 0xac00 // U+AC00, the first Hangul syllable

/** Whether a format 4 cmap subtable maps `codePoint`. Format 4 stores parallel arrays: end codes,
 *  a padding word, then start codes, each segCount entries of 2 bytes. */
function format4Covers(view: DataView, codePoint: number): boolean {
  const segCountX2 = view.getUint16(6)
  const segCount = segCountX2 / 2
  const endCodeAt = 14
  const startCodeAt = 16 + segCountX2
  for (let i = 0; i < segCount; i++) {
    const end = view.getUint16(endCodeAt + i * 2)
    const start = view.getUint16(startCodeAt + i * 2)
    if (start <= codePoint && codePoint <= end) return true
  }
  return false
}

/** Whether a format 12 cmap subtable maps `codePoint`. Format 12 stores groups of
 *  (startCharCode, endCharCode, startGlyphId), 12 bytes each, nGroups of them starting at +16. */
function format12Covers(view: DataView, codePoint: number): boolean {
  const nGroups = view.getUint32(12)
  if (nGroups > MAX_ENTRIES) return false
  for (let i = 0; i < nGroups; i++) {
    const base = 16 + i * 12
    const start = view.getUint32(base)
    const end = view.getUint32(base + 4)
    if (start <= codePoint && codePoint <= end) return true
  }
  return false
}

/** platform 3 (Windows) encoding 1 (BMP) or 10 (full Unicode), or platform 0 (Unicode) — the
 *  encodings that carry Hangul in practice. */
function isUsablePlatform(platformId: number, encodingId: number): boolean {
  if (platformId === 0) return true
  if (platformId === 3 && (encodingId === 1 || encodingId === 10)) return true
  return false
}

/**
 * Reads a font file's `cmap` table and checks whether it maps U+AC00 (the first Hangul syllable,
 * '가'). This is the accurate test for "does this font draw Hangul": Hangul syllables are
 * full-width in essentially every Korean font, so measuring glyph width against a fallback stack
 * (the approach this replaces) cannot tell a real glyph from tofu — both measure the same. Reading
 * the cmap is exact because it asks the font file directly what it maps, with no rendering or
 * fallback-stack guesswork involved.
 *
 * Reads only the byte ranges it needs (never the whole file): the sfnt header, the table
 * directory, the cmap table's header and subtable directory, and each subtable's own header plus
 * its coverage arrays.
 */
export async function fontCoversHangul(read: ByteReader): Promise<boolean> {
  // sfnt header: 4-byte tag, then numTables (uint16) at offset 4. A TrueType Collection ('ttcf')
  // wraps one or more sfnt directories; its header holds the offset of the first one at byte 12.
  const header = new DataView(await read(0, 12))
  let base = 0
  if (header.getUint32(0) === TTCF_TAG) {
    const ttcHeader = new DataView(await read(12, 16))
    base = ttcHeader.getUint32(0)
  }

  const dirHeader = new DataView(await read(base, base + 12))
  const numTables = dirHeader.getUint16(4)
  if (numTables > MAX_ENTRIES) return false

  const dir = new DataView(await read(base + 12, base + 12 + 16 * numTables))
  let cmapOffset = -1
  let cmapLength = 0
  for (let i = 0; i < numTables; i++) {
    const recordAt = i * 16
    if (dir.getUint32(recordAt) === CMAP_TAG) {
      cmapOffset = dir.getUint32(recordAt + 8)
      cmapLength = dir.getUint32(recordAt + 12)
      break
    }
  }
  if (cmapOffset < 0) return false
  if (cmapLength <= 0 || cmapLength > MAX_CMAP_LENGTH) return false

  const cmap = new DataView(await read(cmapOffset, cmapOffset + cmapLength))
  const subtableCount = cmap.getUint16(2)
  if (subtableCount > MAX_ENTRIES) return false

  for (let i = 0; i < subtableCount; i++) {
    const recordAt = 4 + i * 8
    const platformId = cmap.getUint16(recordAt)
    const encodingId = cmap.getUint16(recordAt + 2)
    if (!isUsablePlatform(platformId, encodingId)) continue

    const subtableOffset = cmap.getUint32(recordAt + 4)
    if (subtableOffset + 4 > cmap.byteLength) continue
    const format = cmap.getUint16(subtableOffset)
    if (format !== 4 && format !== 12) continue

    const subtable = new DataView(
      cmap.buffer,
      cmap.byteOffset + subtableOffset,
      cmap.byteLength - subtableOffset
    )
    const covered = format === 4 ? format4Covers(subtable, CODE_POINT) : format12Covers(subtable, CODE_POINT)
    if (covered) return true
  }

  return false
}
