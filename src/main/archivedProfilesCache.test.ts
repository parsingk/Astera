// Lifecycle design §5: the app's Jobs view says which archived agent profiles a schedule waits on. Its fold is
// synchronous and runs on every commit, so it reads the profiles last read; they are read again lazily, never on a timer.
import { describe, it, expect } from 'vitest'
import { ARCHIVED_REREAD_MS, createArchivedProfilesCache } from './archivedProfilesCache'
import type { AgentProfile } from '../core/agentProfiles/types'

const T = '2026-10-30T00:00:00.000Z'
const profile = (id: string, status: AgentProfile['status'], name = id): AgentProfile => ({
  id, name, status, accountIds: ['acc_1'], mcpExclude: [], permission: 'inherit', sandbox: false, createdAt: T, updatedAt: T
})

/** A reader whose reads each wait for the test to answer them, a clock the test moves, and what the cache said. */
function rig() {
  const pending: Array<{ answer: (p: AgentProfile[]) => void; fail: (e: Error) => void }> = []
  const h = { clock: 1_000_000, changes: 0, logs: [] as string[] }
  const cache = createArchivedProfilesCache({
    read: () =>
      new Promise<AgentProfile[]>((answer, fail) => {
        pending.push({ answer, fail })
      }),
    nowMs: () => h.clock,
    onChange: () => {
      h.changes += 1
    },
    log: (l) => h.logs.push(l)
  })
  /** Lets the awaits after an answer run. */
  const settle = (): Promise<void> => new Promise<void>((r) => setImmediate(r))
  return { h, cache, pending, settle }
}

describe('createArchivedProfilesCache', () => {
  it('the fold reads the profiles last read, and starts one re-read once they are older than the window', async () => {
    const { h, cache, pending, settle } = rig()
    // Nothing read yet: none, and a read starts
    expect(cache.profiles()).toEqual([])
    expect(pending).toHaveLength(1)
    // A second fold while that read is out starts no other
    cache.profiles()
    expect(pending).toHaveLength(1)
    pending[0].answer([profile('ap_1', 'archived')])
    await settle()
    expect(cache.profiles().map((p) => p.id)).toEqual(['ap_1'])
    // Inside the window: no read
    h.clock += ARCHIVED_REREAD_MS - 1
    cache.profiles()
    expect(pending).toHaveLength(1)
    // Past it: one read, and the fold still answers with what it has meanwhile
    h.clock += 2
    expect(cache.profiles().map((p) => p.id)).toEqual(['ap_1'])
    cache.profiles()
    expect(pending).toHaveLength(2)
  })

  it('pushes again when a re-read changes the archived set, and only then', async () => {
    const { h, cache, pending, settle } = rig()
    cache.profiles()
    pending[0].answer([profile('ap_1', 'active')])
    await settle()
    // Nothing archived before or after: nothing to push
    expect(h.changes).toBe(0)
    void cache.refresh()
    pending[1].answer([profile('ap_1', 'archived')])
    await settle()
    expect(h.changes).toBe(1)
    // The same set again, an active profile renamed: nothing on screen changes
    void cache.refresh()
    pending[2].answer([profile('ap_1', 'archived'), profile('ap_2', 'active', 'renamed')])
    await settle()
    expect(h.changes).toBe(1)
    // An archived profile renamed changes what the row says
    void cache.refresh()
    pending[3].answer([profile('ap_1', 'archived', 'p1 renamed')])
    await settle()
    expect(h.changes).toBe(2)
    // Restored
    void cache.refresh()
    pending[4].answer([profile('ap_1', 'active')])
    await settle()
    expect(h.changes).toBe(3)
  })

  it("refresh reads at once after the app's own change, and once more when asked while a read is out", async () => {
    const { cache, pending, settle } = rig()
    cache.profiles()
    pending[0].answer([])
    await settle()
    // Inside the window, the app archived a profile: read now
    const first = cache.refresh()
    expect(pending).toHaveLength(2)
    // Asked again while that read is out (it may have started before the write): one more read after it, and the
    // promise the second caller holds settles only once that one has answered
    let secondDone = false
    const second = cache.refresh().then(() => {
      secondDone = true
    })
    expect(pending).toHaveLength(2)
    pending[1].answer([])
    await settle()
    expect(pending).toHaveLength(3)
    expect(secondDone).toBe(false)
    pending[2].answer([profile('ap_1', 'archived')])
    await Promise.all([first, second])
    expect(secondDone).toBe(true)
    expect(cache.profiles().map((p) => p.id)).toEqual(['ap_1'])
  })

  it('a store that cannot be read counts as no archived profiles, said once until it reads again', async () => {
    const { h, cache, pending, settle } = rig()
    cache.profiles()
    pending[0].answer([profile('ap_1', 'archived')])
    await settle()
    expect(h.changes).toBe(1)
    void cache.refresh()
    pending[1].fail(new Error('agent-profiles.json is damaged'))
    await settle()
    expect(cache.profiles()).toEqual([])
    expect(h.changes).toBe(2)
    void cache.refresh()
    pending[2].fail(new Error('agent-profiles.json is damaged'))
    await settle()
    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]).toContain('agent-profiles.json is damaged')
    // It reads again, then fails again: said again. A failed read never rejects the refresh
    const read = cache.refresh()
    pending[3].answer([])
    await expect(read).resolves.toBeUndefined()
    const failed = cache.refresh()
    pending[4].fail(new Error('locked'))
    await expect(failed).resolves.toBeUndefined()
    expect(h.logs).toHaveLength(2)
  })
})
