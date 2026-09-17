import { describe, it, expect } from 'vitest'
import { memoiseLoginStatus } from './loginStatusCache'

/** A probe that records every id it is asked about and hands back a promise the test resolves itself. */
function manualProbe(): {
  probe: (id: string) => Promise<boolean>
  calls: string[]
  settle: (id: string, value: boolean) => void
  reject: (id: string, err: unknown) => void
} {
  const calls: string[] = []
  const pending = new Map<string, { ok: (v: boolean) => void; fail: (e: unknown) => void }>()
  return {
    calls,
    probe: (id) => {
      calls.push(id)
      return new Promise<boolean>((ok, fail) => pending.set(id, { ok, fail }))
    },
    settle: (id, value) => pending.get(id)?.ok(value),
    reject: (id, err) => pending.get(id)?.fail(err)
  }
}

describe('memoiseLoginStatus', () => {
  it('answers from the cache inside the TTL without asking the probe again', async () => {
    const p = manualProbe()
    let now = 1_000
    const cached = memoiseLoginStatus(p.probe, { ttlMs: 10_000, now: () => now })
    const first = cached('a1')
    p.settle('a1', false)
    expect(await first).toBe(false)
    now += 9_999
    expect(await cached('a1')).toBe(false)
    expect(p.calls).toEqual(['a1']) // the second ask never reached the probe
  })

  it('asks the probe again once the TTL has expired', async () => {
    const p = manualProbe()
    let now = 1_000
    const cached = memoiseLoginStatus(p.probe, { ttlMs: 10_000, now: () => now })
    const first = cached('a1')
    p.settle('a1', false)
    await first
    now += 10_000 // exactly at the TTL is already expired — the entry is worth ttlMs, not ttlMs + 1
    const second = cached('a1')
    p.settle('a1', true)
    expect(await second).toBe(true)
    expect(p.calls).toEqual(['a1', 'a1'])
  })

  it('shares one probe call between two concurrent misses for the same id', async () => {
    const p = manualProbe()
    const cached = memoiseLoginStatus(p.probe, { ttlMs: 10_000, now: () => 1_000 })
    const a = cached('a1')
    const b = cached('a1')
    p.settle('a1', true)
    expect(await a).toBe(true)
    expect(await b).toBe(true)
    expect(p.calls).toEqual(['a1']) // one round trip, two callers
  })

  it('keeps ids apart', async () => {
    const p = manualProbe()
    const cached = memoiseLoginStatus(p.probe, { ttlMs: 10_000, now: () => 1_000 })
    const a = cached('a1')
    const b = cached('a2')
    p.settle('a1', true)
    p.settle('a2', false)
    expect([await a, await b]).toEqual([true, false])
    expect(p.calls).toEqual(['a1', 'a2'])
  })

  // A rejection is not a verdict. Caching one would hold "we could not tell" for the whole TTL, and the
  // coordinators translate a failed probe into "logged in" (catch(() => true)) precisely so a broken
  // probe never strands a chain — that decision belongs to the caller, on every ask.
  it('does not cache a rejected probe', async () => {
    const p = manualProbe()
    const cached = memoiseLoginStatus(p.probe, { ttlMs: 10_000, now: () => 1_000 })
    const first = cached('a1')
    p.reject('a1', new Error('probe blew up'))
    await expect(first).rejects.toThrow('probe blew up')
    const second = cached('a1') // same instant, still inside the TTL
    p.settle('a1', true)
    expect(await second).toBe(true)
    expect(p.calls).toEqual(['a1', 'a1'])
  })
})
