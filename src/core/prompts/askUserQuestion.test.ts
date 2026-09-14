import { describe, it, expect } from 'vitest'
import {
  parseAskUserQuestion,
  emptyAnswers,
  togglePick,
  setOther,
  cleanOther,
  isAnswered,
  allAnswered,
  expectedAnswers,
  type AskForm
} from './askUserQuestion'

// The two questions the dialog was measured with (spec §2).
const input = {
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
}
const form = parseAskUserQuestion(input) as AskForm

describe('parseAskUserQuestion', () => {
  it('reads the measured two-question input', () => {
    expect(form.questions).toHaveLength(2)
    expect(form.questions[0]).toEqual({
      header: 'Format',
      question: 'How should I format the output?',
      multiSelect: false,
      options: [
        { label: 'Summary', description: 'Brief overview of key points' },
        { label: 'Detailed', description: 'Full explanation with examples' },
        { label: 'Bullet list', description: 'Short bullets, one per finding' }
      ]
    })
    expect(form.questions[1].multiSelect).toBe(true)
  })

  it('a missing description is null, a missing header is empty, a missing multiSelect is false', () => {
    const f = parseAskUserQuestion({
      questions: [{ question: 'Q?', options: [{ label: 'A' }, { label: 'B', description: '' }] }]
    })
    expect(f).toEqual({
      questions: [{ header: '', question: 'Q?', multiSelect: false, options: [{ label: 'A', description: null }, { label: 'B', description: null }] }]
    })
  })

  // Fail closed: a shape that cannot be read in full is not drawn as a form (spec §8).
  it('refuses what it cannot read in full', () => {
    expect(parseAskUserQuestion(null)).toBeNull()
    expect(parseAskUserQuestion({})).toBeNull()
    expect(parseAskUserQuestion({ questions: [] })).toBeNull()
    expect(parseAskUserQuestion({ questions: [{ question: 'Q?', options: [{ label: 'only one' }] }] })).toBeNull()
    expect(parseAskUserQuestion({ questions: [{ question: 'Q?', options: [{ label: 'A' }, { label: 7 }] }] })).toBeNull()
    expect(parseAskUserQuestion({ questions: [{ question: '', options: [{ label: 'A' }, { label: 'B' }] }] })).toBeNull()
    expect(parseAskUserQuestion({ questions: [{ question: 'Q?', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }, { label: 'E' }] }] })).toBeNull()
    const five = { questions: Array.from({ length: 5 }, () => ({ question: 'Q?', options: [{ label: 'A' }, { label: 'B' }] })) }
    expect(parseAskUserQuestion(five)).toBeNull()
  })
})

describe('answers', () => {
  it('start empty, one per question', () => {
    expect(emptyAnswers(form)).toEqual([{ picks: [], other: '' }, { picks: [], other: '' }])
  })

  it('single-select: picking replaces, and clears any free text', () => {
    let a = setOther(form, emptyAnswers(form), 0, 'as a table')
    a = togglePick(form, a, 0, 1)
    expect(a[0]).toEqual({ picks: [1], other: '' })
    a = togglePick(form, a, 0, 2)
    expect(a[0]).toEqual({ picks: [2], other: '' })
  })

  it('single-select: typing free text clears the pick; clearing the text leaves the pick alone', () => {
    let a = togglePick(form, emptyAnswers(form), 0, 1)
    a = setOther(form, a, 0, 'as a table')
    expect(a[0]).toEqual({ picks: [], other: 'as a table' })
    a = togglePick(form, a, 0, 0)
    a = setOther(form, a, 0, '')
    expect(a[0]).toEqual({ picks: [0], other: '' })
  })

  // The review lists a multiple choice in the order it was picked (spec §4), and picks keep that order.
  it('multi-select: toggling appends in pick order and toggling again removes', () => {
    let a = togglePick(form, emptyAnswers(form), 1, 2)
    a = togglePick(form, a, 1, 0)
    expect(a[1].picks).toEqual([2, 0])
    a = togglePick(form, a, 1, 2)
    expect(a[1].picks).toEqual([0])
  })

  it('multi-select: free text is kept beside the picks', () => {
    let a = togglePick(form, emptyAnswers(form), 1, 1)
    a = setOther(form, a, 1, 'appendix')
    expect(a[1]).toEqual({ picks: [1], other: 'appendix' })
  })

  it('an out-of-range question or option changes nothing', () => {
    const a = emptyAnswers(form)
    expect(togglePick(form, a, 5, 0)).toBe(a)
    expect(togglePick(form, a, 0, 9)).toBe(a)
    expect(setOther(form, a, 5, 'x')).toBe(a)
  })

  it('isAnswered / allAnswered: a pick or non-blank text counts, whitespace does not', () => {
    let a = emptyAnswers(form)
    expect(isAnswered(form, a, 0)).toBe(false)
    a = setOther(form, a, 0, '   ')
    expect(isAnswered(form, a, 0)).toBe(false)
    a = togglePick(form, a, 0, 0)
    expect(isAnswered(form, a, 0)).toBe(true)
    expect(allAnswered(form, a)).toBe(false)
    a = setOther(form, a, 1, 'appendix')
    expect(allAnswered(form, a)).toBe(true)
  })

  it('expectedAnswers: labels in pick order, then the free text', () => {
    let a = togglePick(form, emptyAnswers(form), 1, 1)
    a = togglePick(form, a, 1, 0)
    a = setOther(form, a, 1, '  appendix ')
    expect(expectedAnswers(form, a, 1)).toEqual(['Methods', 'Introduction', 'appendix'])
    a = setOther(form, a, 0, 'as a table')
    expect(expectedAnswers(form, a, 0)).toEqual(['as a table'])
  })
})

describe('cleanOther', () => {
  // A newline would press Enter on the dialog and a tab would move its focus (spec §6, §8).
  it('turns newlines and tabs into spaces and drops control characters, without trimming', () => {
    expect(cleanOther('a\r\nb\tcd ')).toBe('a b cd ')
    expect(cleanOther('표 2단으로 정리')).toBe('표 2단으로 정리')
  })
})
