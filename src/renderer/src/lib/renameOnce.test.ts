import { describe, it, expect } from 'vitest'
import { endRenameOnce } from './renameOnce'

// Audit UI-2: Enter and Escape ended a tab rename, and the blur of the input as it unmounted ended it again with the
// typed text: Escape renamed the tab anyway, and Enter sent the rename twice. One rename ends once.
describe('endRenameOnce', () => {
  it('lets the first end through and drops the blur that follows', () => {
    const seen: Array<string | null> = []
    const state = { ended: null as string | null }
    endRenameOnce(state, 'tab1', () => seen.push(null))
    endRenameOnce(state, 'tab1', () => seen.push('typed'))
    expect(seen).toEqual([null])
  })
  it('lets the next rename of the same tab end again once it began', () => {
    const seen: string[] = []
    const state = { ended: null as string | null }
    endRenameOnce(state, 'tab1', () => seen.push('a'))
    state.ended = null
    endRenameOnce(state, 'tab1', () => seen.push('b'))
    expect(seen).toEqual(['a', 'b'])
  })
})
