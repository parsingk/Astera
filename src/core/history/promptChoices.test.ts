import { describe, it, expect } from 'vitest'
import { promptChoicesOf, stepToward } from './promptChoices'

// Both fixtures are the quote promptLinesOf produces from a real screen (measured 2026-09-12), which
// is what this reads in production — the input line is already gone by here.
const approval = [
  ' Do you want to create hc-show.txt?',
  ' ❯ 1. Yes',
  '   2. Yes, and switch to accept edits',
  '   3. No',
  '',
  ' Esc to cancel · Tab to amend'
]

const trust = [
  ' Security guide',
  '',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  '',
  ' Enter to confirm · Esc to cancel'
]

describe('promptChoicesOf', () => {
  it('reads a numbered list, with the number a CLI answers to', () => {
    expect(promptChoicesOf(approval)).toEqual([
      { label: 'Yes', number: 1, selected: true },
      { label: 'Yes, and switch to accept edits', number: 2, selected: false },
      { label: 'No', number: 3, selected: false }
    ])
  })

  // Nothing but the column ties these two rows together — no number, no marker on the second.
  it('reads an unnumbered list by where its rows start', () => {
    expect(promptChoicesOf(trust)).toEqual([
      { label: 'No, exit', number: null, selected: true },
      { label: 'Yes, I trust this folder', number: null, selected: false }
    ])
  })

  it('leaves the question and the hint out of the list', () => {
    const labels = promptChoicesOf(approval).map((c) => c.label)
    expect(labels).not.toContain('Do you want to create hc-show.txt?')
    expect(labels.some((l) => l.includes('Esc to cancel'))).toBe(false)
  })

  // A prompt with nothing marked is not a list of choices, and drawing buttons for one would be
  // inventing them.
  it('answers nothing when the CLI is pointing at nothing', () => {
    expect(promptChoicesOf([' Press any key to continue'])).toEqual([])
    expect(promptChoicesOf([])).toEqual([])
  })
})

describe('stepToward', () => {
  const rows = promptChoicesOf(trust)

  it('asks for the key that moves the highlight one row toward the answer', () => {
    expect(stepToward(rows, 'Yes, I trust this folder')).toBe('down')
  })

  it('confirms only once the CLI is pointing at the row it was asked for', () => {
    expect(stepToward(rows, 'No, exit')).toBe('enter')
  })

  it('moves back up when the highlight has gone past', () => {
    const past = [
      { label: 'a', number: null, selected: false },
      { label: 'b', number: null, selected: true }
    ]
    expect(stepToward(past, 'a')).toBe('up')
  })

  // The case the whole one-key-at-a-time shape exists for: the screen moved, so there is nothing to
  // press. A planned sequence would have pressed return here.
  it('presses nothing when the row is gone or nothing is marked', () => {
    expect(stepToward(rows, 'Yes, and switch to accept edits')).toBeNull()
    expect(stepToward([{ label: 'a', number: null, selected: false }], 'a')).toBeNull()
  })
})
