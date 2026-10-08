import { describe, it, expect } from 'vitest'
import { appendCapped } from './appendCapped'

// Audit UI-13: the CLI installer's output was appended to state without a bound, each chunk copying the whole log.
describe('appendCapped', () => {
  it('appends under the cap, and past it keeps the newest characters from a line start', () => {
    expect(appendCapped('a\n', 'b\n', 100)).toBe('a\nb\n')
    const out = appendCapped('x'.repeat(30) + '\n', 'keep this\nand this\n', 22)
    expect(out.length).toBeLessThanOrEqual(22)
    expect(out.endsWith('and this\n')).toBe(true)
  })
})
