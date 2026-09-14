/** What a CLI puts in front of a message, both the one being typed and one waiting its turn. */
const MARKER = '\u276f' // ❯

/** What a TUI draws its composer's box out of. Same judgement as promptLines.ts's. */
const BORDER = /^[\u2500-\u257f\-=_ ]+$/

function isBorder(line: string): boolean {
  const t = line.trim()
  return t !== '' && BORDER.test(t)
}

/**
 * The messages sent while the CLI was busy and not yet started, out of what its terminal is showing.
 *
 * Claude Code keeps this queue itself: type while it is working, press Enter, and the message sits
 * above the composer until the turn ends (measured 2026-09-12 — `  ❯ QB` over the composer's box,
 * with the composer reading `Press up to edit queued messages`). The app does not queue anything of
 * its own, and must not: there would then be two queues, and only the CLI's could be edited with the
 * up arrow.
 *
 * Found by indent, not by that phrase. A queued line is a marker line **inside** the transcript
 * column, indented, sitting directly above the composer's box; a turn that already ran starts at the
 * margin (`❯ QA`, measured on the same screen). Reading the structure rather than the wording means
 * this does not quietly stop working the day the CLI rephrases its placeholder — which is the exact
 * failure core/hooks/notification.ts carries a long comment about.
 *
 * Empty when nothing is queued, and empty for codex: its composer is not boxed, so the anchor this
 * starts from is not there. Whether codex queues at all is unmeasured.
 */
export function queuedMessagesOf(rows: readonly string[]): string[] {
  const lines = rows.map((r) => r.replace(/\s+$/, ''))

  // The composer's box, from the bottom: a marker line with a border directly above it.
  let box = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trimStart().startsWith(MARKER)) continue
    let above = i - 1
    while (above >= 0 && lines[above].trim() === '') above--
    if (above >= 0 && isBorder(lines[above])) {
      box = above
      break
    }
  }
  if (box === -1) return []

  const queued: string[] = []
  for (let i = box - 1; i >= 0; i--) {
    if (lines[i].trim() === '') continue // the CLI pads around the box
    const indent = lines[i].length - lines[i].trimStart().length
    if (indent === 0 || !lines[i].trimStart().startsWith(MARKER)) break
    const text = lines[i].trimStart().slice(MARKER.length).trim()
    if (text !== '') queued.unshift(text)
  }
  return queued
}
