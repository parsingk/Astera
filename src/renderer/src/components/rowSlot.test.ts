import { describe, it, expect } from 'vitest'
import type { PrInfo } from '../../../core/github/types'
import type { BranchPushState } from '../../../core/types'
import { rowSlot } from './rowSlot'

const pr: PrInfo = {
  number: 7,
  title: 't',
  state: 'open',
  isDraft: false,
  url: 'u',
  checks: null
}
const push = (over: Partial<BranchPushState> = {}): BranchPushState => ({
  ahead: 3,
  behind: 0,
  hasUpstream: true,
  upstreamGone: false,
  ...over
})

describe('rowSlot', () => {
  // The slot holds one thing. A row with both must not draw two.
  it('a PR wins over push state', () => {
    expect(rowSlot(pr, push())).toEqual({ kind: 'pr', pr })
  })

  it('push state shows when there is no PR', () => {
    expect(rowSlot(undefined, push())).toEqual({ kind: 'push', ahead: 3 })
  })

  it('nothing to push renders nothing', () => {
    expect(rowSlot(undefined, push({ ahead: 0 }))).toBeNull()
  })

  // null is unknown, not zero — a branch with work must not go silent because the base
  // could not be resolved.
  it('an unknown ahead still offers the slot', () => {
    expect(rowSlot(undefined, push({ ahead: null }))).toEqual({ kind: 'push', ahead: null })
  })

  it('no PR and no push state at all renders nothing', () => {
    expect(rowSlot(undefined, undefined)).toBeNull()
  })

  // The PR wins whatever the push state says, including the two values that would otherwise
  // decide the slot on their own.
  it('a PR wins over nothing to push', () => {
    expect(rowSlot(pr, push({ ahead: 0 }))).toEqual({ kind: 'pr', pr })
  })

  it('a PR wins over an unknown ahead', () => {
    expect(rowSlot(pr, push({ ahead: null }))).toEqual({ kind: 'pr', pr })
  })

  // The slot does not branch on state: a merged PR is still the further-along fact and worth
  // showing. Offering Create again for a closed or merged PR is the row menu's job, not this one's.
  it('a merged PR still takes the slot', () => {
    const merged: PrInfo = { ...pr, state: 'merged' }
    expect(rowSlot(merged, push())).toEqual({ kind: 'pr', pr: merged })
  })
})
