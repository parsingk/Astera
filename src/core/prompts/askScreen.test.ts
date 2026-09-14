import { describe, it, expect } from 'vitest'
import { askStageOf, markedRowOf, reviewMatches, askCardStateOf, type AskStage } from './askScreen'
import { parseAskUserQuestion, emptyAnswers, togglePick, setOther, type AskForm } from './askUserQuestion'

const form = parseAskUserQuestion({
  questions: [
    {
      header: 'Format',
      question: 'How should I format the output?',
      multiSelect: false,
      options: [
        { label: 'Summary', description: 'Brief overview of key points' },
        { label: 'Detailed', description: 'Full explanation with examples' },
        { label: 'Bullet list', description: 'Short bullets, one per finding' }
      ]
    },
    {
      header: 'Sections',
      question: 'Which sections should I include?',
      multiSelect: true,
      options: [
        { label: 'Introduction', description: 'Opening context' },
        { label: 'Methods', description: 'How the work was done' },
        { label: 'Results', description: 'What came out' },
        { label: 'Conclusion', description: 'Final summary' }
      ]
    }
  ]
}) as AskForm

// What sits above the dialog on a live screen: the banner and the echoed message. Kept in the fixtures
// so the reader is proven to find the dialog under it, as it must in the app.
const ABOVE = [
  ' ▐▛███▛█   Claude Code v2.1.270',
  '▝▜██████▀  Fable 5.1 with xhigh effort · Claude Team',
  '  ▝▝ ▝▝    D:\\parsingk\\astera',
  '',
  '❯ Please ask me about the format and the sections.',
  '──────────────────────────────────────────────────────────────────────────────────────────────────────────────'
]
const HINT = 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel'
const HINT_TEXT = 'Enter to select · Tab/Arrow keys to navigate · ctrl+g to edit in Notepad · Esc to cancel'
const RULE = '──────────────────────────────────────────────────────────────────────────────────────────────────────────────'

// Screen A: the dialog as first drawn (measurement 01).
const Q1_PRISTINE = [
  ...ABOVE,
  '←  ☐ Format  ☐ Sections  ✔ Submit  →',
  '',
  'How should I format the output?',
  '',
  '❯ 1. Summary',
  '     Brief overview of key points',
  '  2. Detailed',
  '     Full explanation with examples',
  '  3. Bullet list',
  '     Short bullets, one per finding',
  '  4. Type something.',
  RULE,
  '  5. Chat about this',
  '',
  HINT
]
// Screen B: after one Down (measurement 01).
const Q1_MOVED = Q1_PRISTINE.map((l) => (l === '❯ 1. Summary' ? '  1. Summary' : l === '  2. Detailed' ? '❯ 2. Detailed' : l))
// Measurement 02, O-C: the free-text row highlighted and typed into.
const Q1_TEXT = [
  ...ABOVE,
  '←  ☐ Format  ☐ Sections  ✔ Submit  →',
  '',
  'How should I format the output?',
  '',
  '  1. Summary',
  '     Brief overview of key points',
  '  2. Detailed',
  '  3. Bullet list',
  '     Short bullets, one per finding',
  '❯ 4. as a table',
  RULE,
  '  5. Chat about this',
  '',
  HINT_TEXT
]
// Measurement 02, O-D: the second question as first shown after Q1 was answered.
const Q2_FRESH = [
  ...ABOVE,
  '←  ☒ Format  ☐ Sections  ✔ Submit  →',
  '',
  'Which sections should I include?',
  '',
  '❯ 1. [ ] Introduction',
  '  Opening context',
  '  2. [ ] Methods',
  '  How the work was done',
  '  3. [ ] Results',
  '  What came out',
  '  4. [ ] Conclusion',
  '  Final summary',
  '  5. [ ] Type something',
  '     Submit',
  RULE,
  '  6. Chat about this',
  '',
  HINT
]
// Measurement 01, D: after pressing "2".
const Q2_TOGGLED = Q2_FRESH.map((l) => (l === '  2. [ ] Methods' ? '  2. [✔] Methods' : l === '←  ☒ Format  ☐ Sections  ✔ Submit  →' ? '←  ☒ Format  ☒ Sections  ✔ Submit  →' : l))
// Measurement 03, P-D: the free-text row highlighted and typed into.
const Q2_TEXT = Q2_TOGGLED.map((l) => (l === '❯ 1. [ ] Introduction' ? '  1. [ ] Introduction' : l === '  5. [ ] Type something' ? '❯ 5. [✔] appendix' : l))
// Measurement 03, P-E: after Tab from the text row — the question's own Submit row is highlighted.
const Q2_SUBMIT_ROW = Q2_TEXT.map((l) => (l === '❯ 5. [✔] appendix' ? '  5. [✔] appendix' : l === '     Submit' ? '❯    Submit' : l))
// Measurement 03: the review after both questions.
const REVIEW = [
  ...ABOVE,
  '←  ☒ Format  ☒ Sections  ✔ Submit  →',
  '',
  'Review your answers',
  '',
  ' ● How should I format the output?',
  '   → 표 2단으로 정리',
  ' ● Which sections should I include?',
  '   → Methods, appendix',
  '',
  'Ready to submit your answers?',
  '',
  '❯ 1. Submit answers',
  '  2. Cancel'
]
// Measurement 01, F: a review reached with Q1 unanswered.
const REVIEW_PARTIAL = [
  ...ABOVE,
  '←  ☐ Format  ☒ Sections  ✔ Submit  →',
  '',
  'Review your answers',
  '',
  '⚠ You have not answered all questions',
  ' ',
  ' ● Which sections should I include?',
  '   → Methods, Introduction',
  '',
  'Ready to submit your answers?',
  '',
  '❯ 1. Submit answers',
  '  2. Cancel'
]
// An ordinary screen: the CLI thinking, its composer open.
const NO_DIALOG = [
  ...ABOVE.slice(0, 5),
  '',
  '· Manifesting… ',
  RULE,
  '❯ ',
  RULE,
  '  [Fable 5.1] │ astera git:(develop)'
]

