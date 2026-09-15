import { describe, it, expect } from 'vitest'
import { driveAsk, type AskOutcome } from './askDriver'
import { parseAskUserQuestion, emptyAnswers, togglePick, setOther, type AskForm } from '../../../../core/prompts/askUserQuestion'
import { DOWN, TAB, ENTER } from '../../../../core/prompts/askKeys'

const two = parseAskUserQuestion({
  questions: [
    { header: 'Format', question: 'How should I format the output?', multiSelect: false, options: [{ label: 'Summary' }, { label: 'Detailed' }, { label: 'Bullet list' }] },
    { header: 'Sections', question: 'Which sections should I include?', multiSelect: true, options: [{ label: 'Introduction' }, { label: 'Methods' }, { label: 'Results' }, { label: 'Conclusion' }] }
  ]
}) as AskForm
const one = parseAskUserQuestion({ questions: [two.questions[0]] }) as AskForm
const oneMulti = parseAskUserQuestion({ questions: [two.questions[1]] }) as AskForm

const STRIP = (a: string, b: string): string => `←  ${a} Format  ${b} Sections  ✔ Submit  →`
const HINT = 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel'
const q1 = (strip: string, marked = 1, text: string | null = null): string => [
  strip, '', 'How should I format the output?', '',
  `${marked === 1 ? '❯' : ' '} 1. Summary`, '     Brief overview of key points',
  `${marked === 2 ? '❯' : ' '} 2. Detailed`, '     Full explanation with examples',
  `${marked === 3 ? '❯' : ' '} 3. Bullet list`, '     Short bullets, one per finding',
  `${marked === 4 ? '❯' : ' '} 4. ${text ?? 'Type something.'}`, '──────', '  5. Chat about this', '', HINT
].join('\n')
const q2 = (strip: string, checked: number[] = [], marked: number | 'submit' = 1, text: string | null = null): string => {
  const box = (i: number): string => (checked.includes(i) ? '[✔]' : '[ ]')
  const m = (i: number): string => (marked === i ? '❯' : ' ')
  return [
    strip, '', 'Which sections should I include?', '',
    `${m(1)} 1. ${box(1)} Introduction`, '  Opening context',
    `${m(2)} 2. ${box(2)} Methods`, '  How the work was done',
    `${m(3)} 3. ${box(3)} Results`, '  What came out',
    `${m(4)} 4. ${box(4)} Conclusion`, '  Final summary',
    `${m(5)} 5. ${text === null ? '[ ] Type something' : `[✔] ${text}`}`,
    `${marked === 'submit' ? '❯   ' : '    '} Submit`, '──────', '  6. Chat about this', '', HINT
  ].join('\n')
}
const review = (pairs: Array<[string, string]>, strip = STRIP('☒', '☒')): string => [
  strip, '', 'Review your answers', '',
  ...pairs.flatMap(([q, a]) => [` ● ${q}`, `   → ${a}`]),
  '', 'Ready to submit your answers?', '', '❯ 1. Submit answers', '  2. Cancel'
].join('\n')
const DONE = '● User answered Claude\'s questions:\n  ⎿  · …\n──────\n❯ \n──────'

/** A scripted dialog: `steps[i]` is the key expected next and the screen shown once it arrives. */
function dialog(first: string, steps: Array<[key: string, then: string]>) {
  let screen = first
  const sent: string[] = []
  const wrong: string[] = []
  let i = 0
  return {
    sent,
    wrong,
    readScreen: () => screen,
    write: (k: string) => {
      sent.push(k)
      if (i < steps.length && steps[i][0] === k) {
        screen = steps[i][1]
        i++
      } else wrong.push(k)
    },
    wait: async () => {}
  }
}

const run = (form: AskForm, answers: ReturnType<typeof emptyAnswers>, d: ReturnType<typeof dialog>): Promise<AskOutcome> =>
  driveAsk({ form, answers, readScreen: d.readScreen, write: d.write, wait: d.wait })

