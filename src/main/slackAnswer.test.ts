import { describe, it, expect, vi } from 'vitest'
import { answerSlackCard } from './slackAnswer'

describe('answerSlackCard (Slack in the Host Task 7, P10)', () => {
  it('answers a held session\'s card, questions included', async () => {
    const chat = { has: () => true, answer: vi.fn(async () => {}) }
    expect(await answerSlackCard(chat, ['c1', 'r1', { kind: 'question', answers: [{ picks: [0], other: '' }] }])).toEqual({ answered: true })
    expect(chat.answer).toHaveBeenCalledWith('c1', 'r1', { kind: 'question', answers: [{ picks: [0], other: '' }] })
  })
  it('refuses a session it does not hold, a malformed ask, and says not-open when the request has gone', async () => {
    expect(await answerSlackCard({ has: () => false, answer: vi.fn() }, ['c1', 'r1', { kind: 'approval', decision: 'accept' }])).toEqual({ answered: false, reason: 'not-held' })
    for (const bad of [null, [], ['c1'], ['c1', 'r1', { kind: 'nope' }], ['c1', 'r1', { kind: 'approval' }]])
      expect(await answerSlackCard({ has: () => true, answer: vi.fn() }, bad)).toEqual({ answered: false, reason: 'bad-args' })
    const gone = { has: () => true, answer: async () => { throw new Error('no open request r1') } }
    expect(await answerSlackCard(gone, ['c1', 'r1', { kind: 'approval', decision: 'accept' }])).toEqual({ answered: false, reason: 'not-open' })
  })
})
