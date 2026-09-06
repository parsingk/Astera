import { describe, it, expect, vi } from 'vitest'
import { AgentBrowserRuns, devServersFor, type RunsDeps } from './runs'
import { AgentGuestRegistry } from './registry'
import { Ring } from '../../core/agentBrowser/ring'

type Cb = (...a: unknown[]) => void
const fakeGuest = (id: number) => {
  const once = new Map<string, Set<Cb>>()
  const counts = { reload: 0 }
  // Seams for the tests that have to end a run *while the script is driving the tab*. Ending it on a
  // clock instead makes "it was still looping" a race that a loaded machine loses; hanging the cut-off
  // on the tab's own activity makes it a precondition. Both run after the load event is scheduled, so
  // a stop posted from one lands on a turn where the helper it interrupts has already returned.
  const hooks: { afterLoad?: () => void; afterReload?: (n: number) => void } = {}
  const fire = (ev: string): void => { const s = once.get(ev); once.delete(ev); s?.forEach((cb) => cb()) }
  return {
    id, counts, hooks, isDestroyed: () => false, getType: () => 'webview',
    async loadURL() { queueMicrotask(() => fire('did-finish-load')); hooks.afterLoad?.() },
    // The load event is an IPC event from the guest in the app, so it lands on a later turn of the
    // event loop and a script looping on reload() yields between iterations. A synchronous fake
    // would starve the timers the deadline is made of and the loop could never be cut off at all.
    // 1 ms, not 0. Under fake timers a zero-delay timer created during a tick is scheduled at
    // `now + 1` by the clock library anyway, so a loop of these advances virtual time either way —
    // but relying on that would put the deadline test's termination on undocumented internals, and
    // the way it would fail is by hanging the worker rather than going red.
    reload() { counts.reload += 1; setTimeout(() => fire('did-finish-load'), 1); hooks.afterReload?.(counts.reload) },
    getURL: () => 'http://localhost:5173/', getTitle: () => 'T', isLoading: () => false,
    once(ev: string, cb: Cb) { (once.get(ev) ?? once.set(ev, new Set()).get(ev)!).add(cb); return this },
    removeListener(ev: string, cb: Cb) { once.get(ev)?.delete(cb); return this }
  }
}

const harness = (opts: { devServers?: { name: string; url: string; preview: boolean }[]; hasSession?: boolean; tabAppears?: boolean; scriptTimeoutMs?: number } = {}) => {
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
    devServersOf: () => opts.devServers ?? [],
    guide: '# g',
    tabWaitMs: 100,
    scriptTimeoutMs: opts.scriptTimeoutMs
  }
  return { runs: new AgentBrowserRuns(deps), calls, registry, guest: g }
}

/** The script the deadline and Stop tests drive: it never stops asking the tab to reload. */
const FOREVER = `await open('http://localhost:5173/'); while (true) { await reload() }`
/** The same loop, written the way an agent asking for "retry, ignoring errors" would write it. */
const FOREVER_CATCHING = `await open('http://localhost:5173/'); while (true) { try { await reload() } catch {} }`
const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** Ten turns of the macrotask queue. One iteration of a loop on reload() costs exactly one
 *  one short timer in the fake, so this is ten chances for a still-live loop to bump the count —
 *  a budget that, unlike a millisecond one, does not shrink on a slow machine. */
