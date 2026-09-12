/** The marker a CLI puts in front of the choice it is currently pointing at. The same characters an
 *  input line starts with — which is why promptLinesOf has already taken the input line away by the
 *  time these lines get here, and why nothing below tries to tell the two apart again. */
const MARKERS = ['❯', '›'] // ❯ (claude), › (codex)

/** A numbered row: `1. Yes`. The number is what a CLI takes as an answer on its own, so a choice that
 *  has one needs no walking to reach. */
const NUMBERED = /^(\d+)\.\s+(.*)$/

export interface PromptChoice {
  /** The row's text with its marker and number removed — what a person reads and what identifies the
   *  row from one screen to the next. */
  label: string
  /** The digit a CLI accepts for this row, or null when the rows are unnumbered and the only way to
   *  reach one is to move the highlight onto it. */
  number: number | null
  /** Whether the CLI is pointing at this row right now. */
  selected: boolean
}

/**
 * The rows a CLI is offering, out of the prompt promptLinesOf quoted.
 *
 * Found by alignment, not by pattern: the marked row fixes a column where the text of a choice
 * begins, and its siblings are the rows whose own text begins in that same column. It is what makes
 * both measured shapes come out right without either being special-cased — Claude's numbered approval
 * (`❯ 1. Yes` over `  2. …`) and its unnumbered trust prompt (`❯ No, exit` over `  Yes, I trust this
 * folder`), whose rows carry nothing in common but where they start.
 *
 * The run stops at the first blank or misaligned line in each direction, which is what keeps the
 * question above the list out of it — a question starts at the margin, a choice does not.
 *
 * Empty when nothing is marked. A CLI marks a row whenever it is offering any, so nothing marked
 * means this is not a list, and drawing buttons for it would be inventing them.
 */
export function promptChoicesOf(lines: readonly string[]): PromptChoice[] {
  let markedAt = -1
  let bodyColumn = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const indent = lines[i].length - lines[i].trimStart().length
    const marker = MARKERS.find((m) => lines[i].startsWith(m, indent))
    if (marker === undefined) continue
    const rest = lines[i].slice(indent + marker.length)
    const gap = rest.length - rest.trimStart().length
    if (rest.trim() === '') continue // a marker with no row after it is not a choice
    markedAt = i
    bodyColumn = indent + marker.length + gap
    break
  }
  if (markedAt === -1) return []

  const rows: number[] = [markedAt]
  for (let i = markedAt - 1; i >= 0 && alignsAt(lines[i], bodyColumn); i--) rows.unshift(i)
  for (let i = markedAt + 1; i < lines.length && alignsAt(lines[i], bodyColumn); i++) rows.push(i)

  return rows.map((i) => {
    const body = lines[i].slice(bodyColumn).trim()
    const numbered = NUMBERED.exec(body)
    return {
      label: numbered ? numbered[2].trim() : body,
      number: numbered ? Number(numbered[1]) : null,
      selected: i === markedAt
    }
  })
}

/** Whether an unmarked line is a sibling of the marked one: text, starting in the very column the
 *  marked row's text starts in. A blank line ends the run, and so does a line that starts anywhere
 *  else — including the question above the list, which starts at the margin. */
function alignsAt(line: string, column: number): boolean {
  if (line.trim() === '') return false
  return line.length - line.trimStart().length === column
}

/**
 * The one key to send next to get from what the CLI is pointing at now to `label` — re-derived from
 * the screen before every single key, never planned ahead.
 *
 * That is the whole point of the shape. A plan ("two downs, then return") is made against a screen
 * that has already moved on by the time the second key lands, and the key it is wrong about is the
 * return: the wrong choice confirmed, with no way back. Asking again after each step costs a read and
 * makes the mistake impossible.
 *
 * `null` means stop and press nothing: the row is gone, or nothing is marked any more. A prompt that
 * changed under the answer is not one to guess at.
 */
export function stepToward(
  choices: readonly PromptChoice[],
  label: string
): 'up' | 'down' | 'enter' | null {
  const target = choices.findIndex((c) => c.label === label)
  const selected = choices.findIndex((c) => c.selected)
  if (target === -1 || selected === -1) return null
  if (target === selected) return 'enter'
  return target > selected ? 'down' : 'up'
}
