import { describe, it, expect } from 'vitest'
import { createProcHolders, procHeldBy } from './procHolders'

describe('procHeldBy', () => {
  it('is the proc of a greeted proc-spawn or proc-attach, and nothing else', () => {
    const g = { greeted: true }
    expect(procHeldBy({ t: 'proc-attach', id: 'p1' }, g)).toBe('p1')
    expect(procHeldBy({ t: 'proc-spawn', id: 'p2', file: 'x', args: [], opts: { cwd: 'D:/p', env: {} } }, g)).toBe('p2')
    expect(procHeldBy({ t: 'proc-write', id: 'p1', line: 'x' }, g)).toBeNull()
    expect(procHeldBy({ t: 'proc-attach', id: 'p1' }, { greeted: false })).toBeNull()
  })
})

describe('createProcHolders', () => {
  it('places and releases holds by socket, and tells each change', () => {
    const h = createProcHolders()
    let changes = 0
    h.onChange(() => changes++)
    h.heldBy('p1', 1)
    h.heldBy('p1', 2)
    expect(h.holdersOf('p1')).toEqual([1, 2])
    h.appGone(1)
    expect(h.holdersOf('p1')).toEqual([2])
    h.ended('p1')
    expect(h.holdersOf('p1')).toEqual([])
    expect(changes).toBe(3)
  })
  it('a second hold by the same socket is no change', () => {
    const h = createProcHolders()
    let changes = 0
    h.onChange(() => changes++)
    h.heldBy('p1', 1)
    h.heldBy('p1', 1)
    expect(changes).toBe(1)
  })
})
