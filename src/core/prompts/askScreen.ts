// What Claude Code's AskUserQuestion dialog is showing, read off the terminal screen.
//
// The card is drawn from the hook's data (askUserQuestion.ts), never from here. This module exists for
// the two things only the screen can tell: which stage the dialog is at right now — so the driver
// (renderer askDriver.ts) knows what its next key will land on — and what the CLI's own review lists,
// so the final Enter is pressed only against answers the card actually chose.
//
// Everything recognised here is the CLI's own wording, measured on **Claude Code 2.1.270 (2026-09-15)**
// with the real binary in a pty (docs/superpowers/specs/2026-09-15-ask-user-question-card-measurements/).
// When a string moves, `askStageOf` answers `none`: the card still shows the questions, nothing drives
// the dialog, and the terminal button is what is left. Fail closed, visibly — never a guessed key.
import type { AskForm, Answer } from './askUserQuestion'
import { expectedAnswers } from './askUserQuestion'

export const ASK_STRINGS = {
  measuredOn: 'Claude Code 2.1.270, 2026-09-15',
  /** The free-text row the CLI adds after the options: `4. Type something.` (single) / `5. [ ] Type something` (multi). */
  typeSomething: 'Type something',
  /** The side-chat row the CLI adds last; present on every question screen. */
  chatAboutThis: 'Chat about this',
  /** A multi-select's own Submit row, drawn under the free-text row; Tab from text mode lands on it. */
  submitRow: 'Submit',
  reviewTitle: 'Review your answers',
  submitAnswers: 'Submit answers',
  readyToSubmit: 'Ready to submit',
  /** The tab strip: `←  ☐ Format  ☒ Sections  ✔ Submit  →`. */
  submitTab: '✔ Submit',
  tabAnswered: '☒',
  tabUnanswered: '☐',
  checked: '[✔]'
} as const

/** The highlight marker: `❯`, and `>` as Claude Code's plain fallback (core/history/promptLines.ts). */
const MARKERS = ['❯', '>']

export type AskStage =
  | {
      kind: 'question'
      /** Which of the form's questions is on screen. */
      index: number
      /** First question, nothing answered, highlight on option 1: the dialog as the CLI drew it. The
       *  driver starts only from here (spec §12). */
      pristine: boolean
      /** The free-text row is highlighted — typed characters land in it. */
      textRowFocused: boolean
      /** A multi-select's own Submit row is highlighted — Enter moves on. */
      submitRowFocused: boolean
    }
  | {
      kind: 'review'
      /** question text → the answer the CLI lists for it, both whitespace-collapsed. */
      answers: ReadonlyMap<string, string>
      /** `Submit answers` is the highlighted row. */
      ready: boolean
    }
  | { kind: 'none' }

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** The text after the highlight marker on the last marked, non-empty row — what the CLI is pointing at.
 *  The composer's own `❯ ` has nothing after its marker and is skipped, so on an ordinary screen this is
 *  the person's last message, not the input line. null when no row is marked. */
export function markedRowOf(lines: readonly string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const start = lines[i].trimStart()
    const marker = MARKERS.find((m) => start.startsWith(m))
    if (marker === undefined) continue
    const rest = collapse(start.slice(marker.length))
    if (rest !== '') return rest
  }
  return null
}

function tabStripAt(lines: readonly string[]): number {
  return lines.findIndex(
    (l) => l.includes(ASK_STRINGS.submitTab) && (l.includes(ASK_STRINGS.tabAnswered) || l.includes(ASK_STRINGS.tabUnanswered))
  )
}

/**
 * The stage the dialog is at, or `none` when it is not on screen (or is not this form's).
 *
 * The screen is cut at the tab strip when there is one, so the echoed message above the dialog cannot
 * be mistaken for its question. The question is found by containment in the whitespace-collapsed region,
 * because a narrow terminal wraps it across rows.
 */
