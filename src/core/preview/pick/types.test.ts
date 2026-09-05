import { describe, it, expect } from 'vitest'
import { MAX_ANNOTATIONS, PICK_BUDGET, STYLE_KEYS, type ComputedStyles } from './types'

describe('STYLE_KEYS', () => {
  // The list is written out by hand beside the interface and the two would drift the first time
  // someone adds a style to one and not the other. **The typecheck is what catches that**, not this
  // assertion: the annotation below has to name every field of ComputedStyles to compile, so adding a
  // field and forgetting it fails `tsc` — while both sides of the comparison below would drift
  // together and stay green. What the assertion does catch is a typo or a duplicate in STYLE_KEYS.
  it('names every field of ComputedStyles, once', () => {
    const every: ComputedStyles = {
      display: '', position: '', width: '', height: '', margin: '', padding: '', color: '',
      backgroundColor: '', border: '', borderRadius: '', fontFamily: '', fontSize: '', fontWeight: '',
      lineHeight: '', textAlign: '', zIndex: ''
    }
    expect([...STYLE_KEYS].sort()).toEqual(Object.keys(every).sort())
    expect(new Set(STYLE_KEYS).size).toBe(STYLE_KEYS.length)
  })
})

describe('the values later tasks assert against', () => {
  it('are what the design fixed', () => {
    expect(MAX_ANNOTATIONS).toBe(20)
    expect(PICK_BUDGET.htmlSnippet).toBe(4096)
    expect(PICK_BUDGET.textSnippet).toBe(200)
    expect(PICK_BUDGET.nearbyTextEntries).toBe(10)
  })
})
