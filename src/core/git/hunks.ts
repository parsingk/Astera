// A unified diff's hunks (Phase 3 Part 4): where each covers on the new side and a fingerprint of what it says, so a
// review finding can be anchored to the hunk holding its line and found again in a later diff of the same revision. The
// Host records the fingerprint when a review ends (host/findingAnchors.ts); `runs-diff` compares it with the diff it
// answers (core/review/diffFindings.ts). Pure, so both sides use the same rule.
import { contentRevision } from '../context/contextRef'

export interface DiffHunk {
  /** The `@@ -a,b +c,d @@` part of the hunk's header, without the function context git may add after it. */
  header: string
  oldStart: number
  newStart: number
  /** Last new-side line the hunk covers, inclusive; newStart - 1 when it covers none (a deletion-only hunk). */
  newEnd: number
  /** contentRevision of the hunk's content lines (prefix kept, CR dropped, the "\ No newline" marker left out), joined
   *  by "\n". The header is not part of it, so a hunk moved by edits above it keeps its fingerprint. */
  fingerprint: string
  /** All the lines its header counts are there; false for a hunk cut short (a diff truncated at its byte bound), whose
   *  fingerprint names no real hunk and whose later lines the diff does not show (final review M1). */
  complete: boolean
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** One file's unified diff, as readFileDiff answers it, into its hunks in order. Lines before the first header (the
 *  `diff --git`, `index`, `---` and `+++` lines) and past a hunk's counted lines are skipped; a hunk cut short (a diff
 *  truncated at its byte bound) keeps the lines it has, so its fingerprint matches no full hunk. */
export function parseHunks(diff: string): DiffHunk[] {
  const lines = diff.split('\n').map((l) => l.replace(/\r$/, ''))
  const out: DiffHunk[] = []
  let i = 0
  while (i < lines.length) {
    const m = HEADER.exec(lines[i])
    if (!m) {
      i++
      continue
    }
    const oldStart = Number(m[1])
    const newStart = Number(m[3])
    const newCount = m[4] === undefined ? 1 : Number(m[4])
    let oldLeft = m[2] === undefined ? 1 : Number(m[2])
    let newLeft = newCount
    const content: string[] = []
    i++
    while (i < lines.length && (oldLeft > 0 || newLeft > 0)) {
      const l = lines[i]
      if (l.startsWith('\\')) {
        i++
        continue
      }
      // The empty string after the diff's last line end is the end of the text, not a context line
      if (l === '' && i === lines.length - 1) break
      const c = l[0]
      if (c === '+') newLeft--
      else if (c === '-') oldLeft--
      else if (c === ' ' || l === '') {
        oldLeft--
        newLeft--
      } else break
      content.push(l)
      i++
    }
    out.push({ header: m[0], oldStart, newStart, newEnd: newStart + newCount - 1, fingerprint: contentRevision(content.join('\n')), complete: oldLeft <= 0 && newLeft <= 0 })
  }
  return out
}

/** The hunk covering a new-side line (1-based), or null when no hunk does. */
export function hunkAt(hunks: readonly DiffHunk[], line: number): DiffHunk | null {
  return hunks.find((h) => h.newStart <= line && line <= h.newEnd) ?? null
}
