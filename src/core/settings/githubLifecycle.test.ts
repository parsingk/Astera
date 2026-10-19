// The lifecycle's policy defaults in app-settings.json (GitHub lifecycle design §5.1, G7a): set in Settings › GitHub,
// copied into a Job when it is made, each value narrowed on its own so one bad value does not take the others with it.
import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GITHUB_LIFECYCLE_DEFAULTS } from '../github/lifecycle'
import { LIFECYCLE_CI_WAIT_MINUTES, LIFECYCLE_RERUNS, exactGithubLifecycleDefaults, githubLifecycleDefaultsOf } from '../github/lifecycleDefaults'
import { readGitHubLifecycleDefaults } from './githubLifecycle'

describe('githubLifecycleDefaultsOf', () => {
  it('reads nothing, or anything but an object, as the built-in defaults', () => {
    for (const v of [undefined, null, 3, 'x', []]) expect(githubLifecycleDefaultsOf(v)).toEqual(GITHUB_LIFECYCLE_DEFAULTS)
  })

  it('keeps each value that is in its bounds, and puts back the default for each that is not', () => {
    expect(githubLifecycleDefaultsOf({ autoRerunInfrastructureFailures: false, maxInfrastructureReruns: 10, ciWaitMinutes: 10 })).toEqual({
      autoRerunInfrastructureFailures: false,
      maxInfrastructureReruns: 10,
      ciWaitMinutes: 10
    })
    for (const n of [0, 11, 2.5, '3', null]) expect(githubLifecycleDefaultsOf({ maxInfrastructureReruns: n }).maxInfrastructureReruns).toBe(2)
    for (const n of [9, 1441, null, '90']) expect(githubLifecycleDefaultsOf({ ciWaitMinutes: n }).ciWaitMinutes).toBe(90)
    expect(githubLifecycleDefaultsOf({ autoRerunInfrastructureFailures: 'no' }).autoRerunInfrastructureFailures).toBe(true)
    expect(githubLifecycleDefaultsOf({ maxInfrastructureReruns: 0, ciWaitMinutes: 30 })).toEqual({ ...GITHUB_LIFECYCLE_DEFAULTS, ciWaitMinutes: 30 })
  })

  // Reruns are kept to the last 20 on a Run, so a limit of 20 or more would never be reached; the CI wait outlasts the
  // three minutes a pushed head may show no check
  it('has bounds the built-in defaults sit inside', () => {
    expect(LIFECYCLE_RERUNS).toEqual({ min: 1, max: 10 })
    expect(LIFECYCLE_CI_WAIT_MINUTES).toEqual({ min: 10, max: 1440 })
    expect(githubLifecycleDefaultsOf({ ...GITHUB_LIFECYCLE_DEFAULTS })).toEqual(GITHUB_LIFECYCLE_DEFAULTS)
  })
})

// The pane's save: a value is taken whole or not at all, so the pane and the file never disagree about what was set
describe('exactGithubLifecycleDefaults', () => {
  it('takes a value that is all in bounds, and refuses one with anything out of them or missing', () => {
    const mine = { autoRerunInfrastructureFailures: false, maxInfrastructureReruns: 4, ciWaitMinutes: 45 }
    expect(exactGithubLifecycleDefaults(mine)).toEqual(mine)
    expect(exactGithubLifecycleDefaults({ ...mine, maxInfrastructureReruns: 0 })).toBe(null)
    expect(exactGithubLifecycleDefaults({ ...mine, ciWaitMinutes: 9.5 })).toBe(null)
    expect(exactGithubLifecycleDefaults({ maxInfrastructureReruns: 4 })).toBe(null)
    expect(exactGithubLifecycleDefaults('x')).toBe(null)
  })
})

describe('readGitHubLifecycleDefaults', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-ghdefaults-'))
  })

  it('a missing file gives the defaults; a file gives its narrowed values', async () => {
    expect(await readGitHubLifecycleDefaults(path.join(dir, 'app-settings.json'))).toEqual(GITHUB_LIFECYCLE_DEFAULTS)
    await fs.writeFile(path.join(dir, 'app-settings.json'), JSON.stringify({ githubLifecycle: { maxInfrastructureReruns: 4 } }), 'utf8')
    expect(await readGitHubLifecycleDefaults(path.join(dir, 'app-settings.json'))).toEqual({ ...GITHUB_LIFECYCLE_DEFAULTS, maxInfrastructureReruns: 4 })
  })

  // It may have said "do not rerun": a Job made with the defaults instead would rerun what the person turned off
  it('a file that cannot be read throws', async () => {
    await fs.writeFile(path.join(dir, 'app-settings.json'), '{ not json', 'utf8')
    await expect(readGitHubLifecycleDefaults(path.join(dir, 'app-settings.json'))).rejects.toThrow()
  })
})
