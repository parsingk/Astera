import { describe, expect, it } from 'vitest'
import { arrowStep } from './arrowStep'

// Task 12 and 13 minors: the detail's tabs, the editor tab's views and the Kubernetes switch had no arrow keys. ARIA's
// tabs and radio group patterns move between items with the arrows, wrapping at the ends.
describe('arrowStep', () => {
  const tabs = ['summary', 'yaml', 'events'] as const

  it('moves right and left, wrapping at the ends', () => {
    expect(arrowStep(tabs, 'summary', 'ArrowRight')).toBe('yaml')
    expect(arrowStep(tabs, 'events', 'ArrowRight')).toBe('summary')
    expect(arrowStep(tabs, 'yaml', 'ArrowLeft')).toBe('summary')
    expect(arrowStep(tabs, 'summary', 'ArrowLeft')).toBe('events')
  })

  it('takes up and down only where asked (a radio group), and no other key', () => {
    expect(arrowStep(tabs, 'summary', 'ArrowDown')).toBeNull()
    expect(arrowStep(tabs, 'summary', 'ArrowDown', true)).toBe('yaml')
    expect(arrowStep(tabs, 'summary', 'ArrowUp', true)).toBe('events')
    expect(arrowStep(tabs, 'summary', 'Enter', true)).toBeNull()
  })

  it('starts from the first item when the current one is not among them', () => {
    expect(arrowStep(['a', 'b'], 'x', 'ArrowRight')).toBe('a')
  })
})
