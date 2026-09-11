/** The marker a CLI puts at the start of the line a person types on. */
const CLAUDE_INPUT = '❯' // ❯ — claude, and also its highlighted choice
const CODEX_INPUT = '›' // › — codex

/** What a TUI draws a box or a rule out of. A line of nothing but these is a border, not content. */
const BORDER_CHARS = /^[─-╿╴-╿\-=_ ]+$/

function isBorder(line: string): boolean {
  const t = line.trim()
  return t !== '' && BORDER_CHARS.test(t)
}

/**
 * The question a CLI is waiting on, out of what its terminal is showing.
 *
 * The app has no other copy of it. A prompt is drawn by the CLI itself and never written to the
 * transcript — Claude Code flushes nothing while it waits for a person — so the screen is the only
 * place the choices exist. What comes back is therefore the CLI's own text, unchanged: no second,
 * drawn copy of its options that could disagree with the real screen.
 *
 * Two rules, and the second is deliberately dumb:
 *
 *   - everything from the input line down goes. That is the composer and the status bar, which say
 *     nothing about the question. **What makes a line the input line is its box, not its text**: a
 *     composer sits under a horizontal rule, and a choice never does. This matters because the
 *     highlighted choice carries the very same `❯` — and, measured on a real trust prompt, carries no
 *     number either (`❯ No, exit`), so no amount of reading the text after the marker tells the two
 *     apart. A numbered choice is let through as well, as a second guard for a dialog drawn inside a
 *     box. Codex needs neither test: it draws no rule around its composer, and its choices are
 *     numbered rows that do not carry `›` at all, so its last marker line is always the input.
 *   - of what is left, the last `max` lines, with no attempt to find where the question begins.
 *     Cutting at the blank line above it was tried and lost the options, because a dialog has blank
 *     lines inside it. A line or two of the turn above costs a glance; a quote missing `Yes, I trust
 *     this folder` costs the answer.
 *
 * Empty when the screen is empty, which is how a caller learns to draw nothing rather than an empty
 * box.
 */
export function promptLinesOf(rows: readonly string[], max: number): string[] {
  const lines = rows.map((r) => r.replace(/\s+$/, ''))

  let input = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const start = lines[i].trimStart()
    if (start.startsWith(CODEX_INPUT)) {
      input = i
      break
    }
    if (!start.startsWith(CLAUDE_INPUT)) continue
    if (/^\d+\.\s/.test(start.slice(CLAUDE_INPUT.length).trimStart())) continue // a numbered choice
    let above = i - 1
    while (above >= 0 && lines[above].trim() === '') above--
    if (above < 0 || !isBorder(lines[above])) continue // not boxed — the highlighted choice
    input = i
    break
  }

  const above = input === -1 ? lines : lines.slice(0, input)
  // Trailing blanks go, and so does the rule that was the top of the composer's box — cutting the
  // composer out leaves it dangling over nothing.
  let end = above.length
  while (end > 0 && (above[end - 1].trim() === '' || isBorder(above[end - 1]))) end--
  // Runs of blank lines collapse to one: a TUI pads generously and a quote of mostly nothing reads as
  // broken.
  const body = above
    .slice(0, end)
    .filter((l, i, all) => l.trim() !== '' || (i > 0 && all[i - 1].trim() !== ''))
  return body.slice(Math.max(0, body.length - max))
}
