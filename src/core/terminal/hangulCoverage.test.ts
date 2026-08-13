import { describe, expect, it } from 'vitest'
import { fontCoversHangul, type ByteReader } from './hangulCoverage'

const CP = 0xac00

/** Builds a minimal sfnt wrapper: a table directory with one 'cmap' entry pointing at `cmapBytes`,
 *  placed right after the directory. Good enough for this probe, which only reads the directory
 *  and the cmap table — it never looks at any other table's contents. */
/** `fileBase` is where this sfnt directory will ultimately sit in the whole file — 0 for a
 *  standalone font, or the wrapping ttcf's per-font offset for a collection member. Table offsets
 *  in an sfnt directory are absolute from the start of the file, not relative to the directory. */
function buildFont(cmapBytes: Uint8Array, fileBase = 0): Uint8Array {
  const numTables = 1
  const dirHeaderLen = 12
  const recordLen = 16
  const cmapOffset = dirHeaderLen + recordLen
  const total = cmapOffset + cmapBytes.length
  const buf = new Uint8Array(total)
  const view = new DataView(buf.buffer)

  view.setUint32(0, 0x00010000) // sfnt version, arbitrary but not 'ttcf'
  view.setUint16(4, numTables)

  const recordAt = dirHeaderLen
  view.setUint32(recordAt, 0x63_6d_61_70) // 'cmap'
  view.setUint32(recordAt + 4, 0) // checksum, unused
  view.setUint32(recordAt + 8, fileBase + cmapOffset)
  view.setUint32(recordAt + 12, cmapBytes.length)

  buf.set(cmapBytes, cmapOffset)
  return buf
}

interface CmapSubtable {
  platformId: number
  encodingId: number
  bytes: Uint8Array
}

/** Builds a cmap table with one platform-3/encoding-1 (Windows BMP) subtable in the given format,
 *  wrapping the format-specific bytes produced by the caller. Convenience wrapper over
 *  buildCmapMulti for the common single-subtable case. */
function buildCmap(formatBytes: Uint8Array): Uint8Array {
  return buildCmapMulti([{ platformId: 3, encodingId: 1, bytes: formatBytes }])
}

/** Builds a cmap table with one or more subtable records, each pointing at its own bytes placed
 *  back to back after the subtable directory. */
function buildCmapMulti(subtables: CmapSubtable[]): Uint8Array {
  const headerLen = 4
  const recordLen = 8
  const dirLen = subtables.length * recordLen
  let offset = headerLen + dirLen
  const offsets = subtables.map((s) => {
    const at = offset
    offset += s.bytes.length
    return at
  })
  const buf = new Uint8Array(offset)
  const view = new DataView(buf.buffer)

  view.setUint16(0, 0) // version
  view.setUint16(2, subtables.length) // numTables (subtables)
  subtables.forEach((s, i) => {
    const recordAt = headerLen + i * recordLen
    view.setUint16(recordAt, s.platformId)
    view.setUint16(recordAt + 2, s.encodingId)
    view.setUint32(recordAt + 4, offsets[i])
    buf.set(s.bytes, offsets[i])
  })
  return buf
}

/** A format 4 subtable with a single test segment [start, end], terminated by the required
 *  0xFFFF cap segment (format 4 always ends with one, and readers may assume segCount >= 1 covers
 *  it — here we include it explicitly for realism, plus our test segment).
 *
 *  By default the test segment uses idDelta=0 / idRangeOffset=0, i.e. glyphId = codePoint, which
 *  is never 0 for the code points these tests use — a straightforward "covered" segment. Passing
 *  `glyphIdArray` instead switches the segment to idRangeOffset-relative lookup (the indirect form
 *  format 4 actually uses in real fonts for non-contiguous glyph ids), so a segment whose range
 *  contains the test code point can still resolve to glyph 0 (".notdef", i.e. not actually
 *  covered) — this is what pins finding 4 (range membership is not proof of a glyph). */
