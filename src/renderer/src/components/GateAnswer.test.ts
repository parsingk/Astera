// Answering a Task's question in the run's graph (plugin Phase 5 C9, C13): a check that could not be made takes one of
// three choices, each in this app's words with what it does, and no answer in words; other questions are as they were.
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CATALOGS, LANGS } from '../../../core/i18n'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'en', t: (key: string, p?: Record<string, unknown>) => (p ? `${key} ${JSON.stringify(p)}` : key) })
}))
const { GateAnswer, gateChoicesOf } = await import('./GateAnswer')
const t = (key: string): string => key

const unavailable = { id: 'g1', question: 'The check could not be made: D: down', options: ['retry', 'skip-check', 'mark-failed'], kind: 'check-unavailable' as const }
const render = (gate: Parameters<typeof gateChoicesOf>[0]): string =>
  renderToStaticMarkup(
    React.createElement(GateAnswer, { gate, answer: '', busy: false, error: null, onAnswer: () => {}, onResolve: () => {}, onCancel: () => {} })
  )

describe('gateChoicesOf', () => {
  it('a check that could not be made: its three choices in words with what each does, sent as the option, and no free text', () => {
    expect(gateChoicesOf(unavailable, t)).toEqual({
      choices: [
        { value: 'retry', label: 'jobs.gate.checkUnavailable.retry', hint: 'jobs.gate.checkUnavailable.retryHint' },
        { value: 'skip-check', label: 'jobs.gate.checkUnavailable.skip', hint: 'jobs.gate.checkUnavailable.skipHint' },
        { value: 'mark-failed', label: 'jobs.gate.checkUnavailable.fail', hint: 'jobs.gate.checkUnavailable.failHint' }
      ],
      freeText: false
    })
  })

  it('another question keeps its options as they are and takes an answer in words', () => {
    expect(gateChoicesOf({ id: 'g2', question: 'q', options: ['Drop the check', 'Stop the Job'] }, t)).toEqual({
      choices: [
        { value: 'Drop the check', label: 'Drop the check' },
        { value: 'Stop the Job', label: 'Stop the Job' }
      ],
      freeText: true
    })
    expect(gateChoicesOf({ id: 'g3', question: 'q' }, t)).toEqual({ choices: [], freeText: true })
    // An option this app does not know is offered as it is
    expect(gateChoicesOf({ ...unavailable, options: ['retry', 'later'] }, t).choices[1]).toEqual({ value: 'later', label: 'later' })
  })
})

// 5c final review (declined, ruled a finding): the exhausted question's two answers have had words in all four languages
// (jobs.convergence.gate.retryOnce, markFailed) that no screen used
it('an exhausted repair budget offers its two answers in words, sent as the option, and still takes words', () => {
  expect(gateChoicesOf({ id: 'g2', question: 'q', options: ['retry-once', 'mark-failed'], kind: 'convergence-exhausted' }, t)).toEqual({
    choices: [
      { value: 'retry-once', label: 'jobs.convergence.gate.retryOnce' },
      { value: 'mark-failed', label: 'jobs.convergence.gate.markFailed' }
    ],
    freeText: true
  })
})

// GitHub lifecycle G3b2: a GitHub question offers its answers in words, a pull request by its number, and takes no words
it('a GitHub question offers each answer in words with what it does, a pull request by its number, and no free text', () => {
  expect(gateChoicesOf({ id: 'g4', question: 'q', options: ['wait', 'no-ci', 'mark-failed'], kind: 'github-no-ci' }, t)).toEqual({
    choices: [
      { value: 'wait', label: 'jobs.gate.github.wait', hint: 'jobs.gate.github.waitHint' },
      { value: 'no-ci', label: 'jobs.gate.github.noCi', hint: 'jobs.gate.github.noCiHint' },
      { value: 'mark-failed', label: 'jobs.gate.github.markFailed', hint: 'jobs.gate.github.markFailedHint' }
    ],
    freeText: false
  })
  const withParams = (key: string, p?: Record<string, unknown>): string => (p ? `${key} ${JSON.stringify(p)}` : key)
  expect(gateChoicesOf({ id: 'g5', question: 'q', options: ['pr-12', 'continue'], kind: 'github-pr-ambiguous' }, withParams as never).choices).toEqual([
    { value: 'pr-12', label: 'jobs.gate.github.bindPr {"number":12}', hint: 'jobs.gate.github.bindPrHint' },
    { value: 'continue', label: 'jobs.gate.github.continue', hint: 'jobs.gate.github.continueHint' }
  ])
  // G3b2 final review M7
  expect(gateChoicesOf({ id: 'g6', question: 'q', options: ['retry', 'mark-failed'], kind: 'github-carry' }, t).choices[0]).toEqual({
    value: 'retry', label: 'jobs.gate.github.retry', hint: 'jobs.gate.github.retryHint'
  })
  for (const key of ['wait', 'waitHint', 'noCi', 'noCiHint', 'continue', 'continueHint', 'markFailed', 'markFailedHint', 'bindPr', 'bindPrHint', 'retry', 'retryHint'])
    for (const lang of LANGS) expect((CATALOGS[lang].messages as Record<string, string>)[`jobs.gate.github.${key}`], `${lang} ${key}`).toBeTruthy()
})

describe('GateAnswer', () => {
  it('a check that could not be made shows the question, three described choices and no box to type in', () => {
    const html = render(unavailable)
    expect(html).toContain('The check could not be made: D: down')
    expect(html.match(/<span class="detail-gate-option-hint">jobs\.gate\.checkUnavailable\.\w+Hint<\/span>/g)).toHaveLength(3)
    expect(html).not.toContain('<textarea')
  })

  // 5c final review M7: the line under a choice is read once, not again as its title
  it('a choice’s description is its visible line only, not a title that repeats it', () => {
    expect(render(unavailable)).not.toContain('title="jobs.gate.checkUnavailable')
  })

  // 5c final review M6: with no box to focus, the first choice takes the focus the Unlock button had
  it('the first choice takes the focus when there is no box', () => {
    const html = render(unavailable)
    expect(html.match(/<button[^>]*autofocus=""/g)).toHaveLength(1)
    expect(html).toMatch(/<button autofocus=""[^>]*>jobs\.gate\.checkUnavailable\.retry</)
    expect(render({ id: 'g3', question: 'Which way?', options: ['a'] })).not.toMatch(/<button[^>]*autofocus/)
  })

  it('a question a coordinator asked keeps its box', () => {
    expect(render({ id: 'g3', question: 'Which way?' })).toContain('<textarea')
  })

  it('the choices are in all four languages', () => {
    const keys = ['retry', 'retryHint', 'skip', 'skipHint', 'fail', 'failHint'].map((k) => `jobs.gate.checkUnavailable.${k}`)
    for (const key of keys) for (const lang of LANGS) expect((CATALOGS[lang].messages as Record<string, string>)[key], `${lang} ${key}`).toBeTruthy()
  })
})
