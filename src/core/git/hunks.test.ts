import { describe, it, expect } from 'vitest'
import { hunkAt, parseHunks } from './hunks'

// Phase 3 Part 4: a review finding is anchored to the hunk holding its line, by a fingerprint of the hunk's content
const HEADER = 'diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n'
const FIRST = '@@ -1,3 +1,4 @@\n import x from "x"\n+const a = 1\n const b = 2\n const c = 3\n'
const SECOND = '@@ -10,2 +11,3 @@ function f() {\n   return 1\n+  // more\n }\n'
const TWO_HUNKS = HEADER + FIRST + SECOND

describe('parseHunks', () => {
  it('parses each hunk with its new-side range and a fingerprint over its content lines', () => {
    const h = parseHunks(TWO_HUNKS)
    expect(h.map((x) => [x.oldStart, x.newStart, x.newEnd])).toEqual([
      [1, 1, 4],
      [10, 11, 13]
    ])
    expect(h[0].header).toBe('@@ -1,3 +1,4 @@')
    expect(h[0].fingerprint).toMatch(/^[0-9a-f]{8}$/)
    expect(h[0].fingerprint).not.toBe(h[1].fingerprint)
  })

  it('keeps a hunk’s fingerprint when only its header moves, and changes it when a content line changes', () => {
    const original = parseHunks(HEADER + SECOND)[0]
    const shifted = parseHunks(HEADER + SECOND.replace('@@ -10,2 +11,3 @@', '@@ -14,2 +17,3 @@'))[0]
    const edited = parseHunks(HEADER + SECOND.replace('+  // more', '+  // other'))[0]
    expect(shifted.newStart).toBe(17)
    expect(shifted.fingerprint).toBe(original.fingerprint)
    expect(edited.fingerprint).not.toBe(original.fingerprint)
  })

  it('finds the hunk holding a new-side line, and none outside every hunk', () => {
    const h = parseHunks(TWO_HUNKS)
    expect(hunkAt(h, 12)?.newStart).toBe(11)
    expect(hunkAt(h, 1)?.newStart).toBe(1)
    expect(hunkAt(h, 4)?.newStart).toBe(1)
    expect(hunkAt(h, 7)).toBeNull()
    expect(hunkAt(h, 14)).toBeNull()
  })

  it('ignores the no-newline marker and CR line ends', () => {
    const lf = HEADER + '@@ -1 +1 @@\n-old\n+new\n'
    const crlf = HEADER + '@@ -1 +1 @@\r\n-old\r\n\\ No newline at end of file\r\n+new\r\n\\ No newline at end of file\r\n'
    expect(parseHunks(crlf)[0].fingerprint).toBe(parseHunks(lf)[0].fingerprint)
    expect(parseHunks(crlf)[0].newEnd).toBe(1)
  })

  it('gives a deletion-only hunk no new-side line', () => {
    const [h] = parseHunks('@@ -3,2 +2,0 @@\n-a\n-b\n')
    expect(h.newStart).toBe(2)
    expect(h.newEnd).toBe(1)
    expect(hunkAt([h], 2)).toBeNull()
  })

  it('reads a count left out as one, and stops a hunk at its counted lines', () => {
    const h = parseHunks(HEADER + '@@ -5 +5 @@\n-x\n+y\ntrailing text that is not part of the hunk\n')
    expect(h).toHaveLength(1)
    expect([h[0].newStart, h[0].newEnd]).toEqual([5, 5])
    expect(h[0].fingerprint).toBe(parseHunks(HEADER + '@@ -5 +5 @@\n-x\n+y\n')[0].fingerprint)
  })
})