describe('markedRowOf', () => {
  it('is the text after the highlight marker on the last marked, non-empty row', () => {
    expect(markedRowOf(Q1_PRISTINE)).toBe('1. Summary')
    expect(markedRowOf(Q2_SUBMIT_ROW)).toBe('Submit')
    expect(markedRowOf(REVIEW)).toBe('1. Submit answers')
  })
  it('skips the composer, whose marker has nothing after it', () => {
    expect(markedRowOf(NO_DIALOG)).toBe('Please ask me about the format and the sections.')
    expect(markedRowOf(['❯ ', '  text'])).toBeNull()
  })
})

describe('askStageOf — question screens', () => {
  it('the dialog as first drawn is question 0, pristine', () => {
    expect(askStageOf(Q1_PRISTINE, form)).toEqual({ kind: 'question', index: 0, pristine: true, textRowFocused: false, submitRowFocused: false })
  })
  it('a moved highlight is no longer pristine', () => {
    expect(askStageOf(Q1_MOVED, form)).toMatchObject({ kind: 'question', index: 0, pristine: false })
  })
  it('the free-text row of a single-select, highlighted, is textRowFocused', () => {
    expect(askStageOf(Q1_TEXT, form)).toEqual({ kind: 'question', index: 0, pristine: false, textRowFocused: true, submitRowFocused: false })
  })
  it('the second question is index 1 and never pristine', () => {
    expect(askStageOf(Q2_FRESH, form)).toEqual({ kind: 'question', index: 1, pristine: false, textRowFocused: false, submitRowFocused: false })
  })
  it('a checked row means the dialog has moved, whatever the highlight', () => {
    expect(askStageOf(Q2_TOGGLED, form)).toMatchObject({ kind: 'question', index: 1, pristine: false })
  })
  it('the free-text row of a multi-select, highlighted and typed into, is textRowFocused', () => {
    expect(askStageOf(Q2_TEXT, form)).toMatchObject({ kind: 'question', index: 1, textRowFocused: true, submitRowFocused: false })
  })
  it("the question's own Submit row, highlighted, is submitRowFocused", () => {
    expect(askStageOf(Q2_SUBMIT_ROW, form)).toMatchObject({ kind: 'question', index: 1, textRowFocused: false, submitRowFocused: true })
  })
  it('a screen without the dialog is none', () => {
    expect(askStageOf(NO_DIALOG, form)).toEqual({ kind: 'none' })
    expect(askStageOf([], form)).toEqual({ kind: 'none' })
  })
  it('a dialog for a question this form does not have is none', () => {
    const other = parseAskUserQuestion({ questions: [{ question: 'Something else entirely?', options: [{ label: 'A' }, { label: 'B' }] }] }) as AskForm
    expect(askStageOf(Q1_PRISTINE, other)).toEqual({ kind: 'none' })
  })
  // A narrow terminal wraps the question text; the reader must still find it.
  it('finds a question whose text wrapped onto two rows', () => {
    const wrapped = Q1_PRISTINE.flatMap((l) => (l === 'How should I format the output?' ? ['How should I format the', 'output?'] : [l]))
    expect(askStageOf(wrapped, form)).toMatchObject({ kind: 'question', index: 0, pristine: true })
  })
})

