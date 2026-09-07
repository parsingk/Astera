// src/main/agentBrowser/helpers.test.ts
import { describe, it, expect, vi, afterAll } from 'vitest'
import { SHOT_TIMEOUT_MS, stage1Helpers, SYNCHRONOUS_HELPERS, type GuestDriver, type HelperDeps } from './helpers'
import { createLog, Interrupted, WAIT_TIMEOUT_MS } from '../../core/agentBrowser/script'
import { Ring } from '../../core/agentBrowser/ring'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Where the screenshot tests let savePng write. Per-process, so two vitest workers running this
 *  file cannot delete each other's folder in the afterAll below. */
const SHOTS_DIR = path.join(os.tmpdir(), 'astera-helpers-shots-' + process.pid)
afterAll(async () => { await fs.rm(SHOTS_DIR, { recursive: true, force: true }) })

type Cb = (...a: unknown[]) => void
const fakeGuest = (): GuestDriver & {
  fire(ev: string, ...a: unknown[]): void
  loaded: string[]
  reloads: number
  listenerCount(ev: string): number
  answers: unknown[]
  scripts: string[]
  shots: number
  staleLoading(ticks: number): void
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
    listenerCount(ev: string) { return once.get(ev)?.size ?? 0 },
    // stage 2/3: what the page answers, in order, and what was asked of it
    answers: [] as unknown[],
    scripts: [] as string[],
    async executeJavaScript(code: string) {
      g.scripts.push(code)
      const next = g.answers.shift()
      if (next instanceof Error) throw next
      return next
    },
    shots: 0,
    async capturePage() { g.shots += 1; return { getSize: () => ({ width: 800, height: 600 }), toPNG: () => Buffer.from('png') } },
    /** Answers `isLoading()` true for the next `ticks` questions and false afterwards, and fires no
     *  load event ever. That is the state a real guest is in for a moment after `did-finish-load` has
     *  already gone out, and no fake here could express it before: every one of them either reports
     *  false from the start or reports true and then has the event fired for it. A pre-wait that
     *  waited for the event instead of asking sat out the whole deadline for a load already in the
     *  past, which is what `await open(); await snapshot()` did in the app. */
    staleLoading(ticks: number) {
      let left = ticks
      g.isLoading = () => {
        if (left <= 0) return false
        left -= 1
        return true
      }
    }
  }
  return g
}
const deps = (g: ReturnType<typeof fakeGuest> | null) => {
  const buffers = { console: new Ring<{ level: 'error'; message: string; source: string; line: number }>(), network: new Ring<{ url: string; method: string; status?: number }>(), detach() {} }
  const d: HelperDeps & { closed: number; ensured: string[]; servers: { name: string; url: string; preview: boolean }[] } = {
    closed: 0,
    ensured: [],
    servers: [],
    guest: () => g,
    async ensureGuest(url) { d.ensured.push(url); if (!g) throw new Error('no tab'); return g },
    buffers: () => (g ? buffers : null),
    closeTab() { d.closed += 1 },
    devServers: () => d.servers,
    guide: '# guide\n## open(url)\nopens\n## reload()\nreloads',
    shotsDir: SHOTS_DIR
  }
  return { d, buffers }
}

/** What Electron says when executeJavaScript rejects — the same sentence whether the page threw or
 *  the script already ran and its own side effect navigated, losing the reply with the frame. That is
 *  why it is the fixture for both cases: nothing in the message tells them apart. */
