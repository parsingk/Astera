/** Which question codex's `/model` is asking right now, out of what its terminal is showing.
 *
 *  One command, two screens: it names itself "Select Model and Effort" while it lists models, then
 *  "Select Reasoning Level for <model>" once one is chosen (both measured 2026-09-12). Reading the
 *  heading is what lets a caller drive the second screen without counting keystrokes — a count is a
 *  guess about a screen it cannot see, and the key it would guess wrong about is the one that
 *  confirms.
 *
 *  null means neither screen is up: the picker has not opened yet, or it has closed.
 */
export function codexPickerStep(rows: readonly string[]): 'model' | 'effort' | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const line = rows[i].trim()
    if (line.startsWith('Select Reasoning Level')) return 'effort'
    if (line.startsWith('Select Model')) return 'model'
  }
  return null
}

/** One row of a codex picker: the digit that takes it, and the name it shows. */
export interface CodexPickerRow {
  digit: string
  label: string
}

/** The rows of whichever codex picker is on screen, in its own order.
 *
 *  `  3. High                  Greater reasoning depth for complex problems` — the digit selects the
 *  row and confirms in the same keystroke (measured), the name runs to the gap before its
 *  description, and a `(current)` or `(default)` note rides along with the name. The marker in front
 *  of the highlighted row is ignored: which row is highlighted says nothing about which row was
 *  asked for.
 */
export function codexPickerRows(rows: readonly string[]): CodexPickerRow[] {
  const found: CodexPickerRow[] = []
  for (const row of rows) {
    const match = /^[^\w]*(\d)\.\s+(.+)$/.exec(row.trimEnd())
    if (match === null) continue
    const rest = match[2]
    // Two or more spaces start the description column; one space is still part of the name.
    const label = rest.split(/\s{2,}/)[0].trim()
    if (label !== '') found.push({ digit: match[1], label })
  }
  return found
}

/**
 * The digit that takes the row called `label` on the screen as it is right now, or null when no row
 * is called that.
 *
 * The name is matched, not the position. codex's own list is the authority on what sits at which
 * number, so a list this app keeps that has gone stale cannot make it press the wrong one — it
 * presses nothing, and the question stays on screen for a person to answer.
 *
 * `(current)` and `(default)` are notes codex adds to a row, not part of its name, so they are
 * ignored when comparing.
 */
export function codexDigitFor(rows: readonly string[], label: string): string | null {
  const wanted = label.trim().toLowerCase()
  for (const row of codexPickerRows(rows)) {
    const name = row.label.replace(/\s*\((?:current|default)\)\s*$/i, '').trim().toLowerCase()
    if (name === wanted) return row.digit
  }
  return null
}

/**
 * The model and reasoning level codex is running, off the status line it keeps at the bottom of its
 * own screen (`  gpt-5.6-sol xhigh · D:\novel_docs`, measured 2026-09-12).
 *
 * Read from the screen because it is the only place this is true continuously. codex's rollout — the
 * app's other source — records the model a turn at a time, so a session that has not answered
 * anything reports none at all, and one whose model was just changed goes on reporting the old one
 * until the next turn. Neither is what a person who just changed it is looking at.
 *
 * Only the last line is considered, which is where that bar sits; a `·` elsewhere on the screen is
 * some other line's punctuation. null when the bar is not there — a picker is up over it, the session
 * is still starting — and the caller then keeps whatever it had.
 */
export function codexStatusModel(
  rows: readonly string[]
): { model: string; effort: string } | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const line = rows[i].trim()
    if (line === '') continue
    const match = /^(\S+)\s+(\S+)\s+·\s+\S/.exec(line)
    return match === null ? null : { model: match[1], effort: match[2] }
  }
  return null
}
