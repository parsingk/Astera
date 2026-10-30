// The ignored findings (lifecycle design §6): `<profile>/findings-ignored.json`, written by the Host, each key with when
// and an optional note. An ignore holds until it is brought back.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../testFixtures'
import { profilePaths } from '../profile/paths'
import { RepairNeeded } from '../settings/repairNeeded'
import { readIgnored, writeIgnored, type IgnoredFile } from './ignored'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})
const profile = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-findings-ignored-'))
  dirs.push(d)
  return d
}

describe('the ignore file', () => {
  it('round-trips', async () => {
    const p = await profile()
    expect(profilePaths(p).findingsIgnored).toBe(path.join(p, 'findings-ignored.json'))
    const f: IgnoredFile = {
      version: 1,
      ignored: {
        'unused-profile:ap_1': { at: '2026-10-30T00:00:00.000Z', note: 'kept for the demo' },
        'token-spike:run_2': { at: '2026-10-29T00:00:00.000Z' }
      }
    }
    await writeIgnored(p, f)
    expect(await readIgnored(p)).toEqual(f)
  })

  it('missing is empty', async () => {
    expect(await readIgnored(await profile())).toEqual({ version: 1, ignored: {} })
  })

  it('damaged throws RepairNeeded', async () => {
    const damages = [
      '{"version":1,',
      JSON.stringify({ version: 2, ignored: {} }),
      JSON.stringify({ version: 1, ignored: [] }),
      JSON.stringify({ version: 1, ignored: { 'unused-profile:ap_1': { note: 'no time' } } }),
      JSON.stringify({ version: 1, ignored: { 'unused-profile:ap_1': { at: '2026-10-30T00:00:00.000Z', note: 3 } } })
    ]
    for (const damage of damages) {
      const p = await profile()
      const file = profilePaths(p).findingsIgnored
      await fs.writeFile(file, damage)
      const e = await readIgnored(p).catch((x: unknown) => x)
      expect(e, damage).toBeInstanceOf(RepairNeeded)
      expect((e as RepairNeeded).file).toBe('findings-ignored.json')
      // Its bytes are kept beside it, and the file itself is not written over
      expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe(damage)
      expect(await fs.readFile(file, 'utf8')).toBe(damage)
    }
  })
})
