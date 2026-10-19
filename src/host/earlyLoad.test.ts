// GitHub lifecycle G6 (design §6.3 S5, L15): a Remote Host with no app attached loads its state after ten seconds, so a
// CI wait in its file resumes after a restart with no client.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { armEarlyLoad, EARLY_LOAD_MS } from './earlyLoad'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const rig = (o: { remote?: boolean; app?: boolean } = {}) => {
  const flags = { remote: o.remote ?? true, app: o.app ?? false }
  const load = vi.fn(async () => {})
  const logs: string[] = []
  const armed = armEarlyLoad({ remoteEnabled: () => flags.remote, hasApp: () => flags.app, load, log: (m) => logs.push(m) })
  return { flags, load, logs, armed }
}

describe('armEarlyLoad', () => {
  it('loads once after ten seconds when Remote is on and no app is attached', async () => {
    const r = rig()
    await vi.advanceTimersByTimeAsync(EARLY_LOAD_MS - 1)
    expect(r.load).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(r.load).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10 * EARLY_LOAD_MS)
    expect(r.load).toHaveBeenCalledTimes(1)
  })

  it('does not load when an app is attached by then, or when Remote is off', async () => {
    const withApp = rig({ app: true })
    const local = rig({ remote: false })
    await vi.advanceTimersByTimeAsync(EARLY_LOAD_MS)
    expect(withApp.load).not.toHaveBeenCalled()
    expect(local.load).not.toHaveBeenCalled()
  })

  it('reads the flags when it fires, not when it is armed', async () => {
    const r = rig({ remote: false })
    r.flags.remote = true
    await vi.advanceTimersByTimeAsync(EARLY_LOAD_MS)
    expect(r.load).toHaveBeenCalledTimes(1)
  })

  it('a failed load is logged, never thrown', async () => {
    const logs: string[] = []
    armEarlyLoad({ remoteEnabled: () => true, hasApp: () => false, load: async () => { throw new Error('disk') }, log: (m) => logs.push(m) })
    await vi.advanceTimersByTimeAsync(EARLY_LOAD_MS)
    expect(logs.join('\n')).toMatch(/early load failed: Error: disk/)
  })

  it('cancel stops it', async () => {
    const r = rig()
    r.armed.cancel()
    await vi.advanceTimersByTimeAsync(EARLY_LOAD_MS)
    expect(r.load).not.toHaveBeenCalled()
  })
})