export function askStageOf(lines: readonly string[], form: AskForm): AskStage {
  const strip = tabStripAt(lines)
  const region = strip === -1 ? lines : lines.slice(strip)
  const titleAt = region.findIndex((l) => collapse(l) === ASK_STRINGS.reviewTitle)
  if (titleAt !== -1) return reviewOf(region.slice(titleAt + 1))
  const dialogUp = region.some((l) => l.includes(ASK_STRINGS.typeSomething) || l.includes(ASK_STRINGS.chatAboutThis))
  if (!dialogUp) return { kind: 'none' }
  const text = collapse(region.join(' '))
  const index = form.questions.findIndex((q) => text.includes(collapse(q.question)))
  if (index === -1) return { kind: 'none' }
  const marked = markedRowOf(region) ?? ''
  const otherRow = `${form.questions[index].options.length + 1}. `
  const answered =
    (strip !== -1 && lines[strip].includes(ASK_STRINGS.tabAnswered)) || region.some((l) => l.includes(ASK_STRINGS.checked))
  return {
    kind: 'question',
    index,
    pristine: index === 0 && !answered && marked.startsWith('1. '),
    textRowFocused: marked.startsWith(otherRow),
    submitRowFocused: marked === ASK_STRINGS.submitRow
  }
}

/** The review: `● question` rows each followed by a `→ answer` row, either of which may wrap onto the
 *  rows below it. Stops at `Ready to submit` or the first highlighted row. */
function reviewOf(lines: readonly string[]): AskStage {
  const answers = new Map<string, string>()
  let question: string | null = null
  let answer: string | null = null
  let field: 'q' | 'a' | null = null
  const flush = (): void => {
    if (question !== null && answer !== null) answers.set(collapse(question), collapse(answer))
    question = null
    answer = null
    field = null
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith(ASK_STRINGS.readyToSubmit) || MARKERS.some((m) => line.startsWith(m))) break
    if (line.startsWith('⚠')) continue
    if (line.startsWith('●')) {
      flush()
      question = line.slice(1)
      field = 'q'
      continue
    }
    if (line.startsWith('→')) {
      answer = line.slice(1)
      field = 'a'
      continue
    }
    if (field === 'q' && question !== null) question += ' ' + line
    else if (field === 'a' && answer !== null) answer += ' ' + line
  }
  flush()
  const marked = markedRowOf(lines) ?? ''
  return { kind: 'review', answers, ready: marked.endsWith(ASK_STRINGS.submitAnswers) }
}

/**
 * Whether the review lists, for every question, exactly what the card chose.
 *
 * Exact string comparison, not a set: the CLI lists a multiple choice in pick order and the card keeps
 * picks in pick order (askUserQuestion.ts's `Answer`), so the joined strings agree by construction, and
 * a free text containing a comma cannot be mis-split. A review with a question missing does not match.
 */
export function reviewMatches(review: Extract<AskStage, { kind: 'review' }>, form: AskForm, answers: Answer[]): boolean {
  if (review.answers.size !== form.questions.length) return false
  return form.questions.every((q, i) => {
    const got = review.answers.get(collapse(q.question))
    return got !== undefined && got === collapse(expectedAnswers(form, answers, i).join(', '))
  })
}

/** What the card offers, given the stage: `ready` drives from a pristine first question; `waiting` when
 *  the dialog is not on screen (yet, or any more); `terminal` when the dialog has been moved on the
 *  terminal — the questions are shown but the terminal finishes them (spec §6, §12). */
export type AskCardState = 'ready' | 'answering' | 'waiting' | 'terminal'

export function askCardStateOf(stage: AskStage, answering: boolean): AskCardState {
  if (answering) return 'answering'
  if (stage.kind === 'none') return 'waiting'
  if (stage.kind === 'question' && stage.index === 0 && stage.pristine) return 'ready'
  return 'terminal'
}

/**
 * Whether the card's own Submit can be pressed.
 *
 * The button is drawn whether or not this is true. It used to be drawn only when true, and a button
 * that is not there reads as a feature that does not exist rather than one that is blocked — reported
 * as exactly that, against a chat session's card, which always has one because it answers over the
 * protocol and has no terminal screen to drive.
 *
 * Off for the two states that put the card here — the terminal's dialog is not the untouched one the
 * driver starts from, or a drive already ran and gave up — and off while a drive is in flight or the
 * dialog has not appeared yet. `canSubmit` is the form's own completeness, which is the caller's.
 */
export function askSubmitEnabled(
  state: AskCardState,
  notice: string | null,
  canSubmit: boolean
): boolean {
  return state === 'ready' && notice === null && canSubmit
}
