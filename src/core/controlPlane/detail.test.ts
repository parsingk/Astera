// What the Runtime detail and the findings say of a Runtime (remote governance design §9.3, §10.1).
import { describe, it, expect } from 'vitest'
import { runtimeIsOlder } from './detail'

describe('runtimeIsOlder', () => {
  it('compares parts as numbers and never flags what it cannot read', () => {
    expect(runtimeIsOlder('1.4.9', '1.5.0')).toBe(true)
    expect(runtimeIsOlder('1.10.0', '1.9.0')).toBe(false)
    expect(runtimeIsOlder('1.5.0', '1.5.0')).toBe(false)
    // A newer Runtime is shown, not flagged
    expect(runtimeIsOlder('1.6.0', '1.5.0')).toBe(false)
    expect(runtimeIsOlder('junk', '1.5.0')).toBe(false)
    expect(runtimeIsOlder('1.4.0', 'junk')).toBe(false)
  })
})
