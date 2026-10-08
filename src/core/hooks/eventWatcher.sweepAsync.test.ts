// Second pass C2-7: the hook watcher's ten-second sweep checked its folder with a synchronous access and stat on the app's
// (or the Host's) one thread, the check the first pass took off every other watcher's sweep.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const syncChecks = vi.hoisted(() => ({ n: 0 }))
vi.mock('../files/watchedDir', async (orig) => {
  const actual = await orig<typeof import('../files/watchedDir')>()
  return {
    ...actual,
    dirIdentity: (dir: string) => {
      syncChecks.n++
      return actual.dirIdentity(dir)
    }
  }
})

import { HookEventWatcher } from './eventWatcher'

let dir: string | null = null
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = null
})

describe('HookEventWatcher sweep', () => {
  it('checks its folder without a synchronous read', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'astera-hook-sweep-'))
    const w = new HookEventWatcher(dir, () => {}, () => {}, 60_000)
    w.start()
    syncChecks.n = 0
    await w.sweep()
    await w.sweep()
    w.stop()
    expect(syncChecks.n).toBe(0)
  })
})
