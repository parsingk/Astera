import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Account, AccountUsage, RateLimitUsage } from '../core/types'
import { AccountUsageStore } from './accountUsageStore'
import { createAccountUsage } from './accountUsage'
import { TTL_OK_MS } from './usage'

const HOUR = 3_600_000
const NOW = Date.parse('2026-09-02T12:00:00.000Z')

let dir = ''
let store: AccountUsageStore

const account = (label: string, configDir: string, provider?: 'claude' | 'codex'): Account => ({
  id: label,
  label,
  configDir,
  color: '#5b8dd9',
  createdAt: new Date(NOW).toISOString(),
  ...(provider ? { provider } : {})
})

const ok = (percent: number): RateLimitUsage => ({
  session: { usedPercent: percent, resetsAt: new Date(NOW + HOUR).toISOString() },
  weekly: { usedPercent: 36, resetsAt: new Date(NOW + 96 * HOUR).toISOString() },
  maxPercent: percent,
  peak: { percent, resetsAt: new Date(NOW + 2 * HOUR).toISOString(), weekly: false },
  status: 'ok'
})

const failed: RateLimitUsage = {
  session: null,
  weekly: null,
  maxPercent: null,
  peak: null,
  status: 'unavailable'
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-account-usage-svc-'))
  store = new AccountUsageStore(path.join(dir, 'account-usage.json'), () => NOW)
  await store.load()
})

afterEach(async () => {
  vi.useRealTimers()
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
})

/** A service over a fetcher whose answer per configDir is scripted. */
function harness(accounts: Account[], answers: Record<string, RateLimitUsage>) {
  const sent: Record<string, AccountUsage>[] = []
  const calls: string[] = []
  const svc = createAccountUsage({
    accounts: { list: () => accounts },
    fetcher: {
      get: async (configDir) => {
        calls.push(configDir)
        return answers[configDir] ?? failed
      }
    },
    store,
    send: (_channel, payload) => sent.push(payload)
  })
  return { svc, sent, calls }
}

