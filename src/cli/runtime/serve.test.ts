import { describe, it, expect } from 'vitest'
import { runServe, type ServeDeps } from './serve'
import type { RemoteSettings } from '../../core/remote/settings'

/**
 * A fake machine for `serve`: each step of the loop sleeps through `sleep`, which records the wait and, after
 * `stopAfter` sleeps, delivers SIGTERM. A Host child exits with the codes the test lines up.
 */
const rig = (o: { enabled?: boolean; hostAnswers?: boolean[]; exits?: Array<number | null>; hold?: boolean; stopAfter?: number }) => {
  const waits: number[] = []
  const events: string[] = []
  const answers = [...(o.hostAnswers ?? [])]
  const exits = [...(o.exits ?? [])]
  let onSignal: (() => void) | null = null
  let children = 0
  const deps: ServeDeps = {
    settings: async (): Promise<RemoteSettings> => ({ enabled: o.enabled ?? true, listen: '127.0.0.1', port: 47831 }),
    hold: () => o.hold ?? false,
    hostAnswers: async () => answers.shift() ?? false,
    startHostChild: () => {
      children++
      events.push('start')
      const code = exits.length > 0 ? exits.shift()! : 'never'
      let kill!: () => void
      const wait = new Promise<number | null>((resolve) => {
        kill = () => resolve(null)
        if (code !== 'never') setImmediate(() => resolve(code as number | null))
      })
      return {
        wait,
        kill: (signal) => {
          events.push(`kill:${signal}`)
          kill()
        }
      }
    },
    sleep: async (ms) => {
      waits.push(ms)
      if (waits.length >= (o.stopAfter ?? 5)) onSignal?.()
      await new Promise((r) => setImmediate(r))
    },
    onSignal: (fn) => {
      onSignal = fn
    },
    now: () => 0,
    log: (m) => events.push(`log:${m}`)
  }
  return { deps, waits, events, children: () => children, signal: () => onSignal?.() }
}

describe('astera runtime serve (remote runtime design §2.9, X1-13)', () => {
  it('starts no Host while Remote is off, and looks again every 10 s', async () => {
    const r = rig({ enabled: false, stopAfter: 3 })
    expect(await runServe(r.deps)).toBe(0)
    expect(r.children()).toBe(0)
    expect(r.waits).toEqual([10_000, 10_000, 10_000])
  })
  it('watches a Host someone else started instead of starting a second', async () => {
    const r = rig({ hostAnswers: [true, true], stopAfter: 2 })
    await runServe(r.deps)
    expect(r.children()).toBe(0)
    expect(r.waits).toEqual([10_000, 10_000])
  })
  it('restarts a crashing Host child after 1, 2, 5 then 30 seconds', async () => {
    const r = rig({ exits: [3, 3, 3, 3], stopAfter: 4 })
    await runServe(r.deps)
    expect(r.children()).toBe(4)
    expect(r.waits).toEqual([1_000, 2_000, 5_000, 30_000])
  })
  it('a Host child that lost the bind race (exit 0) is followed by watching, with no backoff', async () => {
    const r = rig({ exits: [0], hostAnswers: [false, true], stopAfter: 1 })
    await runServe(r.deps)
    expect(r.children()).toBe(1)
    expect(r.waits).toEqual([10_000])
  })
  it('starts no Host while an update hold is valid', async () => {
    const r = rig({ hold: true, stopAfter: 2 })
    await runServe(r.deps)
    expect(r.children()).toBe(0)
  })
  it('forwards SIGTERM to its Host child and exits 0 (it has no way to write the setting at all)', async () => {
    const r = rig({ stopAfter: 99 })
    const done = runServe(r.deps)
    await new Promise((x) => setImmediate(x))
    await new Promise((x) => setImmediate(x))
    expect(r.children()).toBe(1)
    r.signal()
    expect(await done).toBe(0)
    expect(r.events).toContain('kill:SIGTERM')
  })
})
