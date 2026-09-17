import { describe, it, expect } from 'vitest'
import { keysForQuestion, advanceFor, otherRowNumber, DOWN } from './askKeys'
import type { AskQuestion } from './askUserQuestion'

const single: AskQuestion = {
  header: 'Format',
  question: 'How should I format the output?',
  multiSelect: false,
  options: [
    { label: 'Summary', description: null },
    { label: 'Detailed', description: null },
    { label: 'Bullet list', description: null }
  ]
}
const multi: AskQuestion = {
  header: 'Sections',
  question: 'Which sections should I include?',
  multiSelect: true,
  options: [
    { label: 'Introduction', description: null },
    { label: 'Methods', description: null },
    { label: 'Results', description: null },
    { label: 'Conclusion', description: null }
  ]
}

// Every row here is a line of the measured table in spec §4.
describe('keysForQuestion / advanceFor', () => {
  it('the free-text row is one past the last option', () => {
    expect(otherRowNumber(single)).toBe(4)
    expect(otherRowNumber(multi)).toBe(5)
  })
  it('single, a pick: its digit; the dialog advances by itself', () => {
    expect(keysForQuestion(single, { picks: [1], other: '' })).toEqual(['2'])
    expect(advanceFor(single, { picks: [1], other: '' })).toBe('auto')
  })
  it('single, free text: the row digit, then the text; Enter advances', () => {
    expect(keysForQuestion(single, { picks: [], other: ' as a table ' })).toEqual(['4', 'as a table'])
    expect(advanceFor(single, { picks: [], other: 'as a table' })).toBe('enter')
  })
  it('multi, picks only: one digit per pick, in pick order; Tab advances', () => {
    expect(keysForQuestion(multi, { picks: [2, 0], other: '' })).toEqual(['3', '1'])
    expect(advanceFor(multi, { picks: [2, 0], other: '' })).toBe('tab')
  })
  it('multi, picks and text: digits, then Down once per option to reach the text row, then the text', () => {
    expect(keysForQuestion(multi, { picks: [1], other: 'appendix' })).toEqual(['2', DOWN, DOWN, DOWN, DOWN, 'appendix'])
    expect(advanceFor(multi, { picks: [1], other: 'appendix' })).toBe('tab')
  })
  it('multi, text only: the Downs and the text', () => {
    expect(keysForQuestion(multi, { picks: [], other: 'appendix' })).toEqual([DOWN, DOWN, DOWN, DOWN, 'appendix'])
  })
  it('nothing answered: no keys', () => {
    expect(keysForQuestion(single, { picks: [], other: '  ' })).toEqual([])
    expect(keysForQuestion(multi, { picks: [], other: '' })).toEqual([])
  })
})
