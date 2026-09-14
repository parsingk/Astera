/** The markers a CLI puts at the start of the line a person types on.
 *
 *  Claude Code draws two of them. `❯` is what it uses when it believes the terminal can render it,
 *  and `>` is its plain fallback — measured on a real trust prompt, which came back as `> No, exit`
 *  over `  Yes, I trust this folder`. Nothing downstream could see that screen as a list of choices,
 *  so the conversation view quoted the question and offered nothing to press. Both spellings are the
 *  same mark and are treated as one. */
const CLAUDE_INPUTS = ['❯', '>']
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
 *     box.
 *
 *     Codex is the other way round: it draws no rule around its composer, so the box test cannot
 *     apply to it, but it *does* mark its highlighted choice with `›` — `› 1. Yes, continue` on its
 *     own trust prompt, measured. So the number test is what saves its choices, and the absence of
 *     one is what identifies its input line.
 *   - of what is left, the last `max` lines, with no attempt to find where the question begins.
 *     Cutting at the blank line above it was tried and lost the options, because a dialog has blank
 *     lines inside it. A line or two of the turn above costs a glance; a quote missing `Yes, I trust
 *     this folder` costs the answer.
 *
 * Empty when the screen is empty, which is how a caller learns to draw nothing rather than an empty
 * box.
 */
/** Where the line a person types on is, or -1 when the CLI is not offering one — it is starting up, or
 *  it is holding a dialog that takes a keypress instead. Shared with promptLinesOf, which cuts the
 *  screen there, so the two can never disagree about what the input line is. */
export function inputLineAt(rows: readonly string[]): number {
  const lines = rows.map((r) => r.replace(/\s+$/, ''))
  return scanForInput(lines)
}

/** Whether the CLI is showing a line a person can type on. The conversation view keeps its own composer
 *  shut until this is true for a session that has written nothing yet: an open box over a CLI that is
 *  still starting, or holding a dialog, invites typing that goes nowhere. */
export function hasInputLine(rows: readonly string[]): boolean {
  return inputLineAt(rows) !== -1
}

function scanForInput(lines: readonly string[]): number {
  let input = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const start = lines[i].trimStart()
    const marker = start.startsWith(CODEX_INPUT)
      ? CODEX_INPUT
      : (CLAUDE_INPUTS.find((m) => start.startsWith(m)) ?? null)
    if (marker === null) continue
    if (/^\d+\.\s/.test(start.slice(marker.length).trimStart())) continue // a numbered choice
    if (marker === CODEX_INPUT) {
      input = i
      break
    }
    let above = i - 1
    while (above >= 0 && lines[above].trim() === '') above--
    if (above < 0 || !isBorder(lines[above])) continue // not boxed — the highlighted choice
    input = i
    break
  }
  return input
}

export function promptLinesOf(rows: readonly string[], max: number): string[] {
  const lines = rows.map((r) => r.replace(/\s+$/, ''))
  const input = scanForInput(lines)

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

/** The wording each CLI uses to ask whether this folder is trusted, lowercased. Measured off both
 *  screens rather than guessed: Claude Code opens with "Quick safety check: Is this a project you
 *  created or one you trust?" and offers "Yes, I trust this folder"; codex asks "Do you trust the
 *  contents of this directory?". Any one of them is enough. */
const TRUST_PHRASES = ['do you trust', 'i trust this folder', 'quick safety check']

/** Whether the quoted prompt is the folder-trust question either CLI asks the first time an account
 *  opens a folder.
 *
 *  Only ever picks which heading the banner draws, so a miss costs a wording rather than a
 *  behaviour — the generic heading is the fallback and the choices are unaffected. That is why
 *  matching on the CLIs' own words is acceptable here and would not be for anything that decides what
 *  a keypress does. */
export function isFolderTrustPrompt(lines: readonly string[]): boolean {
  const text = lines.join(' ').toLowerCase()
  return TRUST_PHRASES.some((phrase) => text.includes(phrase))
}