describe('askStageOf — the review', () => {
  it('parses every question → answer pair and is ready when Submit answers is highlighted', () => {
    const stage = askStageOf(REVIEW, form)
    expect(stage.kind).toBe('review')
    if (stage.kind !== 'review') return
    expect(stage.ready).toBe(true)
    expect([...stage.answers.entries()]).toEqual([
      ['How should I format the output?', '표 2단으로 정리'],
      ['Which sections should I include?', 'Methods, appendix']
    ])
  })
  it('a partial review carries only the answered question', () => {
    const stage = askStageOf(REVIEW_PARTIAL, form)
    expect(stage.kind).toBe('review')
    if (stage.kind !== 'review') return
    expect(stage.answers.size).toBe(1)
    expect(stage.answers.get('Which sections should I include?')).toBe('Methods, Introduction')
  })
  it('is not ready when Cancel is highlighted', () => {
    const cancel = REVIEW.map((l) => (l === '❯ 1. Submit answers' ? '  1. Submit answers' : l === '  2. Cancel' ? '❯ 2. Cancel' : l))
    expect(askStageOf(cancel, form)).toMatchObject({ kind: 'review', ready: false })
  })
})

describe('reviewMatches', () => {
  const review = askStageOf(REVIEW, form) as Extract<AskStage, { kind: 'review' }>
  it('accepts the answers the review lists, free text and pick order included', () => {
    let a = setOther(form, emptyAnswers(form), 0, '표 2단으로 정리')
    a = togglePick(form, a, 1, 1)
    a = setOther(form, a, 1, 'appendix')
    expect(reviewMatches(review, form, a)).toBe(true)
  })
  it('rejects a different pick, a different order, a missing question', () => {
    let a = setOther(form, emptyAnswers(form), 0, '표 2단으로 정리')
    a = togglePick(form, a, 1, 2)
    a = setOther(form, a, 1, 'appendix')
    expect(reviewMatches(review, form, a)).toBe(false)
    const partial = askStageOf(REVIEW_PARTIAL, form) as Extract<AskStage, { kind: 'review' }>
    let b = togglePick(form, emptyAnswers(form), 1, 1)
    b = togglePick(form, b, 1, 0)
    expect(reviewMatches(partial, form, b)).toBe(false)
  })
})

describe('askCardStateOf', () => {
  it('answering outranks everything', () => {
    expect(askCardStateOf({ kind: 'none' }, true)).toBe('answering')
  })
  it('no dialog on screen is waiting; a pristine first question is ready; anything else is terminal', () => {
    expect(askCardStateOf({ kind: 'none' }, false)).toBe('waiting')
    expect(askCardStateOf(askStageOf(Q1_PRISTINE, form), false)).toBe('ready')
    expect(askCardStateOf(askStageOf(Q1_MOVED, form), false)).toBe('terminal')
    expect(askCardStateOf(askStageOf(Q2_FRESH, form), false)).toBe('terminal')
    expect(askCardStateOf(askStageOf(REVIEW, form), false)).toBe('terminal')
  })
})
