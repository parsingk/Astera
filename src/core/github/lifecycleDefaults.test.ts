// The GitHub lifecycle defaults' narrowing, and the run report switch (run report C4).
import { describe, it, expect } from 'vitest'
import { GITHUB_LIFECYCLE_DEFAULTS, postsRunReport } from './lifecycle'
import { exactGithubLifecycleDefaults, githubLifecycleDefaultsOf } from './lifecycleDefaults'

describe('postRunReport', () => {
  it('is on in the defaults, and kept by the narrowing when a boolean, else the default', () => {
    expect(GITHUB_LIFECYCLE_DEFAULTS.postRunReport).toBe(true)
    expect(githubLifecycleDefaultsOf({}).postRunReport).toBe(true)
    expect(githubLifecycleDefaultsOf({ postRunReport: false }).postRunReport).toBe(false)
    expect(githubLifecycleDefaultsOf({ postRunReport: 'yes' }).postRunReport).toBe(true)
  })
  it('is refused by the exact reading when it is not a boolean', () => {
    const ok = { ...GITHUB_LIFECYCLE_DEFAULTS }
    expect(exactGithubLifecycleDefaults(ok)).toEqual(ok)
    expect(exactGithubLifecycleDefaults({ ...ok, postRunReport: false })).toEqual({ ...ok, postRunReport: false })
    expect(exactGithubLifecycleDefaults({ ...ok, postRunReport: 'yes' })).toBeNull()
  })
})

describe('postsRunReport', () => {
  const policy = { ci: { mode: 'required' as const }, ...GITHUB_LIFECYCLE_DEFAULTS }
  it('reads a Job with no policy, or a policy without the field, as off', () => {
    const { postRunReport: _p, ...without } = policy
    expect(postsRunReport(undefined)).toBe(false)
    expect(postsRunReport(without)).toBe(false)
    expect(postsRunReport({ ...policy, postRunReport: true })).toBe(true)
    expect(postsRunReport({ ...policy, postRunReport: false })).toBe(false)
  })
})
