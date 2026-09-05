import { describe, it, expect } from 'vitest'
import { VIEWPORTS } from './viewports'

describe('VIEWPORTS', () => {
  it('desktop fills the pane; tablet and mobile are the two fixed widths, widest first', () => {
    expect(VIEWPORTS).toEqual([
      { key: 'desktop', width: null },
      { key: 'tablet', width: 768 },
      { key: 'mobile', width: 390 }
    ])
  })
})