describe('createAccountUsage', () => {
  it('a successful fetch is stored and comes back undimmed', async () => {
    const { svc, sent } = harness([account('main', '/cfg/main')], { '/cfg/main': ok(78) })
    await svc.tick()
    expect(svc.usage()['/cfg/main']).toMatchObject({
      session: { usedPercent: 78 },
      weekly: { usedPercent: 36 },
      remembered: false
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]['/cfg/main'].remembered).toBe(false)
  })

  // The core of §3: an idle account fails every request, and the remembered figure is what the row
  // draws — dimmed, so the person can see it is not live.
  it('a failed fetch falls back to the stored reading, dimmed', async () => {
    const accounts = [account('main', '/cfg/main')]
    const first = harness(accounts, { '/cfg/main': ok(78) })
    await first.svc.tick()

    const second = harness(accounts, {}) // every answer is now 'unavailable'
    await second.svc.tick()
    expect(second.svc.usage()['/cfg/main']).toMatchObject({
      session: { usedPercent: 78 },
      remembered: true
    })
  })

  it('an account with no stored reading and a failing fetch is absent from the map', async () => {
    const { svc } = harness([account('spare', '/cfg/spare')], {})
    await svc.tick()
    expect(svc.usage()['/cfg/spare']).toBeUndefined()
  })

  // Codex usage is out of scope (§1). A skipped account is absent, which the row reads as "draw
  // nothing" — and, just as importantly, its configDir is never sent to Anthropic's endpoint.
  it('a codex account is neither fetched nor listed', async () => {
    const { svc, calls } = harness(
      [account('main', '/cfg/main'), account('cdx', '/cfg/cdx', 'codex')],
      { '/cfg/main': ok(12), '/cfg/cdx': ok(50) }
    )
    await svc.tick()
    expect(calls).toEqual(['/cfg/main'])
    expect(svc.usage()['/cfg/cdx']).toBeUndefined()
  })

  it('an account with no provider field counts as claude', async () => {
    const { svc, calls } = harness([account('legacy', '/cfg/legacy')], { '/cfg/legacy': ok(5) })
    await svc.tick()
    expect(calls).toEqual(['/cfg/legacy'])
  })

  it('two accounts sharing a configDir are fetched once', async () => {
    const { svc, calls } = harness(
      [account('a', '/cfg/shared'), account('b', '/cfg/shared')],
      { '/cfg/shared': ok(30) }
    )
    await svc.tick()
    expect(calls).toEqual(['/cfg/shared'])
  })

  // "ok" is not the same as "stored": remember() refuses a reading it cannot date, and an undimmed
  // figure with nothing behind it would be a lie about how fresh it is.
  it('an ok reading the store refuses is not reported as live', async () => {
    const undatable: RateLimitUsage = { ...ok(78), peak: { percent: 78, resetsAt: null, weekly: false } }
    const { svc } = harness([account('main', '/cfg/main')], { '/cfg/main': undatable })
    await svc.tick()
    expect(svc.usage()['/cfg/main']).toBeUndefined()
  })

  it('a fetcher that throws is survived and the account falls back', async () => {
    const accounts = [account('main', '/cfg/main')]
    await harness(accounts, { '/cfg/main': ok(64) }).svc.tick()

    const sent: Record<string, AccountUsage>[] = []
    const svc = createAccountUsage({
      accounts: { list: () => accounts },
      fetcher: {
        get: () => Promise.reject(new Error('boom'))
      },
      store,
      send: (_c, payload) => sent.push(payload)
    })
    await svc.tick()
    expect(svc.usage()['/cfg/main']?.remembered).toBe(true)
    expect(sent).toHaveLength(1)
  })

  it('subscribe fetches immediately and starts the tick; unsubscribe stops it', async () => {
    vi.useFakeTimers()
    // TTL_OK_MS (5 minutes) is compressed to zero real wall-clock time here, but
    // AccountUsageStore.persist() still performs a real disk write, and remember() awaits it
    // before tick() releases its inFlight guard — a race the fake clock cannot win against
    // unfaked disk I/O. Stubbed so only the in-memory bookkeeping every assertion below actually
    // reads (the real Task 1 Map/expiry/peak logic) is on the critical path.
    vi.spyOn(store as unknown as { persist(): Promise<void> }, 'persist').mockResolvedValue(undefined)
    const { svc, calls } = harness([account('main', '/cfg/main')], { '/cfg/main': ok(11) })

    svc.subscribe()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1) // the mount fetch

    await vi.advanceTimersByTimeAsync(TTL_OK_MS)
    expect(calls).toHaveLength(2)

    svc.unsubscribe()
    await vi.advanceTimersByTimeAsync(TTL_OK_MS * 3)
    expect(calls).toHaveLength(2) // a panel nobody is looking at spends no requests
  })

  it('the tick keeps running while a second subscriber is still mounted', async () => {
    vi.useFakeTimers()
    // TTL_OK_MS (5 minutes) is compressed to zero real wall-clock time here, but
    // AccountUsageStore.persist() still performs a real disk write, and remember() awaits it
    // before tick() releases its inFlight guard — a race the fake clock cannot win against
    // unfaked disk I/O. Stubbed so only the in-memory bookkeeping every assertion below actually
    // reads (the real Task 1 Map/expiry/peak logic) is on the critical path.
    vi.spyOn(store as unknown as { persist(): Promise<void> }, 'persist').mockResolvedValue(undefined)
    const { svc, calls } = harness([account('main', '/cfg/main')], { '/cfg/main': ok(11) })
    svc.subscribe()
    svc.subscribe()
    await vi.advanceTimersByTimeAsync(0)
    const afterMounts = calls.length

    svc.unsubscribe()
    await vi.advanceTimersByTimeAsync(TTL_OK_MS)
    expect(calls.length).toBeGreaterThan(afterMounts)

    svc.unsubscribe()
    const afterStop = calls.length
    await vi.advanceTimersByTimeAsync(TTL_OK_MS * 2)
    expect(calls).toHaveLength(afterStop)
  })

  it('stop clears the tick however many subscribers were counted', async () => {
    vi.useFakeTimers()
    // TTL_OK_MS (5 minutes) is compressed to zero real wall-clock time here, but
    // AccountUsageStore.persist() still performs a real disk write, and remember() awaits it
    // before tick() releases its inFlight guard — a race the fake clock cannot win against
    // unfaked disk I/O. Stubbed so only the in-memory bookkeeping every assertion below actually
    // reads (the real Task 1 Map/expiry/peak logic) is on the critical path.
    vi.spyOn(store as unknown as { persist(): Promise<void> }, 'persist').mockResolvedValue(undefined)
    const { svc, calls } = harness([account('main', '/cfg/main')], { '/cfg/main': ok(11) })
    svc.subscribe()
    svc.subscribe()
    await vi.advanceTimersByTimeAsync(0)
    const mounted = calls.length

    svc.stop()
    await vi.advanceTimersByTimeAsync(TTL_OK_MS * 3)
    expect(calls).toHaveLength(mounted)
  })
})