describe('driveAsk — the measured happy paths', () => {
  it('single pick: the digit, then Enter on a matching review', async () => {
    const answers = togglePick(one, emptyAnswers(one), 0, 1)
    const d = dialog(q1(STRIP('☐', '☐')), [['2', review([['How should I format the output?', 'Detailed']])], [ENTER, DONE]])
    expect(await run(one, answers, d)).toEqual({ outcome: 'submitted' })
    expect(d.sent).toEqual(['2', ENTER])
    expect(d.wrong).toEqual([])
  })

  it('single free text: the row digit, the text, Enter, then Enter on the review', async () => {
    const answers = setOther(one, emptyAnswers(one), 0, 'as a table')
    const d = dialog(q1(STRIP('☐', '☐')), [
      ['4', q1(STRIP('☐', '☐'), 4)],
      ['as a table', q1(STRIP('☐', '☐'), 4, 'as a table')],
      [ENTER, review([['How should I format the output?', 'as a table']])],
      [ENTER, DONE]
    ])
    expect(await run(one, answers, d)).toEqual({ outcome: 'submitted' })
    expect(d.sent).toEqual(['4', 'as a table', ENTER, ENTER])
  })

  it('multi picks: one digit per pick in pick order, Tab, then Enter on the review', async () => {
    let answers = togglePick(oneMulti, emptyAnswers(oneMulti), 0, 2)
    answers = togglePick(oneMulti, answers, 0, 0)
    const d = dialog(q2(STRIP('☐', '☐')), [
      ['3', q2(STRIP('☐', '☒'), [3])],
      ['1', q2(STRIP('☐', '☒'), [3, 1])],
      [TAB, review([['Which sections should I include?', 'Results, Introduction']])],
      [ENTER, DONE]
    ])
    expect(await run(oneMulti, answers, d)).toEqual({ outcome: 'submitted' })
    expect(d.sent).toEqual(['3', '1', TAB, ENTER])
  })

  it('multi with free text: digits, four Downs, the text, Tab to the Submit row, Enter, then Enter on the review', async () => {
    let answers = togglePick(oneMulti, emptyAnswers(oneMulti), 0, 1)
    answers = setOther(oneMulti, answers, 0, 'appendix')
    const s = STRIP('☐', '☒')
    const d = dialog(q2(STRIP('☐', '☐')), [
      ['2', q2(s, [2])],
      [DOWN, q2(s, [2], 2)],
      [DOWN, q2(s, [2], 3)],
      [DOWN, q2(s, [2], 4)],
      [DOWN, q2(s, [2], 5)],
      ['appendix', q2(s, [2], 5, 'appendix')],
      [TAB, q2(s, [2], 'submit', 'appendix')],
      [ENTER, review([['Which sections should I include?', 'Methods, appendix']])],
      [ENTER, DONE]
    ])
    expect(await run(oneMulti, answers, d)).toEqual({ outcome: 'submitted' })
    expect(d.sent).toEqual(['2', DOWN, DOWN, DOWN, DOWN, 'appendix', TAB, ENTER, ENTER])
  })

  it('two questions: a single-select advances by itself into the multi-select', async () => {
    let answers = togglePick(two, emptyAnswers(two), 0, 1)
    answers = togglePick(two, answers, 1, 1)
    const d = dialog(q1(STRIP('☐', '☐')), [
      ['2', q2(STRIP('☒', '☐'))],
      ['2', q2(STRIP('☒', '☒'), [2])],
      [TAB, review([['How should I format the output?', 'Detailed'], ['Which sections should I include?', 'Methods']])],
      [ENTER, DONE]
    ])
    expect(await run(two, answers, d)).toEqual({ outcome: 'submitted' })
    expect(d.sent).toEqual(['2', '2', TAB, ENTER])
  })
})

describe('driveAsk — every stop leaves the dialog alone', () => {
  it('a dialog that is not pristine sends nothing', async () => {
    const answers = togglePick(one, emptyAnswers(one), 0, 1)
    const d = dialog(q1(STRIP('☐', '☐'), 2), [])
    const r = await run(one, answers, d)
    expect(r).toMatchObject({ outcome: 'stopped', reason: 'not-pristine' })
    expect(d.sent).toEqual([])
  })

  it('no dialog on screen sends nothing', async () => {
    const answers = togglePick(one, emptyAnswers(one), 0, 1)
    const d = dialog(DONE, [])
    expect(await run(one, answers, d)).toMatchObject({ outcome: 'stopped', reason: 'dialog-gone' })
    expect(d.sent).toEqual([])
  })

  it('a review that lists something else gets no Enter', async () => {
    const answers = togglePick(one, emptyAnswers(one), 0, 1)
    const d = dialog(q1(STRIP('☐', '☐')), [['2', review([['How should I format the output?', 'Summary']])]])
    expect(await run(one, answers, d)).toMatchObject({ outcome: 'stopped', reason: 'review-mismatch' })
    expect(d.sent).toEqual(['2'])
  })

  it('a review missing a question gets no Enter', async () => {
    let answers = togglePick(two, emptyAnswers(two), 0, 1)
    answers = togglePick(two, answers, 1, 1)
    const d = dialog(q1(STRIP('☐', '☐')), [
      ['2', q2(STRIP('☒', '☐'))],
      ['2', q2(STRIP('☒', '☒'), [2])],
      [TAB, review([['Which sections should I include?', 'Methods']], STRIP('☐', '☒'))]
    ])
    expect(await run(two, answers, d)).toMatchObject({ outcome: 'stopped', reason: 'review-mismatch' })
    expect(d.sent).toEqual(['2', '2', TAB])
  })

  it('a screen that does not move after the keys stops with no-change', async () => {
    const answers = togglePick(one, emptyAnswers(one), 0, 1)
    const d = dialog(q1(STRIP('☐', '☐')), [['9', 'never']])
    expect(await run(one, answers, d)).toMatchObject({ outcome: 'stopped', reason: 'no-change' })
    expect(d.sent).toEqual(['2'])
  })

  it('the dialog vanishing mid-way stops with dialog-gone and no Enter', async () => {
    let answers = togglePick(two, emptyAnswers(two), 0, 1)
    answers = togglePick(two, answers, 1, 1)
    const d = dialog(q1(STRIP('☐', '☐')), [['2', DONE]])
    expect(await run(two, answers, d)).toMatchObject({ outcome: 'stopped', reason: 'dialog-gone' })
    expect(d.sent).toEqual(['2'])
  })

  it('a review whose highlight is on Cancel gets no Enter', async () => {
    const answers = togglePick(one, emptyAnswers(one), 0, 1)
    const cancel = review([['How should I format the output?', 'Detailed']]).replace('❯ 1. Submit answers', '  1. Submit answers').replace('  2. Cancel', '❯ 2. Cancel')
    const d = dialog(q1(STRIP('☐', '☐')), [['2', cancel]])
    expect(await run(one, answers, d)).toMatchObject({ outcome: 'stopped', reason: 'review-mismatch' })
    expect(d.sent).toEqual(['2'])
  })
})
