// When this release first ran on a profile (plan ruling 2): the start of every history it began recording, so nothing is
// called unused on days nobody recorded (lifecycle design §4).
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../testFixtures'
import { profilePaths } from '../profile/paths'
import { readFindingsSince } from './since'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-10-30T12:00:00.000Z')

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})
const profile = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-findings-since-'))
  dirs.push(d)
  return d
}

describe('readFindingsSince', () => {
  it('writes the stamp once and reads it back', async () => {
    const p = await profile()
    const file = profilePaths(p).findingsHistory
    expect(file).toBe(path.join(p, 'findings-history.json'))
    const first = await readFindingsSince(p, NOW)
    expect(first).toBe(new Date(NOW).toISOString())
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ version: 1, since: first })
    // A later start reads the first stamp, and writes nothing over it
    expect(await readFindingsSince(p, NOW + 5 * DAY)).toBe(first)
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ version: 1, since: first })
  })

  it('a damaged file is kept aside and restamped', async () => {
    for (const damage of ['{"version":1,', JSON.stringify({ version: 1, since: 'yesterday' }), JSON.stringify({ version: 2, since: '2026-01-01T00:00:00.000Z' })]) {
      const p = await profile()
      const file = profilePaths(p).findingsHistory
      await fs.writeFile(file, damage)
      expect(await readFindingsSince(p, NOW)).toBe(new Date(NOW).toISOString())
      expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe(damage)
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ version: 1, since: new Date(NOW).toISOString() })
    }
  })
})