const tenTurns = async (): Promise<void> => { for (let i = 0; i < 10; i++) await settle(0) }

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
    const { runs, calls, guest } = harness()
    // `at: 'script'` is the assertion, so the stop has to land *after* open() has returned. A timer
    // posted from the load the fake has just accepted does: the load ends on a microtask, so the
    // script is back on its own await before this turn of the event loop comes round.
    let stopped: boolean | undefined
    guest.hooks.afterLoad = () => setTimeout(() => { stopped = runs.stop('s1') }, 0)
    const r = await runs.run('s1', `await open('http://localhost:5173/'); await new Promise(() => {})`)
    expect(stopped).toBe(true)
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
  // race stops an async function. These pin the only thing that can: every helper call made after the
  // run has ended parks instead of driving the user's page.
  it('a run cut off by its deadline stops driving the tab', async () => {
    // Fake timers, because the deadline is the one cut-off the tab cannot trigger itself. Wall clock
    // would be a race: the 150 ms has to land on a loop that is still running. `advanceTimersByTimeAsync`
    // fires timers in due order and drains microtasks between each, which is the interleaving the real
    // path has — and `queueMicrotask`, which the fake's loadURL uses, is not faked, so open() still
    // resolves on its own.
    vi.useFakeTimers()
    try {
      const { runs, guest } = harness({ scriptTimeoutMs: 150 })
      const p = runs.run('s1', FOREVER)
      await vi.advanceTimersByTimeAsync(200)
      const r = await p
      expect(r.ok && r.result.error?.at).toBe('timeout')
      const atReturn = guest.counts.reload
      expect(atReturn).toBeGreaterThan(0) // it really was looping when the deadline hit
      await vi.advanceTimersByTimeAsync(200)
      expect(guest.counts.reload).toBe(atReturn)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a run cut off by stop() stops driving the tab', async () => {
    const { runs, guest } = harness()
    // Stopped from the tab's third reload, so "it was looping when the run ended" is a precondition
    // of the test rather than something a slow machine can lose.
    guest.hooks.afterReload = (n) => { if (n === 3) runs.stop('s1') }
    const r = await runs.run('s1', FOREVER)
    expect(r.ok && r.result.error?.message).toBe('stopped')
    const atReturn = guest.counts.reload
    expect(atReturn).toBeGreaterThanOrEqual(3)
    await tenTurns()
    expect(guest.counts.reload).toBe(atReturn)
  })

  // The catching loop is the dangerous shape, not an exotic one: "retry the reload, ignoring errors"
  // is a plausible thing for an agent to write. A helper that *fails* once the run is over gives that
  // loop no suspension point at all — neither a synchronous throw nor a rejected promise yields the
  // thread back — so the abandoned body would spin the main process flat: no IPC, no UI, no recovery.
  it('an abandoned catching loop stops driving the tab instead of spinning', async () => {
    const { runs, guest } = harness()
    guest.hooks.afterReload = (n) => { if (n === 3) runs.stop('s1') }
    const r = await runs.run('s1', FOREVER_CATCHING)
    expect(r.ok && r.result.error?.message).toBe('stopped')
    const atReturn = guest.counts.reload
    expect(atReturn).toBeGreaterThanOrEqual(3) // it really was looping when the run ended
    await tenTurns()
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

  it("open() with no address asks for the tab at the project's dev server", async () => {
    const { runs, calls } = harness({ devServers: [{ name: 'dev', url: 'http://localhost:4321/', preview: false }] })
    const r = await runs.run('s1', `await open(); log(await url())`)
    expect(calls.requestTab).toEqual(['http://localhost:4321/'])
    expect(r.ok && r.result.log).toEqual(['http://localhost:5173/'])
  })
})

describe('devServersFor', () => {
  const run = (projectPath: string, configName: string, detectedUrl?: string, configId = configName) => ({ projectPath, configId, configName, detectedUrl })

  it("keeps this project's runs that printed an address, in order, once per address", () => {
    const active = [
      run('D:/p', 'web', 'http://localhost:5173/'),
      run('D:/other', 'web', 'http://localhost:5174/'),
      run('D:/p', 'api'),
      run('D:/p', 'web (restart)', 'http://localhost:5173/', 'web2'),
      run('D:/p', 'api', 'http://localhost:3000/')
    ]
    expect(devServersFor(active, 'D:/p')).toEqual([
      { name: 'web', url: 'http://localhost:5173/', preview: false },
      { name: 'api', url: 'http://localhost:3000/', preview: false }
    ])
  })

  it('compares project roots as paths, not as strings', () => {
    expect(devServersFor([run('D:/p/sub/..', 'web', 'http://localhost:5173/')], 'D:\\p')).toEqual([
      { name: 'web', url: 'http://localhost:5173/', preview: false }
    ])
    expect(devServersFor([run('D:/p', 'web', 'http://localhost:5173/')], 'D:/q')).toEqual([])
  })

  // The preview address on a Run's configuration is the user saying "this is the page".
  it('a preview address marks the Run and is the address used, even before it printed one', () => {
    const active = [run('D:/p', 'api', 'http://localhost:3000/'), run('D:/p', 'web')]
    const configs = [{ id: 'web', previewUrl: 'http://localhost:5173/app' }]
    expect(devServersFor(active, 'D:/p', configs)).toEqual([
      { name: 'api', url: 'http://localhost:3000/', preview: false },
      { name: 'web', url: 'http://localhost:5173/app', preview: true }
    ])
  })

  it('a preview address that is not this machine is ignored, and the Run falls back to what it printed', () => {
    const active = [run('D:/p', 'web', 'http://localhost:5173/')]
    const configs = [{ id: 'web', previewUrl: 'https://staging.example.com/' }]
    expect(devServersFor(active, 'D:/p', configs)).toEqual([{ name: 'web', url: 'http://localhost:5173/', preview: false }])
  })
})
