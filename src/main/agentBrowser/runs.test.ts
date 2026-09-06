import { describe, it, expect } from 'vitest'
import { AgentBrowserRuns, type RunsDeps } from './runs'
import { AgentGuestRegistry } from './registry'
import { Ring } from '../../core/agentBrowser/ring'

type Cb = (...a: unknown[]) => void
const fakeGuest = (id: number) => {
  const once = new Map<string, Set<Cb>>()
  const counts = { reload: 0 }
  const fire = (ev: string): void => { const s = once.get(ev); once.delete(ev); s?.forEach((cb) => cb()) }
  return {
    id, counts, isDestroyed: () => false, getType: () => 'webview',
    async loadURL() { queueMicrotask(() => fire('did-finish-load')) },
    // The load event is an IPC event from the guest in the app, so it lands on a later turn of the
    // event loop and a script looping on reload() yields between iterations. A synchronous fake
    // would starve the timers the deadline is made of and the loop could never be cut off at all.
    reload() { counts.reload += 1; setTimeout(() => fire('did-finish-load'), 0) },
    getURL: () => 'http://localhost:5173/', getTitle: () => 'T', isLoading: () => false,
    once(ev: string, cb: Cb) { (once.get(ev) ?? once.set(ev, new Set()).get(ev)!).add(cb); return this },
    removeListener(ev: string, cb: Cb) { once.get(ev)?.delete(cb); return this }
  }
}

const harness = (opts: { hasSession?: boolean; tabAppears?: boolean; scriptTimeoutMs?: number } = {}) => {
  const g = fakeGuest(7)
  const registry = new AgentGuestRegistry<typeof g>(() => g)
  const calls = { requestTab: [] as string[], busy: [] as boolean[], closed: 0 }
  const deps: RunsDeps = {
    registry: registry as never,
    buffersOf: () => ({ console: new Ring(), network: new Ring(), detach() {} }),
    cwdOf: () => (opts.hasSession === false ? null : 'D:/p'),
    requestTab: (sid, _cwd, url) => {
      calls.requestTab.push(url)
      if (opts.tabAppears !== false) setTimeout(() => registry.register(sid, 7, 'D:/p'), 5)
    },
    closeTab: () => { calls.closed += 1 },
    setBusy: (_s, b) => calls.busy.push(b),
    guide: '# g',
    tabWaitMs: 100,
    scriptTimeoutMs: opts.scriptTimeoutMs
  }
  return { runs: new AgentBrowserRuns(deps), calls, registry, guest: g }
}

/** The script the deadline and Stop tests drive: it never stops asking the tab to reload. */
const FOREVER = `await open('http://localhost:5173/'); while (true) { await reload() }`
const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('AgentBrowserRuns', () => {
  it('404 for a session main does not know', async () => {
    const { runs, calls } = harness({ hasSession: false })
    expect(await runs.run('ghost', 'log(1)')).toEqual({ ok: false, status: 404, error: 'no such session' })
    expect(calls.busy).toEqual([])
  })

  it('creates the tab on the first open, then runs, with busy around it', async () => {
    const { runs, calls } = harness()
    const r = await runs.run('s1', `await open('http://localhost:5173/'); log(await url())`)
    expect(r).toEqual({ ok: true, result: { log: ['http://localhost:5173/'] } })
    expect(calls.requestTab).toEqual(['http://localhost:5173/'])
    expect(calls.busy).toEqual([true, false])
  })

  it('a tab that never appears is a script error at open, not a failed run', async () => {
    const { runs, calls } = harness({ tabAppears: false })
    const r = await runs.run('s1', `await open('http://localhost:5173/')`)
    expect(r).toEqual({ ok: true, result: { log: [], error: { message: 'open: the browser tab did not appear', at: 'open' } } })
    expect(calls.busy).toEqual([true, false])
  })

  it('stop aborts the running script at its helper', async () => {
    const { runs, calls } = harness()
    const p = runs.run('s1', `await open('http://localhost:5173/'); await new Promise(() => {})`)
    await new Promise((r) => setTimeout(r, 20))
    expect(runs.stop('s1')).toBe(true)
    const r = await p
    expect(r.ok && r.result.error).toEqual({ message: 'stopped', at: 'script' })
    expect(calls.busy).toEqual([true, false])
    expect(runs.stop('s1')).toBe(false)
  })

  it('close() through the script closes the tab', async () => {
    const { runs, calls } = harness()
    await runs.run('s1', `await open('http://localhost:5173/'); await close()`)
    expect(calls.closed).toBe(1)
  })

  it('help() stays synchronous through the run, so a script may use it without await', async () => {
    const { runs } = harness()
    const r = await runs.run('s1', `log(typeof help()); log(help())`)
    expect(r).toEqual({ ok: true, result: { log: ['string', '# g'] } })
  })

  // The script body keeps running after the race that ended the run is lost — nothing about losing a
  // race stops an async function. These two pin the only thing that can: every helper call made after
  // the run has ended fails instead of driving the user's page.
  it('a run cut off by its deadline stops driving the tab', async () => {
    const { runs, guest } = harness({ scriptTimeoutMs: 150 })
    const r = await runs.run('s1', FOREVER)
    expect(r.ok && r.result.error?.at).toBe('timeout')
    const atReturn = guest.counts.reload
    expect(atReturn).toBeGreaterThan(0) // it really was looping when the deadline hit
    await settle(100)
    expect(guest.counts.reload).toBe(atReturn)
  })

  it('a run cut off by stop() stops driving the tab', async () => {
    const { runs, guest } = harness()
    const p = runs.run('s1', FOREVER)
    await settle(30)
    expect(runs.stop('s1')).toBe(true)
    const r = await p
    expect(r.ok && r.result.error?.message).toBe('stopped')
    const atReturn = guest.counts.reload
    expect(atReturn).toBeGreaterThan(0)
    await settle(100)
    expect(guest.counts.reload).toBe(atReturn)
  })

  it('409 for a second run while one is in flight; the first still completes', async () => {
    const { runs, registry, calls } = harness({ tabAppears: false })      // the tab never appears → the first run waits tabWaitMs
    const first = runs.run('s1', `await open('http://localhost:5173/')`)
    const second = await runs.run('s1', `log(2)`)
    expect(second).toEqual({ ok: false, status: 409, error: 'a script is already running' })
    const r = await first
    expect(r.ok && r.result.error?.at).toBe('open')
    expect(registry.has('s1')).toBe(false)
    expect(calls.busy).toEqual([true, false])
  })
})