const LOST_REPLY = 'Script failed to execute, this normally means an error was thrown. Check the renderer console for the error.'

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
    await new Promise((r) => setTimeout(r, 0))
    g.fire('did-finish-load')
    // Same reason as the ABORTED test above: a full turn, so a premature resolve has reached the flag.
    await new Promise((r) => setTimeout(r, 0))
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
    // A whole event-loop turn, not a microtask or two: a premature resolve needs several ticks to
    // reach `settled` through race → finally → await, and an assertion made before it arrives cannot
    // fail. Verified against the pre-fix code — with two microtask ticks this test passed there.
    await new Promise((r) => setTimeout(r, 0))
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

  // "Which localhost port is mine?" — with several projects open, an agent that guessed could read
  // another project's page as its own. So with no address, open() takes the one dev server Astera's
  // Run has running for this project, and refuses — saying why — when there is none or several.
  describe('open() with no address', () => {
    it('opens the one dev server the project has running', async () => {
      const g = fakeGuest(); const { d } = deps(g)
      d.servers = [{ name: 'dev', url: 'http://localhost:4321/', preview: false }]
      const h = stage1Helpers(d, { at: 'script' }, createLog()) as { open(u?: string): Promise<void> }
      const p = h.open()
      await new Promise((r) => setTimeout(r, 0))
      g.fire('did-finish-load')
      await p
      expect(g.loaded).toEqual(['http://localhost:4321/'])
    })

    it('refuses when no Run has a dev server for this project, and says what to do', async () => {
      const g = fakeGuest(); const { d } = deps(g)
      const h = stage1Helpers(d, { at: 'script' }, createLog()) as { open(u?: string): Promise<void> }
      await expect(h.open()).rejects.toThrow("open: no dev server has been started from Astera's Run for this project — pass the address")
      expect(g.loaded).toEqual([])
    })

    it('refuses when several are running, listing them by their Run name', async () => {
      const g = fakeGuest(); const { d } = deps(g)
      d.servers = [{ name: 'web', url: 'http://localhost:5173/', preview: false }, { name: 'api', url: 'http://localhost:3000/', preview: false }]
      const h = stage1Helpers(d, { at: 'script' }, createLog()) as { open(u?: string): Promise<void> }
      await expect(h.open()).rejects.toThrow('open: this project has several dev servers running — pass one of them, or set the preview address on the Run that is the page: web http://localhost:5173/, api http://localhost:3000/')
      expect(g.loaded).toEqual([])
    })

    // The user's own answer, made once for the preview button: a Run marked for preview is the page.
    it('a Run marked for preview wins, whatever else is running', async () => {
      const g = fakeGuest(); const { d } = deps(g)
      d.servers = [{ name: 'api', url: 'http://localhost:3000/', preview: false }, { name: 'web', url: 'http://localhost:5173/', preview: true }]
      const h = stage1Helpers(d, { at: 'script' }, createLog()) as { open(u?: string): Promise<void> }
      const p = h.open()
      await new Promise((r) => setTimeout(r, 0))
      g.fire('did-finish-load')
      await p
      expect(g.loaded).toEqual(['http://localhost:5173/'])
    })

    it('two Runs marked for preview is a question back, listing only the marked ones', async () => {
      const g = fakeGuest(); const { d } = deps(g)
      d.servers = [{ name: 'api', url: 'http://localhost:3000/', preview: false }, { name: 'web', url: 'http://localhost:5173/', preview: true }, { name: 'docs', url: 'http://localhost:6006/', preview: true }]
      const h = stage1Helpers(d, { at: 'script' }, createLog()) as { open(u?: string): Promise<void> }
      await expect(h.open()).rejects.toThrow("open: several of this project's Runs mark a preview page — pass one of them: web http://localhost:5173/, docs http://localhost:6006/")
      expect(g.loaded).toEqual([])
    })

    it('an explicit address is unaffected by what Run is running', async () => {
      const g = fakeGuest(); const { d } = deps(g)
      d.servers = [{ name: 'web', url: 'http://localhost:5173/', preview: false }, { name: 'api', url: 'http://localhost:3000/', preview: false }]
      const h = stage1Helpers(d, { at: 'script' }, createLog()) as { open(u?: string): Promise<void> }
      const p = h.open('http://127.0.0.1:8080/x')
      await new Promise((r) => setTimeout(r, 0))
      g.fire('did-finish-load')
      await p
      expect(g.loaded).toEqual(['http://127.0.0.1:8080/x'])
    })
  })

  describe('help() names the dev server first', () => {
    it('one server: a first line naming it, then the guide', () => {
      const { d } = deps(fakeGuest())
      d.servers = [{ name: 'dev', url: 'http://localhost:4321/', preview: false }]
      const h = stage1Helpers(d, { at: 'script' }, createLog()) as { help(n?: string): string }
      expect(h.help()).toBe("This project's dev server, as started from Astera's Run: http://localhost:4321/ — open() with no address opens it.\n\n" + d.guide)
    })

    it('a marked Run is named as the page, and the others are not listed', () => {
      const { d } = deps(fakeGuest())
      d.servers = [{ name: 'api', url: 'http://localhost:3000/', preview: false }, { name: 'web', url: 'http://localhost:5173/', preview: true }]
      const h = stage1Helpers(d, { at: 'script' }, createLog()) as { help(n?: string): string }
      expect(h.help()).toBe("This project's dev server, the page its Run marks for preview: http://localhost:5173/ — open() with no address opens it.\n\n" + d.guide)
    })

    it('no server: the guide alone, and help(name) is never prefixed', () => {
      const { d } = deps(fakeGuest())
      d.servers = [{ name: 'dev', url: 'http://localhost:4321/', preview: false }]
      const h = stage1Helpers(d, { at: 'script' }, createLog()) as { help(n?: string): string }
      expect(h.help('reload')).toBe('## reload()\nreloads')
      d.servers = []
      expect(h.help()).toBe(d.guide)
    })
  })

  describe('snapshot()', () => {
    it('runs the snapshot script in the page and returns the clamped result', async () => {
      const g = fakeGuest(); const { d } = deps(g)
      g.answers.push({ title: 'Demo', url: 'http://localhost:5173/', headings: [{ level: 1, text: 'Hi' }], interactive: [], text: 'a  b' })
      const h = stage1Helpers(d, { at: 'script' }, createLog()) as { snapshot(): Promise<unknown> }
      const s = await h.snapshot()
      expect(g.scripts[0]).toContain('function snapshotRuntime')
      expect(s).toMatchObject({ title: 'Demo', headings: [{ level: 1, text: 'Hi' }], text: 'a b' })
    })

    it('throws when the page returns nothing readable', async () => {
      const g = fakeGuest(); const { d } = deps(g)
      g.answers.push('not a snapshot')
      const h = stage1Helpers(d, { at: 'script' }, createLog()) as { snapshot(): Promise<unknown> }
      await expect(h.snapshot()).rejects.toThrow('snapshot: the page returned nothing readable')
    })

    it('waits for a load in progress before asking the page', async () => {
      const g = fakeGuest(); g.isLoading = () => true
      const { d } = deps(g)
      g.answers.push({ title: 't', url: 'http://localhost/', text: '' })
      const h = stage1Helpers(d, { at: 'script' }, createLog()) as { snapshot(): Promise<unknown> }
      const p = h.snapshot()
      await new Promise((r) => setTimeout(r, 0))
      expect(g.scripts).toHaveLength(0)
      g.isLoading = () => false
      g.fire('did-finish-load')
      await p
      expect(g.scripts).toHaveLength(1)
    })

    // snapshot is a pure read, so a rejection that lands while the guest is navigating is re-sent:
    // the worst a second read can do is read the newer page. The guest's state at the moment of the
    // rejection is what decides, and the two ways it can say "I am navigating" are covered here; the
    // message never is. The other half of the rule — a call that changes the page is not re-sent —
    // is the describe below.
    for (const [how, navigating] of [
      ['the frame reports itself loading', (g: ReturnType<typeof fakeGuest>) => { g.isLoading = () => true }],
      ['the address has already changed', (g: ReturnType<typeof fakeGuest>) => { g.getURL = () => 'http://localhost:5173/next' }]
    ] as const) {
      it(`re-sends the script once when the rejection lands while ${how}`, async () => {
        const g = fakeGuest(); const { d } = deps(g)
        g.answers.push(new Error(LOST_REPLY))
        g.answers.push({ title: 't', url: 'http://localhost/', text: 'after' })
        const send = g.executeJavaScript.bind(g)
        g.executeJavaScript = async (code: string) => {
          try {
            return await send(code)
          } catch (err) {
            navigating(g)
            throw err
          }
        }
        const h = stage1Helpers(d, { at: 'script' }, createLog()) as { snapshot(): Promise<{ text: string }> }
        const p = h.snapshot()
        // A whole turn, so the wait on the load — armed only by the isLoading case — is registered
        // before it is ended. A no-op for the changed-address case, which retries at once.
        await new Promise((r) => setTimeout(r, 0))
        g.isLoading = () => false
        g.fire('did-finish-load')
        expect((await p).text).toBe('after')
        expect(g.scripts).toHaveLength(2)
      })
    }

    it('reports the refusal at once when the guest is not navigating, and sends nothing again', async () => {
      const g = fakeGuest(); const { d } = deps(g)
      g.answers.push(new Error(LOST_REPLY))
      const h = stage1Helpers(d, { at: 'script' }, createLog()) as { snapshot(): Promise<unknown> }
      await expect(h.snapshot()).rejects.toThrow(`snapshot: the page refused the call (${LOST_REPLY})`)
      expect(g.scripts).toHaveLength(1)
    })

    // Two refusals across a navigation: the second is the page's answer and the first is the reply
    // that was lost, so the second is what the agent must be told. The two messages differ here for
    // exactly that reason — reporting the first would read as "the page refused" while naming an
    // error that says nothing about the page's current state.
    it('reports the second rejection, not the first, when the re-sent script is refused too', async () => {
      const g = fakeGuest(); const { d } = deps(g)
      g.answers.push(new Error(LOST_REPLY), new Error('Cannot access contents of the frame'))
      const send = g.executeJavaScript.bind(g)
      g.executeJavaScript = async (code: string) => {
        try {
          return await send(code)
        } catch (err) {
          g.getURL = () => 'http://localhost:5173/next'
          throw err
        }
      }
      const h = stage1Helpers(d, { at: 'script' }, createLog()) as { snapshot(): Promise<unknown> }
      await expect(h.snapshot()).rejects.toThrow('snapshot: the page refused the call (Cannot access contents of the frame)')
      expect(g.scripts).toHaveLength(2)
    })
  })

  // The re-send is for the reads only, and this is the case that ruled it out for the rest: a
  // rejection landing while the guest navigates is the *successful* path for a click that navigates —
  // the runtime clicked, the handler navigated, the reply went with the frame. Re-sending it clicked
  // a second time wherever the destination page matched the selector too (a shared header does), and
  // reported `click: nothing matches` where it did not — a click that worked, described to the agent
  // as a selector that does not exist. `the page refused the call` is the one wording the guide has
  // taught the agent to check with snapshot() before repeating, so that is what these get.
  describe('a call that changes the page', () => {
    it('is never re-sent, and reports the refusal', async () => {
      for (const [name, args] of [['click', ['#next']], ['fill', ['#q', 'x']], ['press', ['Enter']]] as const) {
        const g = fakeGuest(); const { d } = deps(g)
        // A second answer is queued on purpose: a re-send would find it and succeed quietly.
        g.answers.push(new Error(LOST_REPLY), { found: true, clicked: true, filled: true, pressed: true })
        const send = g.executeJavaScript.bind(g)
        g.executeJavaScript = async (code: string) => {
          try {
            return await send(code)
          } catch (err) {
            // Navigating as the rejection lands, and settled a moment later — the state a click that
            // navigated really leaves. A guest that stayed loading would fail this on the pre-wait's
            // deadline instead, which is not the same answer.
            g.staleLoading(3)
            throw err
          }
        }
        const h = stage1Helpers(d, { at: 'script' }, createLog()) as Record<string, (...a: unknown[]) => Promise<void>>
        await expect(h[name](...args)).rejects.toThrow(`${name}: the page refused the call (${LOST_REPLY})`)
        expect(g.scripts).toHaveLength(1)
      }
    })
  })

  describe('screenshot()', () => {
    it('captures the page, writes the PNG under the shots folder and returns path and size', async () => {
      const g = fakeGuest(); const { d } = deps(g)
      const h = stage1Helpers(d, { at: 'script' }, createLog()) as { screenshot(): Promise<{ path: string; width: number; height: number }> }
      const r = await h.screenshot()
      expect(g.shots).toBe(1)
      expect(r.width).toBe(800)
      expect(r.height).toBe(600)
      expect(r.path.startsWith(d.shotsDir)).toBe(true)
      expect(r.path.endsWith('.png')).toBe(true)
    })

    it('fails within SHOT_TIMEOUT_MS when the capture never settles, naming the likely cause', async () => {
      vi.useFakeTimers()
      try {
        const g = fakeGuest(); const { d } = deps(g)
        g.capturePage = () => new Promise(() => {})
        const h = stage1Helpers(d, { at: 'script' }, createLog()) as { screenshot(): Promise<unknown> }
        const p = h.screenshot()
        const settled = expect(p).rejects.toThrow('screenshot: the page did not paint within 5 s — the window may be minimised')
        await vi.advanceTimersByTimeAsync(SHOT_TIMEOUT_MS + 1)
        await settled
      } finally {
        vi.useRealTimers()
      }
    })

    // screenshot() does not go through inGuest — it races capturePage instead — so its pre-wait is
    // its own copy of the rule and needs its own test.
    it('waits for a load in progress before capturing', async () => {
      const g = fakeGuest(); g.isLoading = () => true
      const { d } = deps(g)
      const h = stage1Helpers(d, { at: 'script' }, createLog()) as { screenshot(): Promise<unknown> }
      const p = h.screenshot()
      await new Promise((r) => setTimeout(r, 0))
      expect(g.shots).toBe(0)
      g.isLoading = () => false
      g.fire('did-finish-load')
      await p
      expect(g.shots).toBe(1)
    })

    // A background tab's page is not drawn at all, and capturePage cannot photograph what is not
    // being drawn: it answers a zero-size image, or a viz error, or nothing. The renderer draws the
    // tab invisibly while a script runs, and a guest that has just started producing frames answers
    // with both of those for a frame or two — so both mean "not yet" here.
    it('retries an empty frame and a viz error until the first real frame lands', async () => {
      const g = fakeGuest(); const { d } = deps(g)
      let calls = 0
      g.capturePage = async () => {
        calls += 1
        if (calls === 1) return { getSize: () => ({ width: 0, height: 0 }), toPNG: () => Buffer.alloc(0) }
        if (calls === 2) throw new Error('UnknownVizError')
        return { getSize: () => ({ width: 800, height: 600 }), toPNG: () => Buffer.from('png') }
      }
      const h = stage1Helpers(d, { at: 'script' }, createLog()) as { screenshot(): Promise<{ width: number }> }
      const r = await h.screenshot()
      expect(calls).toBe(3)
      expect(r.width).toBe(800)
    })

    it('fails at the deadline when no frame ever has pixels', async () => {
      vi.useFakeTimers()
      try {
        const g = fakeGuest(); const { d } = deps(g)
        g.capturePage = async () => ({ getSize: () => ({ width: 0, height: 0 }), toPNG: () => Buffer.alloc(0) })
        const h = stage1Helpers(d, { at: 'script' }, createLog()) as { screenshot(): Promise<unknown> }
        const p = h.screenshot()
        const settled = expect(p).rejects.toThrow('screenshot: the page did not paint within 5 s — the window may be minimised')
        await vi.advanceTimersByTimeAsync(SHOT_TIMEOUT_MS + 1)
        await settled
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('click()', () => {
    it('clicks a matching element', async () => {
      const g = fakeGuest(); const { d } = deps(g)
      g.answers.push({ found: true, clicked: true })
      const h = stage1Helpers(d, { at: 'script' }, createLog()) as { click(s: string): Promise<void> }
      await h.click('#save')
      expect(g.scripts).toHaveLength(1)
      expect(g.scripts[0]).toContain('"#save", false)')
    })

    it('throws when nothing matches', async () => {
      const g = fakeGuest(); const { d } = deps(g)
      g.answers.push({ found: false })
      const h = stage1Helpers(d, { at: 'script' }, createLog()) as { click(s: string): Promise<void> }
      await expect(h.click('#nope')).rejects.toThrow('click: nothing matches #nope')
    })

    it('follows a link that stays on this machine, in a second call', async () => {
      const g = fakeGuest(); const { d } = deps(g)
      g.answers.push({ found: true, href: 'http://localhost:5173/next' }, { found: true, clicked: true })
      const h = stage1Helpers(d, { at: 'script' }, createLog()) as { click(s: string): Promise<void> }
      await h.click('a.next')
      expect(g.scripts).toHaveLength(2)
      expect(g.scripts[1]).toContain('"a.next", true)')
    })

    // The whole message, not a prefix: the sanitising is the security-relevant half of it, and a
    // substring that stops before the query string would pass with the token still in there.
    it('refuses a link that would leave this machine, without clicking it, naming the sanitised address', async () => {
      const g = fakeGuest(); const { d } = deps(g)
      g.answers.push({ found: true, href: 'https://example.com/docs?token=abcdefghijklmnop' })
      const h = stage1Helpers(d, { at: 'script' }, createLog()) as { click(s: string): Promise<void> }
      await expect(h.click('a.ext')).rejects.toThrow('click: the link leaves this machine (https://example.com/docs)')
      expect(g.scripts).toHaveLength(1)
    })

    // `<a href="javascript:void(0)" onclick=…>` is an ordinary way to spell a button. It is not a
    // page address, so the loopback rule has nothing to say about it — refusing it named no address
    // and claimed a cause that was untrue.
    it('clicks a link whose href is not a page address at all', async () => {
      const g = fakeGuest(); const { d } = deps(g)
      g.answers.push({ found: true, href: 'javascript:void(0)' }, { found: true, clicked: true })
      const h = stage1Helpers(d, { at: 'script' }, createLog()) as { click(s: string): Promise<void> }
      await h.click('a.fake-button')
      expect(g.scripts).toHaveLength(2)
      expect(g.scripts[1]).toContain('"a.fake-button", true)')
    })
  })

  describe('fill() and press()', () => {
    it('fill sets the value and reports the page\'s own refusal', async () => {
      const g = fakeGuest(); const { d } = deps(g)
      g.answers.push(
        { found: true, filled: true },
        { found: false },
        { found: true, error: 'no option has that value' },
        { found: true, error: 'not an input, textarea, select or editable element' }
      )
      const h = stage1Helpers(d, { at: 'script' }, createLog()) as { fill(s: string, t: string): Promise<void> }
      await h.fill('#email', 'dev@test')
      expect(g.scripts[0]).toContain('"#email", "dev@test")')
      await expect(h.fill('#x', 'v')).rejects.toThrow('fill: nothing matches #x')
      await expect(h.fill('#sel', 'v')).rejects.toThrow('fill: #sel has no option with that value')
      // The one guide-quoted message assembled from the guest's own reason string rather than
      // written out here, so this is what stops fillRuntime's wording drifting away from the guide.
      await expect(h.fill('#card', 'v')).rejects.toThrow('fill: #card is not an input, textarea, select or editable element')
    })

    it('press sends the key and rejects an empty one before asking the page', async () => {
      const g = fakeGuest(); const { d } = deps(g)
      g.answers.push({ pressed: true, target: 'input#q' })
      const h = stage1Helpers(d, { at: 'script' }, createLog()) as { press(k: string): Promise<void> }
      await h.press('Enter')
      expect(g.scripts[0]).toContain('"Enter")')
      await expect(h.press('')).rejects.toThrow('press: key must be a non-empty string')
      expect(g.scripts).toHaveLength(1)
    })
  })

  describe('waitFor()', () => {
    it('with a selector, resolves when the page reports a match and throws when it does not in time', async () => {
      const g = fakeGuest(); const { d } = deps(g)
      g.answers.push({ found: true }, { found: false })
      const h = stage1Helpers(d, { at: 'script' }, createLog()) as { waitFor(x: unknown): Promise<void> }
      await h.waitFor('.dashboard')
      expect(g.scripts[0]).toContain(`".dashboard", ${WAIT_TIMEOUT_MS})`)
      await expect(h.waitFor('.never')).rejects.toThrow(`waitFor: nothing matched .never within ${WAIT_TIMEOUT_MS} ms`)
    })

    it('with a number, just waits that long and never asks the page', async () => {
      vi.useFakeTimers()
      try {
        const g = fakeGuest(); const { d } = deps(g)
        const h = stage1Helpers(d, { at: 'script' }, createLog()) as { waitFor(x: unknown): Promise<void> }
        let done = false
        void h.waitFor(250).then(() => { done = true })
        await vi.advanceTimersByTimeAsync(200)
        expect(done).toBe(false)
        await vi.advanceTimersByTimeAsync(60)
        expect(done).toBe(true)
        expect(g.scripts).toHaveLength(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it('caps a numeric wait at WAIT_TIMEOUT_MS and refuses anything else', async () => {
      vi.useFakeTimers()
      try {
        const g = fakeGuest(); const { d } = deps(g)
        const h = stage1Helpers(d, { at: 'script' }, createLog()) as { waitFor(x: unknown): Promise<void> }
        let done = false
        void h.waitFor(10 * 60_000).then(() => { done = true })
        await vi.advanceTimersByTimeAsync(WAIT_TIMEOUT_MS + 1)
        expect(done).toBe(true)
        await expect(h.waitFor({})).rejects.toThrow('waitFor: expects a selector or a number of milliseconds')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // Every guest-side helper waits for a load in progress before it touches the page. The state it
  // has to survive is the one a fake could not express until `staleLoading`: isLoading() true with
  // the load event already in the past. Waiting for that event meant `await open(); await snapshot()`
  // — the first sequence in the guide — failing after 30 s against a page that was complete and
  // answering. So the pre-wait asks the guest instead, and these say so: it must not depend on an
  // event, and it must still respect the deadline when the guest really never settles.
  describe('the pre-wait asks the guest rather than waiting for a load event', () => {
    it('a guest still reporting itself loading after the event has passed is asked anyway, at once', async () => {
      const g = fakeGuest(); const { d } = deps(g)
      g.staleLoading(2)
      g.answers.push({ title: 't', url: 'http://localhost/', text: 'ok' })
      const h = stage1Helpers(d, { at: 'script' }, createLog()) as { snapshot(): Promise<{ text: string }> }
      const p = h.snapshot()
      // Raced against 500 ms rather than awaited: an event-driven pre-wait never answers here at all,
      // and the only other way to find that out is to sit through WAIT_TIMEOUT_MS.
      const raced = await Promise.race([
        p.then(() => 'answered', () => 'rejected'),
        new Promise<string>((r) => setTimeout(() => r('still waiting for a load event'), 500))
      ])
      expect(raced).toBe('answered')
      expect((await p).text).toBe('ok')
      expect(g.scripts).toHaveLength(1)
      // Nothing was armed: the pre-wait did not subscribe to a load it never started.
      expect(g.listenerCount('did-finish-load')).toBe(0)
    })

    it('a guest that never stops loading still fails at the wait deadline, without arming a listener', async () => {
      vi.useFakeTimers()
      try {
        const g = fakeGuest(); g.isLoading = () => true   // and no load event is ever fired
        const { d } = deps(g)
        const h = stage1Helpers(d, { at: 'script' }, createLog()) as { snapshot(): Promise<unknown> }
        const p = h.snapshot()
        const rejection = expect(p).rejects.toThrow(`snapshot did not finish within ${WAIT_TIMEOUT_MS} ms`)
        await vi.advanceTimersByTimeAsync(100)
        expect(g.listenerCount('did-finish-load')).toBe(0)
        await vi.advanceTimersByTimeAsync(WAIT_TIMEOUT_MS)
        await rejection
        await expect(p).rejects.toBeInstanceOf(Interrupted)
        expect(g.scripts).toHaveLength(0)
      } finally {
        vi.useRealTimers()
      }
    })

    // screenshot() does not go through inGuest, so its pre-wait is a second copy of the rule.
    it('screenshot captures a guest whose loading flag is stale, without waiting for an event', async () => {
      const g = fakeGuest(); const { d } = deps(g)
      g.staleLoading(2)
      const h = stage1Helpers(d, { at: 'script' }, createLog()) as { screenshot(): Promise<{ path: string }> }
      const p = h.screenshot()
      const raced = await Promise.race([
        p.then(() => 'captured', () => 'rejected'),
        new Promise<string>((r) => setTimeout(() => r('still waiting for a load event'), 500))
      ])
      expect(raced).toBe('captured')
      expect(g.shots).toBe(1)
      expect(g.listenerCount('did-finish-load')).toBe(0)
    })

    it('screenshot fails at the wait deadline when the guest never stops loading, and captures nothing', async () => {
      vi.useFakeTimers()
      try {
        const g = fakeGuest(); g.isLoading = () => true
        const { d } = deps(g)
        const h = stage1Helpers(d, { at: 'script' }, createLog()) as { screenshot(): Promise<unknown> }
        const p = h.screenshot()
        const rejection = expect(p).rejects.toThrow(`screenshot did not finish within ${WAIT_TIMEOUT_MS} ms`)
        await vi.advanceTimersByTimeAsync(100)
        expect(g.listenerCount('did-finish-load')).toBe(0)
        await vi.advanceTimersByTimeAsync(WAIT_TIMEOUT_MS)
        await rejection
        expect(g.shots).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('every new helper sets ctx.at to its own name first, including on the no-guest throw', async () => {
    const { d } = deps(null)
    const ctx = { at: 'script' }
    const h = stage1Helpers(d, ctx, createLog()) as Record<string, (...a: unknown[]) => Promise<unknown>>
    for (const [name, args] of [['snapshot', []], ['screenshot', []], ['click', ['#a']], ['fill', ['#a', 'x']], ['press', ['Enter']], ['waitFor', ['.a']]] as const) {
      ctx.at = 'script'
      await expect(h[name](...args)).rejects.toThrow('no page open — call open(url) first')
      expect(ctx.at).toBe(name)
    }
  })
})
