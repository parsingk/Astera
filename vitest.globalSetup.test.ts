import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import setup, { removeStaleFixtures, STALE_MS } from './vitest.globalSetup'

// The sweep runs against a private folder, never the real temp directory: run against that, the old
// rule this file guards against would delete the fixtures of every test running beside it.
let tmp: string
const savedEnv = { TMP: process.env.TMP, TEMP: process.env.TEMP, TMPDIR: process.env.TMPDIR }
beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'astera-globalsetup-')))
})
afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await fs.rm(tmp, { recursive: true, force: true })
})

const exists = (p: string): Promise<boolean> => fs.stat(p).then(() => true, () => false)

describe('vitest.globalSetup', () => {
  // The reproduction: run A starts, run B starts a moment later and makes its fixtures, A finishes
  // first. A's teardown used to delete B's fixtures while B was still running them.
  it('leaves alone a fixture another run created after this run began', async () => {
    process.env.TMP = process.env.TEMP = process.env.TMPDIR = tmp // os.tmpdir() reads these on each call
    const teardown = await setup()
    const other = path.join(tmp, 'astera-wt-git-otherRun')
    await fs.mkdir(other)
    await fs.writeFile(path.join(other, 'live.txt'), 'x', 'utf8')

    await teardown()

    expect(await exists(path.join(other, 'live.txt'))).toBe(true)
  })

  it('removes only fixture directories older than STALE_MS before the run began', async () => {
    const fixture = path.join(tmp, 'astera-wt-git-old')
    const host = path.join(tmp, 'astera-host-0123456789abcdef') // a live Host's socket folder on macOS/Linux
    const foreign = path.join(tmp, 'someone-else')
    const file = path.join(tmp, 'astera-clipboard-1.txt')
    for (const d of [fixture, host, foreign]) await fs.mkdir(d)
    await fs.writeFile(file, 'x', 'utf8')

    // Birth times cannot be set, so the run's start is moved instead: everything made just now is
    // exactly as old as STALE_MS (not stale), then a little older than that (stale).
    const now = Date.now()
    expect(await removeStaleFixtures(tmp, now + STALE_MS - 5_000)).toBe(0)
    expect(await exists(fixture)).toBe(true)

    expect(await removeStaleFixtures(tmp, now + STALE_MS + 5_000)).toBe(1)
    expect(await exists(fixture)).toBe(false)
    expect(await exists(host)).toBe(true)
    expect(await exists(foreign)).toBe(true)
    expect(await exists(file)).toBe(true)
  })
})
