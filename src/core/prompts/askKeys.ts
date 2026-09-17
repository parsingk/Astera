// The keys that answer one question of Claude Code's AskUserQuestion dialog, from the measured table in
// the design's §4 (Claude Code 2.1.270, 2026-09-15):
//
//   - a digit picks (single) or toggles (multi) that option; the highlight does not move;
//   - on a single-select a pick advances the dialog by itself, so nothing follows the digit;
//   - the free-text row is `options.length + 1`. On a single-select its digit highlights it and enters
//     text mode; typed characters land in it; Enter accepts and advances. On a multi-select the digit
//     only checks the row and typed text goes nowhere — the row has to be *highlighted*, which from the
//     pristine first row is one Down per option; typing then fills and checks it;
//   - a multi-select is left with Tab. From text mode, Tab lands on the question's own Submit row rather
//     than the next screen, and the driver (renderer askDriver.ts) presses Enter there when it sees it.
//
// This module only lists keys; it never sends one. The driver reads the screen between steps.
import type { AskQuestion, Answer } from './askUserQuestion'

export const DOWN = '\u001b[B'
export const TAB = '\t'
export const ENTER = '\r'

/** What moves the dialog off this question once its keys are typed. */
export type Advance = 'auto' | 'enter' | 'tab'

/** The number of the CLI's own free-text row: one past the last option. */
export function otherRowNumber(q: AskQuestion): number {
  return q.options.length + 1
}

/** The keys typed while this question's screen is up, before the advance. Digits are one key each; the
 *  free text is one entry (written as one string). Empty when nothing was answered. */
export function keysForQuestion(q: AskQuestion, a: Answer): string[] {
  const other = a.other.trim()
  if (!q.multiSelect) {
    if (other !== '') return [String(otherRowNumber(q)), other]
    return a.picks.length > 0 ? [String(a.picks[0] + 1)] : []
  }
  const keys = a.picks.map((i) => String(i + 1))
  if (other !== '') {
    for (let i = 0; i < q.options.length; i++) keys.push(DOWN)
    keys.push(other)
  }
  return keys
}

export function advanceFor(q: AskQuestion, a: Answer): Advance {
  if (!q.multiSelect) return a.other.trim() !== '' ? 'enter' : 'auto'
  return 'tab'
}
