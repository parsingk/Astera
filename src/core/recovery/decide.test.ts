import { describe, it, expect } from 'vitest'
import { decideRecovery } from './decide'
import type { GitFacts, LostAttempt } from './types'

const attempt = (over: Partial<LostAttempt> = {}): LostAttempt => ({
  runId: 'run_1',
  taskId: 'tsk_1',
  dispatchId: 'dsp_1',
  provider: 'claude',
  accountId: 'acc_1',
  cwd: 'D:/wt',
  promptConfirmed: true,
  baseHead: 'aaa',
  hasValidateConfig: false,
  appDriven: true,
  ...over
})
const git = (over: Partial<GitFacts> = {}): GitFacts => ({
  exists: true,
  head: 'aaa',
  dirty: false,
  inProgress: null,
  conflicts: false,
  branch: 'feature/x',
  ...over
})
const strategyOf = (a: Partial<LostAttempt>, g: Partial<GitFacts> = {}, smartResume = false): string =>
  decideRecovery({ attempt: attempt(a), git: git(g), smartResume }).strategy

describe('decideRecovery', () => {
  it('never touches an unsafe tree, whatever else is true', () => {
    for (const g of [
      { exists: false },
      { inProgress: 'merge' as const },
      { inProgress: 'rebase' as const },
      { inProgress: 'cherry-pick' as const },
      { inProgress: 'revert' as const },
      { conflicts: true }
    ]) {
      const d = decideRecovery({
        attempt: attempt({ nativeSessionId: 'uuid-a' }),
        git: git(g),
        smartResume: true
      })
      expect(d.strategy).toBe('review')
      expect(d.class).toBe('unsafe')
    }
  })

  it('an unreadable tree stops recovery even with a native session', () => {
    const d = decideRecovery({
      attempt: attempt({ nativeSessionId: 'uuid-a' }),
      git: git({ dirty: null, conflicts: null }),
      smartResume: true
    })
    expect(d.strategy).toBe('review')
    expect(d.class).toBe('review')
  })

  it('an unreadable journal stops recovery, even with a native session', () => {
    for (const over of [{}, { nativeSessionId: 'uuid-a' }]) {
      const d = decideRecovery({
        attempt: attempt({ promptConfirmed: null, ...over }),
        git: git(),
        smartResume: true
      })
      expect(d.strategy).toBe('review')
      expect(d.class).toBe('review')
      expect(d.reason).toContain('journal')
    }
  })

  it('resumes the provider session when there is one', () => {
    expect(strategyOf({ nativeSessionId: 'uuid-a' })).toBe('resume-native')
    // even with a dirty tree and Smart Resume on: native resume comes first (spec 13)
    expect(strategyOf({ nativeSessionId: 'uuid-a' }, { dirty: true }, true)).toBe('resume-native')
  })

  it('sends a moved HEAD to the check, or to a person when there is no check', () => {
    expect(strategyOf({ hasValidateConfig: true }, { head: 'bbb' })).toBe('recheck')
    expect(strategyOf({ hasValidateConfig: false }, { head: 'bbb' })).toBe('review')
  })

  it('an unknown base HEAD is not treated as a moved one', () => {
    expect(strategyOf({ baseHead: null }, { head: 'bbb' })).toBe('redispatch')
  })

  // Source spec 13.3: the Safe re-dispatch row is "no prompt was dispatched AND no worktree changes
  // occurred". One row, two reasons — whichever of the two facts is the one worth telling.
  it('re-dispatches only on a clean tree, and names which of the two reasons it is', () => {
    const never = decideRecovery({
      attempt: attempt({ promptConfirmed: false }),
      git: git({ dirty: false }),
      smartResume: false
    })
    expect(never.strategy).toBe('redispatch')
    expect(never.class).toBe('safe')
    expect(never.reason).toBe('the prompt never left the app, so nothing was started')
    const nothing = decideRecovery({
      attempt: attempt({ promptConfirmed: true }),
      git: git({ dirty: false }),
      smartResume: false
    })
    expect(nothing.strategy).toBe('redispatch')
    expect(nothing.class).toBe('safe')
    expect(nothing.reason).toBe('the worker produced nothing, so restarting it duplicates no work')
  })

  it('a prompt that never left over a dirty tree is unfinished work, not a free restart', () => {
    expect(strategyOf({ promptConfirmed: false }, { dirty: true }, false)).toBe('review')
    expect(strategyOf({ promptConfirmed: false }, { dirty: true }, true)).toBe('smart-resume')
  })

  it('hands over when the tree is dirty and Smart Resume is on, and asks when it is off', () => {
    expect(strategyOf({}, { dirty: true }, true)).toBe('smart-resume')
    const off = decideRecovery({ attempt: attempt(), git: git({ dirty: true }), smartResume: false })
    expect(off.strategy).toBe('review')
    expect(off.class).toBe('review')
  })

  it('a Run the app does not drive only resumes; it never starts work on its own', () => {
    expect(strategyOf({ appDriven: false, nativeSessionId: 'uuid-a' })).toBe('resume-native')
    expect(strategyOf({ appDriven: false, hasValidateConfig: true }, { head: 'bbb' })).toBe('recheck')
    expect(strategyOf({ appDriven: false, promptConfirmed: false })).toBe('review')
    expect(strategyOf({ appDriven: false }, { dirty: true }, true)).toBe('review')
  })

  it('every decision carries a reason', () => {
    for (const d of [
      decideRecovery({ attempt: attempt(), git: git({ conflicts: true }), smartResume: false }),
      decideRecovery({ attempt: attempt({ nativeSessionId: 'x' }), git: git(), smartResume: false }),
      decideRecovery({ attempt: attempt(), git: git(), smartResume: false })
    ])
      expect(d.reason.length).toBeGreaterThan(0)
  })
})
