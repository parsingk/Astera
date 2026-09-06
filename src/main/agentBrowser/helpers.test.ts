// src/main/agentBrowser/helpers.test.ts
import { describe, it, expect, vi } from 'vitest'
import { stage1Helpers, SYNCHRONOUS_HELPERS, type GuestDriver, type HelperDeps } from './helpers'
import { createLog, Interrupted, WAIT_TIMEOUT_MS } from '../../core/agentBrowser/script'
import { Ring } from '../../core/agentBrowser/ring'

type Cb = (...a: unknown[]) => void
const fakeGuest = (): GuestDriver & {
  fire(ev: string, ...a: unknown[]): void
  loaded: string[]
  reloads: number
  listenerCount(ev: string): number
} => {
  const once = new Map<string, Set<Cb>>()
  let url = 'about:blank'
  const g = {
    loaded: [] as string[],
    reloads: 0,
    async loadURL(u: string) { g.loaded.push(u); url = u },
    reload() { g.reloads += 1 },
    getURL: () => url,
    getTitle: () => 'Demo',
    isLoading: () => false,
    once(ev: string, cb: Cb) { (once.get(ev) ?? once.set(ev, new Set()).get(ev)!).add(cb); return g },
    removeListener(ev: string, cb: Cb) { once.get(ev)?.delete(cb); return g },
    fire(ev: string, ...a: unknown[]) { const s = once.get(ev); once.delete(ev); s?.forEach((cb) => cb(...a)) },
    listenerCount(ev: string) { return once.get(ev)?.size ?? 0 }
  }
  return g
}
const deps = (g: ReturnType<typeof fakeGuest> | null) => {
  const buffers = { console: new Ring<{ level: 'error'; message: string; source: string; line: number }>(), network: new Ring<{ url: string; method: string; status?: number }>(), detach() {} }
  const d: HelperDeps & { closed: number; ensured: string[] } = {
    closed: 0,
    ensured: [],
    guest: () => g,
    async ensureGuest(url) { d.ensured.push(url); if (!g) throw new Error('no tab'); return g },
    buffers: () => (g ? buffers : null),
    closeTab() { d.closed += 1 },
    guide: '# guide\n## open(url)\nopens\n## reload()\nreloads'
  }
  return { d, buffers }
}

