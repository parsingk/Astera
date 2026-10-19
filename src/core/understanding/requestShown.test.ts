import { describe, it, expect } from 'vitest'
import { requestShownOf } from './requestShown'
import { SOURCED_OBJECTIVE_MAX, sourcedObjective } from '../sources/objective'

// G8 demo: How It Works showed a ticket Job's whole objective — Astera's sentence, then the ticket quoted as data inside
// SOURCE markers — under the record's title, and the paragraph squeezed the header's buttons
describe('requestShownOf', () => {
  const ctx = {
    objective: 'slugify() makes broken URL slugs',
    sourceLabel: 'GitHub issue #5 in o/r',
    sourceUrl: 'https://github.com/o/r/issues/5',
    evidence: [{ label: 'Body', content: '`slugify` should lower-case.\nSecond line.' }]
  }

  it('a Job made from a ticket is shown by the sentence that names the ticket', () => {
    expect(requestShownOf(sourcedObjective(ctx, 'GitHub'))).toBe('Resolve GitHub issue #5 in o/r (https://github.com/o/r/issues/5).')
  })

  it('so is one whose quoted content was cut', () => {
    const long = sourcedObjective({ ...ctx, evidence: [{ label: 'Body', content: 'x'.repeat(SOURCED_OBJECTIVE_MAX) }] }, 'GitHub')
    expect(long).toContain('(the item')
    expect(requestShownOf(long)).toBe('Resolve GitHub issue #5 in o/r (https://github.com/o/r/issues/5).')
  })

  it('a request a person wrote is shown whole, even one that quotes the markers', () => {
    expect(requestShownOf('Fix the login button')).toBe('Fix the login button')
    const typed = 'Resolve this\n\nlike so\n<<<SOURCE 0123abcd\nthe body\nSOURCE ffffffff>>>'
    expect(requestShownOf(typed)).toBe(typed)
    const multi = 'Make the header smaller.\nAnd the footer.'
    expect(requestShownOf(multi)).toBe(multi)
  })
})
