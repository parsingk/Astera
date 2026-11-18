import { describe, it, expect } from 'vitest'
import { askStatus, askTarget, forgetAsks, isLatest, newAskTracker } from './useKubeEditor'

describe('the ask tracker: which target and chip answers still count', () => {
  it('a newer ask of the same path wins over a late answer', () => {
    const t = newAskTracker()
    const first = askTarget(t, '/p/a.yaml')
    const second = askTarget(t, '/p/a.yaml')
    expect(isLatest(t, 'target', '/p/a.yaml', first)).toBe(false)
    expect(isLatest(t, 'target', '/p/a.yaml', second)).toBe(true)
  })

  it("asking the target again outdates the chip's pending answer, which belongs to the target being replaced", () => {
    const t = newAskTracker()
    const status = askStatus(t, '/p/a.yaml')
    expect(isLatest(t, 'status', '/p/a.yaml', status)).toBe(true)
    askTarget(t, '/p/a.yaml')
    expect(isLatest(t, 'status', '/p/a.yaml', status)).toBe(false)
    // the chip asked once the new target is in counts again
    const next = askStatus(t, '/p/a.yaml')
    expect(isLatest(t, 'status', '/p/a.yaml', next)).toBe(true)
  })

  it('paths are independent, and a forgotten path accepts no earlier answer, even after it is asked again', () => {
    const t = newAskTracker()
    const a = askTarget(t, '/p/a.yaml')
    const b = askStatus(t, '/p/b.yaml')
    expect(isLatest(t, 'status', '/p/b.yaml', b)).toBe(true)
    forgetAsks(t, '/p/a.yaml')
    expect(isLatest(t, 'target', '/p/a.yaml', a)).toBe(false)
    const again = askTarget(t, '/p/a.yaml')
    expect(again).not.toBe(a)
    expect(isLatest(t, 'target', '/p/a.yaml', a)).toBe(false)
    expect(isLatest(t, 'status', '/p/b.yaml', b)).toBe(true)
  })
})