function buildFormat4(
  start: number,
  end: number,
  opts?: { glyphIdArray: number[] }
): Uint8Array {
  const segCount = 2 // our segment + the trailing 0xFFFF sentinel segment
  const segCountX2 = segCount * 2
  // layout: format(2) length(2) language(2) segCountX2(2) searchRange(2) entrySelector(2) rangeShift(2)
  //         endCode[segCount](2 each) reservedPad(2) startCode[segCount](2 each)
  //         idDelta[segCount](2 each) idRangeOffset[segCount](2 each) glyphIdArray[](2 each)
  const headerLen = 14
  const endCodeAt = headerLen
  const padAt = endCodeAt + segCountX2
  const startCodeAt = padAt + 2
  const idDeltaAt = startCodeAt + segCountX2
  const idRangeOffsetAt = idDeltaAt + segCountX2
  const glyphIdArrayAt = idRangeOffsetAt + segCountX2
  const glyphIdArray = opts?.glyphIdArray ?? []
  const total = glyphIdArrayAt + glyphIdArray.length * 2
  const buf = new Uint8Array(total)
  const view = new DataView(buf.buffer)

  view.setUint16(0, 4) // format
  view.setUint16(2, total) // length
  view.setUint16(6, segCountX2)

  // segment 0: our test range
  view.setUint16(endCodeAt, end)
  view.setUint16(startCodeAt, start)
  if (glyphIdArray.length > 0) {
    // idRangeOffset is relative to its own storage location — see the spec note in the source.
    view.setUint16(idDeltaAt, 0)
    view.setUint16(idRangeOffsetAt, glyphIdArrayAt - idRangeOffsetAt)
    glyphIdArray.forEach((g, i) => view.setUint16(glyphIdArrayAt + i * 2, g))
  } else {
    view.setUint16(idDeltaAt, 0)
    view.setUint16(idRangeOffsetAt, 0)
  }

  // segment 1: the mandatory trailing sentinel
  view.setUint16(endCodeAt + 2, 0xffff)
  view.setUint16(startCodeAt + 2, 0xffff)
  view.setUint16(idDeltaAt + 2, 1)
  view.setUint16(idRangeOffsetAt + 2, 0)

  return buf
}

function buildFormat12(groups: Array<[number, number, number]>): Uint8Array {
  const headerLen = 16
  const groupLen = 12
  const total = headerLen + groups.length * groupLen
  const buf = new Uint8Array(total)
  const view = new DataView(buf.buffer)

  view.setUint16(0, 12) // format
  view.setUint32(4, total) // length
  view.setUint32(12, groups.length) // nGroups

  groups.forEach(([start, end, glyph], i) => {
    const at = headerLen + i * groupLen
    view.setUint32(at, start)
    view.setUint32(at + 4, end)
    view.setUint32(at + 8, glyph)
  })

  return buf
}

/** A ByteReader over an in-memory buffer, mirroring how Blob#slice().arrayBuffer() behaves. */
function readerFor(bytes: Uint8Array): ByteReader {
  return async (start, end) => {
    const clampedEnd = Math.min(end, bytes.length)
    const slice = bytes.slice(Math.max(0, start), Math.max(0, clampedEnd))
    return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength)
  }
}

