import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RateLimitUsage } from '../core/types'
import { AccountUsageStore } from './accountUsageStore'

let dir = ''
let file = ''

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-account-usage-'))
  file = path.join(dir, 'account-usage.json')
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
})

const HOUR = 3_600_000
const NOW = Date.parse('2026-09-02T12:00:00.000Z')

/** An ok reading whose peak rolls two hours from NOW. */
const ok = (over: Partial<RateLimitUsage> = {}): RateLimitUsage => ({
  session: { usedPercent: 78, resetsAt: new Date(NOW + HOUR).toISOString() },
  weekly: { usedPercent: 36, resetsAt: new Date(NOW + 96 * HOUR).toISOString() },
  maxPercent: 78,
  peak: { percent: 78, resetsAt: new Date(NOW + 2 * HOUR).toISOString(), weekly: false },
  status: 'ok',
  ...over
})

describe('AccountUsageStore', () => {
  it('stores a reading and reads it back after a reload', async () => {
    const a = new AccountUsageStore(file, () => NOW)
    await a.load()
    await a.remember('/cfg/main', ok())

    const b = new AccountUsageStore(file, () => NOW)
    await b.load()
    const entry = b.get('/cfg/main')
    expect(entry?.session?.usedPercent).toBe(78)
    expect(entry?.weekly?.usedPercent).toBe(36)
    expect(entry?.readAt).toBe(new Date(NOW).toISOString())
  })

  it('an unknown configDir is null, not a throw', async () => {
    const s = new AccountUsageStore(file, () => NOW)
    await s.load()
    expect(s.get('/cfg/never-seen')).toBeNull()
  })

  // typeof [] === 'object', so an array must be rejected explicitly — the same guard the sibling
  // stores carry.
  it('an invalid schema and an array both fall back to empty', async () => {
    for (const raw of ['{ not json', '[]', 'null', '"a string"']) {
      await fs.writeFile(file, raw, 'utf8')
      const s = new AccountUsageStore(file, () => NOW)
      await s.load()
      expect(s.get('/cfg/main')).toBeNull()
    }
  })

  // §3.2: past the stored resetsAt the window has rolled and the percentage is not even a floor.
  it('an entry past its stored resetsAt is dropped', async () => {
    let clock = NOW
    const s = new AccountUsageStore(file, () => clock)
    await s.load()
    await s.remember('/cfg/main', ok())
    expect(s.get('/cfg/main')).not.toBeNull()

    clock = NOW + 2 * HOUR + 1000 // one second past the peak's reset
    expect(s.get('/cfg/main')).toBeNull()
  })

  it('a dropped entry is not written back on the next persist', async () => {
    let clock = NOW
    const s = new AccountUsageStore(file, () => clock)
    await s.load()
    await s.remember('/cfg/stale', ok())
    clock = NOW + 3 * HOUR
    // ok()'s peak is fixed at NOW + 2h regardless of clock, so a bare ok() here would already be past
    // its own reset by this clock — as stale as '/cfg/stale'. Override so 'fresh' really is fresh.
    await s.remember(
      '/cfg/fresh',
      ok({ peak: { percent: 78, resetsAt: new Date(clock + 2 * HOUR).toISOString(), weekly: false } })
    )

    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
    expect(Object.keys(parsed)).toEqual(['/cfg/fresh'])
  })

  // The whole point of the store: a failing fetch must leave the last good figure standing.
  it('an error or unavailable result leaves the previous entry standing', async () => {
    const s = new AccountUsageStore(file, () => NOW)
    await s.load()
    await s.remember('/cfg/main', ok())

    for (const status of ['error', 'unavailable'] as const) {
      await s.remember('/cfg/main', {
        session: null,
        weekly: null,
        maxPercent: null,
        peak: null,
        status
      })
      expect(s.get('/cfg/main')?.session?.usedPercent).toBe(78)
    }
  })

  // Plan §"Two narrowings" (2): with no reset instant there is no discard arithmetic, so the reading
  // is refused rather than kept forever.
  it('a reading whose peak carries no reset time is refused', async () => {
    const s = new AccountUsageStore(file, () => NOW)
    await s.load()
    await s.remember('/cfg/a', ok({ peak: { percent: 78, resetsAt: null, weekly: false } }))
    await s.remember('/cfg/b', ok({ peak: null }))
    expect(s.get('/cfg/a')).toBeNull()
    expect(s.get('/cfg/b')).toBeNull()
  })

  it('a reading with neither window is refused — there is nothing to draw', async () => {
    const s = new AccountUsageStore(file, () => NOW)
    await s.load()
    await s.remember('/cfg/main', ok({ session: null, weekly: null }))
    expect(s.get('/cfg/main')).toBeNull()
  })

  // A write failure (a locked file, a full disk, an antivirus scanner holding the handle open) must
  // not reach the caller — every caller of remember() fires it unawaited (design doc §9, "usage
  // failures are silent"), and an unhandled rejection there would print to stderr at best and
  // terminate the process at worst (Node 15+). The public surface only: filePath is pointed at a path
  // nested under an existing *file*, so persist()'s fs.mkdir of the parent genuinely fails (ENOTDIR)
  // rather than reaching into a private method.
  it('a persist failure is swallowed and the reading stays readable', async () => {
    const blocker = path.join(dir, 'blocker')
    await fs.writeFile(blocker, 'not a directory', 'utf8')
    const s = new AccountUsageStore(path.join(blocker, 'account-usage.json'), () => NOW)
    await s.load()

    await expect(s.remember('/cfg/main', ok())).resolves.toBeUndefined()
    expect(s.get('/cfg/main')?.session?.usedPercent).toBe(78)
  })

  it('a malformed entry is skipped while its well-formed neighbour survives', async () => {
    await fs.writeFile(
      file,
      JSON.stringify({
        '/cfg/bad': { session: { usedPercent: 'lots' }, peak: {}, readAt: 12 },
        '/cfg/good': {
          session: { usedPercent: 41, resetsAt: null },
          weekly: null,
          peak: { percent: 41, resetsAt: new Date(NOW + HOUR).toISOString(), weekly: false },
          readAt: new Date(NOW).toISOString()
        }
      }),
      'utf8'
    )
    const s = new AccountUsageStore(file, () => NOW)
    await s.load()
    expect(s.get('/cfg/bad')).toBeNull()
    expect(s.get('/cfg/good')?.session?.usedPercent).toBe(41)
  })
})
