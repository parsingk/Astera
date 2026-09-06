import { describe, it, expect } from 'vitest'
import { AgentBrowserRuns, type RunsDeps } from './runs'
import { AgentGuestRegistry } from './registry'
import { Ring } from '../../core/agentBrowser/ring'

type Cb = (...a: unknown[]) => void
const fakeGuest = (id: number) => {
  const once = new Map<string, Set<Cb>>()
  return {
    id, isDestroyed: () => false, getType: () => 'webview',
    async loadURL() { queueMicrotask(() => { const s = once.get('did-finish-load'); once.delete('did-finish-load'); s?.forEach((cb) => cb()) }) },
    reload() {}, getURL: () => 'http://localhost:5173/', getTitle: () => 'T', isLoading: () => false,
    once(ev: string, cb: Cb) { (once.get(ev) ?? once.set(ev, new Set()).get(ev)!).add(cb); return this },
    removeListener(ev: string, cb: Cb) { once.get(ev)?.delete(cb); return this }
  }
}

const harness = (opts: { hasSession?: boolean; tabAppears?: boolean } = {}) => {
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
    tabWaitMs: 100
  }
  return { runs: new AgentBrowserRuns(deps), calls, registry }
}

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

  it('504 when the tab never appears', async () => {
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
