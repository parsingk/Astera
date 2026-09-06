// src/main/agentBrowser/helpers.test.ts
import { describe, it, expect } from 'vitest'
import { stage1Helpers, type GuestDriver, type HelperDeps } from './helpers'
import { createLog } from '../../core/agentBrowser/script'
import { Ring } from '../../core/agentBrowser/ring'

type Cb = (...a: unknown[]) => void
const fakeGuest = (): GuestDriver & { fire(ev: string, ...a: unknown[]): void; loaded: string[]; reloads: number } => {
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
    fire(ev: string, ...a: unknown[]) { const s = once.get(ev); once.delete(ev); s?.forEach((cb) => cb(...a)) }
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
})
