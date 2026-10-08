import { describe, it, expect } from 'vitest'
import { createTouched } from './touched'

// Audit UI-7: opening Settings read each toggle again, and a toggle clicked before its read arrived was put back to the
// value read: the screen and the disk then disagreed until the next opening. A field the person touched keeps theirs.
describe('createTouched', () => {
  it('applies a read to a field nobody touched, and not to one somebody did', () => {
    const t = createTouched()
    const applied: string[] = []
    t.touch('yolo')
    t.unless('yolo', () => applied.push('yolo'))
    t.unless('browser', () => applied.push('browser'))
    expect(applied).toEqual(['browser'])
  })
  it('forgets what was touched when it is cleared (the next opening)', () => {
    const t = createTouched()
    const applied: string[] = []
    t.touch('yolo')
    t.clear()
    t.unless('yolo', () => applied.push('yolo'))
    expect(applied).toEqual(['yolo'])
  })
})
