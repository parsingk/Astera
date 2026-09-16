import { describe, it, expect } from 'vitest'
import { describeChatRequest, questionAnswerOf, approvalDecisionOf } from './chatRequest'
import { sanitizeChatText } from './inbound'
import type { ChatRequest } from '../chat/types'
import type { AskForm } from '../prompts/askUserQuestion'

const form: AskForm = {
  questions: [
    { header: 'Format', question: 'How should I format the output?', multiSelect: false,
      options: [{ label: 'Summary', description: 'Brief overview' }, { label: 'Detailed', description: 'Full explanation' }] },
    { header: 'Sections', question: 'Which sections should I include?', multiSelect: true,
      options: [{ label: 'Introduction', description: null }, { label: 'Methods', description: 'How the work was done' }, { label: 'Results', description: 'What came out' }] }
  ]
}
const question: ChatRequest = { id: 'q1', kind: 'question', form }
const approval: ChatRequest = { id: 'a1', kind: 'approval', about: { tool: 'Write', lines: ['D:/p/probe.txt'] }, decisions: ['accept', 'acceptForSession', 'decline'] }
const approvalNoAlways: ChatRequest = { ...approval, decisions: ['accept', 'decline'] }

describe('describeChatRequest', () => {
  it('a question card: header, question, numbered options with descriptions, and the per-question hint', () => {
    const text = describeChatRequest(question, 'ko')
    expect(text).toContain('❓ Format — How should I format the output?')
    expect(text).toContain('1. Summary — Brief overview')
    expect(text).toContain('2. Detailed — Full explanation')
    expect(text).toContain('❓ Sections — Which sections should I include?')
    expect(text).toContain('1. Introduction') // no description → label alone
    expect(text).toContain('3. Results — What came out')
    expect(text.trimEnd().endsWith('💡 질문마다 `/`로 구분해 답장 (예: 1,3 / 2)')).toBe(true)
  })

  it('a single multi-select question gets the comma hint; a single single-select gets none', () => {
    const multi = describeChatRequest({ id: 'q', kind: 'question', form: { questions: [form.questions[1]] } }, 'ko')
    expect(multi.trimEnd().endsWith('💡 여러 개는 쉼표로 구분해 답장 (예: 1,3)')).toBe(true)
    const single = describeChatRequest({ id: 'q', kind: 'question', form: { questions: [form.questions[0]] } }, 'ko')
    expect(single).not.toContain('💡')
  })

  it('an approval card: the tool, its lines, and the hint naming exactly the offered decisions', () => {
    expect(describeChatRequest(approval, 'ko')).toBe('🔧 Write\nD:/p/probe.txt\n💡 허용, 항상 허용 또는 거절로 답장')
    expect(describeChatRequest(approvalNoAlways, 'en')).toBe('🔧 Write\nD:/p/probe.txt\n💡 Reply 허용 (allow) or 거절 (decline)')
  })
})

describe('questionAnswerOf', () => {
  it('one number per question, questions separated by /, picks are 0-based', () => {
    expect(questionAnswerOf('2 / 1,3', form)).toEqual({ ok: true, answers: [{ picks: [1], other: '' }, { picks: [0, 2], other: '' }] })
  })
  it('a part without a number is that question’s free text', () => {
    expect(questionAnswerOf('2 / plain prose instead', form)).toEqual({ ok: true, answers: [{ picks: [1], other: '' }, { picks: [], other: 'plain prose instead' }] })
  })
  it('a single question needs no separator', () => {
    expect(questionAnswerOf('1', { questions: [form.questions[0]] })).toEqual({ ok: true, answers: [{ picks: [0], other: '' }] })
  })
  it('too few or too many parts → countMismatch', () => {
    expect(questionAnswerOf('2', form)).toEqual({ ok: false, reason: { key: 'slack.choice.countMismatch', params: { expected: 2, got: 1 } } })
  })
  it('two picks on a single-select → singleOnlyAt; a number past the options → outOfRangeAt', () => {
    expect(questionAnswerOf('1,2 / 1', form)).toEqual({ ok: false, reason: { key: 'slack.choice.singleOnlyAt', params: { index: 1 } } })
    expect(questionAnswerOf('1 / 4', form)).toEqual({ ok: false, reason: { key: 'slack.choice.outOfRangeAt', params: { index: 2, n: '4', max: 3 } } })
  })
  it('repeated picks are deduped, keeping first-occurrence order', () => {
    expect(questionAnswerOf('3,1,3', { questions: [form.questions[1]] })).toEqual({ ok: true, answers: [{ picks: [2, 0], other: '' }] })
  })
})

describe('approvalDecisionOf', () => {
  const all = ['accept', 'acceptForSession', 'decline'] as const
  it('understands the Korean and English words, trimmed and case-insensitively', () => {
    expect(approvalDecisionOf(' 허용 ', all)).toBe('accept')
    expect(approvalDecisionOf('YES', all)).toBe('accept')
    expect(approvalDecisionOf('항상 허용', all)).toBe('acceptForSession')
    expect(approvalDecisionOf('always', all)).toBe('acceptForSession')
    expect(approvalDecisionOf('거절', all)).toBe('decline')
    expect(approvalDecisionOf('n', all)).toBe('decline')
  })
  it('always-allow is null when the request does not offer it; unknown words are null', () => {
    expect(approvalDecisionOf('항상 허용', ['accept', 'decline'])).toBeNull()
    expect(approvalDecisionOf('maybe', all)).toBeNull()
  })
})

describe('sanitizeChatText', () => {
  it('strips control characters but keeps newlines', () => {
    expect(sanitizeChatText('a' + String.fromCharCode(7) + 'b\nc')).toBe('ab\nc')
  })
})
