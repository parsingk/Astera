import { describe, it, expect } from 'vitest'
import { costArgsFor, isGenerateJob, looksOutOfCredits, numberAt, shortCreditsMessage, COST_KEYS } from './credits'

describe('credits', () => {
  it('finds a nested numeric field', () => {
    expect(numberAt('{"data":{"credits":12.5}}', COST_KEYS)).toBe(12.5)
    expect(numberAt('{"credits":"7"}', COST_KEYS)).toBe(7)
    expect(numberAt('not json', COST_KEYS)).toBeNull()
  })

  it('builds the cost call from a create or workflow call', () => {
    expect(costArgsFor(['generate', 'create', 'kling', '--prompt', 'x', '--wait', '--wait-timeout', '20m']))
      .toEqual(['generate', 'cost', 'kling', '--prompt', 'x', '--json'])
    expect(costArgsFor(['generate', 'workflow', 'reframe', '--duration', '7']))
      .toEqual(['generate', 'cost', 'workflow', 'reframe', '--duration', '7', '--json'])
    expect(isGenerateJob(['generate', 'get', 'x'])).toBe(false)
  })

  it('finds the subcommand after leading global flags', () => {
    expect(isGenerateJob(['--json', 'generate', 'create', 'k'])).toBe(true)
    expect(costArgsFor(['--json', 'generate', 'create', 'k', '--prompt', 'x'])).toEqual(['generate', 'cost', 'k', '--prompt', 'x', '--json'])
  })

  it('recognises out-of-credit wording', () => {
    expect(looksOutOfCredits('Error: insufficient credits')).toBe(true)
    expect(looksOutOfCredits('not enough credits for this job')).toBe(true)
    expect(looksOutOfCredits('request failed (no response received)')).toBe(false)
  })

  it('tells the agent to ask the user with choices', () => {
    const m = shortCreditsMessage({
      current: { label: 'A', email: 'a@x.com', credits: 3 }, need: 12,
      others: [{ label: 'B', email: 'b@x.com', credits: 40 }]
    })
    expect(m).toContain('"A" (a@x.com) has 3 credits; this job needs 12')
    expect(m).toContain('"B" (b@x.com, 40 credits)')
    expect(m).toContain('Ask the user which account to use')
    expect(m).toContain('astera higgsfield use --account <account>')
  })
})