describe('stage1Helpers', () => {
  it('open refuses a non-loopback address before touching the guest', async () => {
    const g = fakeGuest(); const { d } = deps(g)
    const h = stage1Helpers(d, { at: 'script' }, createLog()) as { open(u: string): Promise<void> }
    await expect(h.open('https://example.com/')).rejects.toThrow('open: only this machine may be opened (got https://example.com/)')
    expect(d.ensured).toEqual([])
  })

  it('open ensures the tab, loads the normalised URL and resolves on did-finish-load', async () => {
    const g = fakeGuest(); const { d } = deps(g)
    const ctx = { at: 'script' }
    const h = stage1Helpers(d, ctx, createLog()) as { open(u: string): Promise<void> }
    const p = h.open('http://0.0.0.0:5173/')
    expect(ctx.at).toBe('open')
    await Promise.resolve()
    g.fire('did-finish-load')
    await p
    expect(d.ensured).toEqual(['http://localhost:5173/'])
    expect(g.loaded).toEqual(['http://localhost:5173/'])
  })

  it('open rejects with the load error when the page fails', async () => {
    const g = fakeGuest(); const { d } = deps(g)
    const h = stage1Helpers(d, { at: 'script' }, createLog()) as { open(u: string): Promise<void> }
    const p = h.open('http://localhost:5173/')
    await Promise.resolve()
    g.fire('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://localhost:5173/', true)
    await expect(p).rejects.toThrow('open: http://localhost:5173/ failed to load (ERR_CONNECTION_REFUSED)')
  })

  it('page helpers without a tab say so', async () => {
    const { d } = deps(null)
    const h = stage1Helpers(d, { at: 'script' }, createLog()) as Record<string, () => Promise<unknown>>
    for (const name of ['reload', 'url', 'title', 'waitForLoad', 'consoleErrors', 'networkErrors'])
      await expect(h[name]()).rejects.toThrow('no page open — call open(url) first')
  })

  it('reload reloads and waits; url and title read the guest', async () => {
    const g = fakeGuest(); const { d } = deps(g)
    const h = stage1Helpers(d, { at: 'script' }, createLog()) as { reload(): Promise<void>; url(): Promise<string>; title(): Promise<string> }
    const p = h.reload()
    await Promise.resolve()
    g.fire('did-finish-load')
    await p
    expect(g.reloads).toBe(1)
    expect(await h.url()).toBe('about:blank')
    expect(await h.title()).toBe('Demo')
  })

  it('consoleErrors and networkErrors read the rings since the mark', async () => {
    const g = fakeGuest(); const { d, buffers } = deps(g)
    buffers.console.push({ level: 'error', message: 'old', source: 'a.js', line: 1 })
    buffers.console.mark()
    buffers.console.push({ level: 'error', message: 'new', source: 'a.js', line: 2 })
    buffers.network.push({ url: 'http://localhost/x', method: 'GET', status: 500 })
    const h = stage1Helpers(d, { at: 'script' }, createLog()) as { consoleErrors(): Promise<unknown[]>; networkErrors(): Promise<unknown[]> }
    expect(await h.consoleErrors()).toEqual([{ level: 'error', message: 'new', source: 'a.js', line: 2 }])
    expect(await h.networkErrors()).toEqual([{ url: 'http://localhost/x', method: 'GET', status: 500 }])
  })

  it('close closes the tab, and help returns the guide or one section', async () => {
    const g = fakeGuest(); const { d } = deps(g)
    const h = stage1Helpers(d, { at: 'script' }, createLog()) as { close(): Promise<void>; help(n?: string): string }
    await h.close()
    expect(d.closed).toBe(1)
    expect(h.help()).toContain('## open(url)')
    expect(h.help('reload')).toBe('## reload()\nreloads')
    expect(h.help('nope')).toBe('no helper named nope — run help() for the list')
  })

  it('waitForLoad resolves at once when not loading, and registers no listeners', async () => {
    const g = fakeGuest(); const { d } = deps(g)
    const h = stage1Helpers(d, { at: 'script' }, createLog()) as { waitForLoad(): Promise<void> }
    await h.waitForLoad()
    expect(g.listenerCount('did-finish-load')).toBe(0)
    expect(g.listenerCount('did-fail-load')).toBe(0)
  })

  it('waitForLoad waits for an in-flight load to finish', async () => {
    const g = fakeGuest(); g.isLoading = () => true
    const { d } = deps(g)
    const h = stage1Helpers(d, { at: 'script' }, createLog()) as { waitForLoad(): Promise<void> }
    const p = h.waitForLoad()
    await Promise.resolve()
    expect(g.listenerCount('did-finish-load')).toBe(1)
    g.fire('did-finish-load')
    await p
  })

  it('waitForLoad rejects with the load error on a main-frame failure, at waitForLoad', async () => {
    const g = fakeGuest(); g.isLoading = () => true
    const { d } = deps(g)
    const ctx = { at: 'script' }
    const h = stage1Helpers(d, ctx, createLog()) as { waitForLoad(): Promise<void> }
    const p = h.waitForLoad()
    await Promise.resolve()
    g.fire('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://localhost:5173/', true)
    await expect(p).rejects.toThrow('waitForLoad: http://localhost:5173/ failed to load (ERR_CONNECTION_REFUSED)')
    expect(ctx.at).toBe('waitForLoad')
  })

  it('a sub-frame failure does not end the wait; a later main-frame failure still does', async () => {
    const g = fakeGuest(); g.isLoading = () => true
    const { d } = deps(g)
    const h = stage1Helpers(d, { at: 'script' }, createLog()) as { waitForLoad(): Promise<void> }
    const p = h.waitForLoad()
    await Promise.resolve()
    g.fire('did-fail-load', {}, -102, 'ERR_FAILED', 'http://localhost:5173/iframe', false)
    await Promise.resolve()
    g.fire('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://localhost:5173/', true)
    await expect(p).rejects.toThrow('waitForLoad: http://localhost:5173/ failed to load (ERR_CONNECTION_REFUSED)')
  }, 2000)

  // The real sequence this comes from: a tab is created pointing at the address, `open` loads it
  // again, and the first load aborts. Resolving on the abort returned from `open` with the guest
  // still on about:blank, so everything the script read next described the wrong page.
  // A tab that was just built starts on about:blank and finishes loading it, and that event arrives
  // after dom-ready — which is when the guest registers and so when the wait is armed. Taking it as
  // the answer returned from open() with the guest still blank.
  it('a tab built for this open ignores the blank page finishing and waits for the real load', async () => {
    const g = fakeGuest()
    g.getURL = () => 'about:blank'
    const { d } = deps(null)
    d.guest = () => null
    d.ensureGuest = async () => g
    const h = stage1Helpers(d, { at: 'script' }, createLog()) as { open(u: string): Promise<void> }
    const p = h.open('http://localhost:5173/')
    let settled = false
    void p.then(() => { settled = true })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    g.fire('did-finish-load')
    await Promise.resolve(); await Promise.resolve()
    expect(settled).toBe(false)
    g.getURL = () => 'http://localhost:5173/'
    g.fire('did-finish-load')
    await expect(p).resolves.toBeUndefined()
  }, 2000)

  it('an ABORTED (-3) failure keeps waiting for the load that replaced it', async () => {
    const g = fakeGuest(); g.isLoading = () => true
    const { d } = deps(g)
    const h = stage1Helpers(d, { at: 'script' }, createLog()) as { waitForLoad(): Promise<void> }
    const p = h.waitForLoad()
    let settled = false
    void p.then(() => { settled = true })
    await Promise.resolve()
    g.fire('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://localhost:5173/', true)
    await Promise.resolve(); await Promise.resolve()
    expect(settled).toBe(false)
    g.fire('did-finish-load')
    await expect(p).resolves.toBeUndefined()
  })

  it('an ABORTED (-3) failure still leaves a real failure reportable afterwards', async () => {
    const g = fakeGuest(); g.isLoading = () => true
    const { d } = deps(g)
    const h = stage1Helpers(d, { at: 'script' }, createLog()) as { waitForLoad(): Promise<void> }
    const p = h.waitForLoad()
    await Promise.resolve()
    g.fire('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://localhost:5173/', true)
    await Promise.resolve()
    g.fire('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'http://localhost:5173/', true)
    await expect(p).rejects.toThrow('failed to load (ERR_NAME_NOT_RESOLVED)')
  }, 2000)

  it('waitForLoad times out and leaves no listener behind', async () => {
    vi.useFakeTimers()
    try {
      const g = fakeGuest(); g.isLoading = () => true
      const { d } = deps(g)
      const h = stage1Helpers(d, { at: 'script' }, createLog()) as { waitForLoad(): Promise<void> }
      const p = h.waitForLoad()
      await Promise.resolve()
      const rejection = expect(p).rejects.toBeInstanceOf(Interrupted)
      await vi.advanceTimersByTimeAsync(WAIT_TIMEOUT_MS)
      await rejection
      expect(g.listenerCount('did-finish-load')).toBe(0)
      expect(g.listenerCount('did-fail-load')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('every helper without a page-open assertion sets ctx.at to its own name first', async () => {
    const { d } = deps(null)
    const ctx = { at: 'script' }
    const h = stage1Helpers(d, ctx, createLog()) as Record<string, (...a: unknown[]) => unknown>

    for (const name of ['reload', 'url', 'title', 'waitForLoad', 'consoleErrors', 'networkErrors']) {
      ctx.at = 'script'
      const p = h[name]()
      expect(ctx.at).toBe(name)
      await expect(p).rejects.toThrow('no page open — call open(url) first')
    }

    ctx.at = 'script'
    await (h.close as () => Promise<void>)()
    expect(ctx.at).toBe('close')

    ctx.at = 'script'
    ;(h.help as (n?: string) => string)()
    expect(ctx.at).toBe('help')
  })

  // runs.ts parks every asynchronous helper when a run is cut off and throws from the synchronous
  // ones, so a name missing from this list would park a caller that is not awaiting anything — the
  // abandoned script would spin instead of stopping. The list is only right if it matches the
  // helpers, so check it against them rather than against itself.
  it('SYNCHRONOUS_HELPERS names exactly the helpers that do not return a promise', () => {
    const g = fakeGuest(); const { d } = deps(g)
    const h = stage1Helpers(d, { at: 'script' }, createLog())
    const sync = Object.entries(h)
      .filter(([, v]) => typeof v === 'function')
      .filter(([, v]) => {
        const r = (v as (...a: unknown[]) => unknown)()
        // Called with no argument, so the asynchronous ones reject; swallow that — the question here
        // is only what shape they return.
        if (r instanceof Promise) { void r.catch(() => {}); return false }
        return true
      })
      .map(([name]) => name)
    expect(new Set(sync)).toEqual(SYNCHRONOUS_HELPERS)
  })
})