describe('fontCoversHangul', () => {
  it('finds U+AC00 in a format 4 subtable that covers it', async () => {
    const cmap = buildCmap(buildFormat4(CP - 10, CP + 10))
    const font = buildFont(cmap)
    await expect(fontCoversHangul(readerFor(font))).resolves.toBe(true)
  })

  it('returns false for a format 4 subtable that does not cover it', async () => {
    const cmap = buildCmap(buildFormat4(0x0041, 0x005a)) // A-Z only
    const font = buildFont(cmap)
    await expect(fontCoversHangul(readerFor(font))).resolves.toBe(false)
  })

  it('finds U+AC00 in a format 12 subtable that covers it', async () => {
    const cmap = buildCmap(buildFormat12([[CP - 5, CP + 5, 100]]))
    const font = buildFont(cmap)
    await expect(fontCoversHangul(readerFor(font))).resolves.toBe(true)
  })

  it('returns false when the font has no cmap table', async () => {
    // A table directory with zero entries: no cmap record for the probe to find.
    const buf = new Uint8Array(12)
    const view = new DataView(buf.buffer)
    view.setUint32(0, 0x00010000)
    view.setUint16(4, 0) // numTables = 0
    await expect(fontCoversHangul(readerFor(buf))).resolves.toBe(false)
  })

  it('reads through a ttcf collection to the first sfnt directory', async () => {
    // ttcf header: tag(4) version(4) numFonts(4) then offsetTable[numFonts](4 each)
    const innerOffset = 12 + 4
    const cmap = buildCmap(buildFormat4(CP - 10, CP + 10))
    const inner = buildFont(cmap, innerOffset)

    const buf = new Uint8Array(innerOffset + inner.length)
    const view = new DataView(buf.buffer)
    view.setUint32(0, 0x74746366) // 'ttcf'
    view.setUint32(4, 0x00010000)
    view.setUint32(8, 1) // numFonts
    view.setUint32(12, innerOffset)
    buf.set(inner, innerOffset)

    await expect(fontCoversHangul(readerFor(buf))).resolves.toBe(true)
  })

  it('treats an absurd table-directory count as no coverage instead of reading huge ranges', async () => {
    const buf = new Uint8Array(12)
    const view = new DataView(buf.buffer)
    view.setUint32(0, 0x00010000)
    view.setUint16(4, 0xffff) // a numTables value far beyond MAX_ENTRIES
    await expect(fontCoversHangul(readerFor(buf))).resolves.toBe(false)
  })

  // Pins the reservedPad word between endCode[] and startCode[]: with the test's [start, end] used
  // for both fields the way the earlier tests above do, a parser that forgot the pad word would
  // still happen to answer correctly (a shifted read lands on 0xFFFF/0xFFFF-ish data that also
  // contains AC00). Using a range nowhere near AC00 removes that accidental cover.
  it('does not cover AC00 through a segment whose range sits nowhere near it', async () => {
    const cmap = buildCmap(buildFormat4(0x0041, 0x0100))
    const font = buildFont(cmap)
    await expect(fontCoversHangul(readerFor(font))).resolves.toBe(false)
  })

  it('ignores a platform 3 / encoding 0 (symbol) subtable', async () => {
    const cmap = buildCmapMulti([
      { platformId: 3, encodingId: 0, bytes: buildFormat4(CP - 10, CP + 10) }
    ])
    const font = buildFont(cmap)
    await expect(fontCoversHangul(readerFor(font))).resolves.toBe(false)
  })

  it('accepts a platform 0 (Unicode) subtable', async () => {
    const cmap = buildCmapMulti([
      { platformId: 0, encodingId: 4, bytes: buildFormat4(CP - 10, CP + 10) }
    ])
    const font = buildFont(cmap)
    await expect(fontCoversHangul(readerFor(font))).resolves.toBe(true)
  })

  it('returns false for a format 12 subtable that does not cover it', async () => {
    const cmap = buildCmap(buildFormat12([[0x0041, 0x005a, 100]]))
    const font = buildFont(cmap)
    await expect(fontCoversHangul(readerFor(font))).resolves.toBe(false)
  })

  it('treats an absurd cmap table length as no coverage instead of reading megabytes', async () => {
    const numTables = 1
    const dirHeaderLen = 12
    const recordLen = 16
    const cmapOffset = dirHeaderLen + recordLen
    const buf = new Uint8Array(cmapOffset)
    const view = new DataView(buf.buffer)
    view.setUint32(0, 0x00010000)
    view.setUint16(4, numTables)
    const recordAt = dirHeaderLen
    view.setUint32(recordAt, 0x63_6d_61_70) // 'cmap'
    view.setUint32(recordAt + 8, cmapOffset)
    view.setUint32(recordAt + 12, 8 * 1024 * 1024 + 1) // one byte past MAX_CMAP_LENGTH
    await expect(fontCoversHangul(readerFor(buf))).resolves.toBe(false)
  })

  // Pins finding 4: a segment's [start, end] range containing AC00 is not proof of a glyph. This
  // subtable uses the indirect (idRangeOffset-relative) glyph lookup and points AC00's slot at a
  // glyphIdArray entry of 0 — glyph 0 is ".notdef", i.e. this font has a hole at exactly AC00
  // despite the range covering it.
  it('does not count a format 4 segment whose glyphIdArray entry for AC00 is 0 (.notdef)', async () => {
    // Two glyph slots for a 2-code-point range [AC00, AC01]; AC00's slot (index 0) is 0.
    const cmap = buildCmap(buildFormat4(CP, CP + 1, { glyphIdArray: [0, 55] }))
    const font = buildFont(cmap)
    await expect(fontCoversHangul(readerFor(font))).resolves.toBe(false)
  })
})
