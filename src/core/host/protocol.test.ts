import { describe, it, expect, expectTypeOf } from 'vitest'
import type { HostMessage, WorktreesSnapshot } from './protocol'

// Type-level: `npm run -s typecheck` is what fails when these do not hold.
describe('the worktrees seq contract (review of Tasks 4-5, I1)', () => {
  it('stamps the push and every worktree-* reply with one seq, and neither may leave it out', () => {
    expectTypeOf<WorktreesSnapshot['seq']>().toEqualTypeOf<number>()
    // A reply spreads into a push unchanged: one shape, so a receiver compares the two by `seq`.
    const reply: WorktreesSnapshot = { seq: 7, file: { items: [] } }
    const push: HostMessage = { t: 'worktrees-state', ...reply }
    expectTypeOf<Extract<HostMessage, { t: 'worktrees-state' }>>().toMatchTypeOf<WorktreesSnapshot>()
    // @ts-expect-error a reply without a seq cannot be ordered against a push
    const unordered: WorktreesSnapshot = { file: { items: [] } }
    // @ts-expect-error nor can a push without one
    const unorderedPush: HostMessage = { t: 'worktrees-state', file: { items: [] } }
    expect([push, unordered, unorderedPush]).toHaveLength(3)
  })
})
