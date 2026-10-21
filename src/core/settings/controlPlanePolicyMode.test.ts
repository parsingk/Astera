// Agent Control Plane release 1 (design §4.8): the policy mode is one app-settings key; missing, unknown or absent file
// all read as COMPATIBILITY, the only mode release 1 uses.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../testFixtures'
import { controlPlanePolicyModeOf, readControlPlanePolicyMode } from './controlPlanePolicyMode'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})

describe('controlPlanePolicyMode', () => {
  it('narrows to a known mode, else compatibility', () => {
    expect(controlPlanePolicyModeOf('observe')).toBe('observe')
    expect(controlPlanePolicyModeOf('enforce')).toBe('enforce')
    expect(controlPlanePolicyModeOf(undefined)).toBe('compatibility')
    expect(controlPlanePolicyModeOf('strict')).toBe('compatibility')
  })

  it('reads compatibility from a missing file and the key from a present one', async () => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-policymode-'))
    dirs.push(d)
    const f = path.join(d, 'app-settings.json')
    expect(await readControlPlanePolicyMode(f)).toBe('compatibility')
    await fs.writeFile(f, JSON.stringify({ controlPlanePolicyMode: 'observe' }))
    expect(await readControlPlanePolicyMode(f)).toBe('observe')
  })
})
