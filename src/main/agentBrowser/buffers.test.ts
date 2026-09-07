import { describe, it, expect } from 'vitest'
import { AgentBufferStore, attachBuffers, installNetworkCapture } from './buffers'

type Cb = (...a: unknown[]) => void
const fakeGuest = () => {
  const handlers = new Map<string, Set<Cb>>()
  return {
    on(ev: string, cb: Cb) { (handlers.get(ev) ?? handlers.set(ev, new Set()).get(ev)!).add(cb); return this },
    off(ev: string, cb: Cb) { handlers.get(ev)?.delete(cb); return this },
    emit(ev: string, ...a: unknown[]) { handlers.get(ev)?.forEach((cb) => cb(...a)) },
    count(ev: string) { return handlers.get(ev)?.size ?? 0 }
  }
}
const fakeWebRequest = () => {
  let err: Cb | null = null
  let done: Cb | null = null
  return {
    onErrorOccurred: (_f: unknown, cb: Cb) => { err = cb },
    onCompleted: (_f: unknown, cb: Cb) => { done = cb },
    fireError: (d: unknown) => err?.(d),
    fireCompleted: (d: unknown) => done?.(d)
  }
}

// Electron 41's console-message: (event, MessageDetails); level 0..3 = verbose|info|warning|error
const msg = (level: number, message: string, lineNumber: number, sourceUrl: string) => ({ level, message, lineNumber, sourceUrl })

describe('attachBuffers', () => {
  it('keeps warnings and errors from console-message, not info', () => {
    const g = fakeGuest()
    const b = attachBuffers(g)
    g.emit('console-message', {}, msg(1, 'hello', 3, 'a.js'))
    g.emit('console-message', {}, msg(2, 'careful', 4, 'b.js'))
    g.emit('console-message', {}, msg(3, 'broke', 5, 'c.js'))
    expect(b.console.sinceMark()).toEqual([
      { level: 'warning', message: 'careful', source: 'b.js', line: 4 },
      { level: 'error', message: 'broke', source: 'c.js', line: 5 }
    ])
  })

  it('drops what the browser shell says about itself, keeping what the page says', () => {
    const g = fakeGuest()
    const b = attachBuffers(g)
    // The real one, watched reaching a session: Electron's own CSP notice, which every dev server
    // triggers and which is not about the page at all.
    g.emit('console-message', {}, msg(2, '%cElectron Security Warning (Insecure Content-Security-Policy)', 2, 'node:electron/js2c/sandbox_bundle'))
    g.emit('console-message', {}, msg(3, 'real', 7, 'http://localhost:4321/'))
    expect(b.console.sinceMark()).toEqual([
      { level: 'error', message: 'real', source: 'http://localhost:4321/', line: 7 }
    ])
  })

  it('reads the older positional signature too', () => {
    const g = fakeGuest()
    const b = attachBuffers(g)
    g.emit('console-message', {}, 3, 'legacy', 9, 'old.js')
    expect(b.console.sinceMark()).toEqual([{ level: 'error', message: 'legacy', source: 'old.js', line: 9 }])
  })

  it('a main-frame navigation marks both rings; a subframe one does not', () => {
    const g = fakeGuest()
    const b = attachBuffers(g)
    g.emit('console-message', {}, msg(3, 'old', 1, 'a.js'))
    g.emit('did-start-navigation', {}, 'http://localhost:5173/', false, false)   // isMainFrame=false → ignored
    expect(b.console.sinceMark()).toHaveLength(1)
    g.emit('did-start-navigation', {}, 'http://localhost:5173/', false, true)    // isMainFrame=true → mark
    g.emit('console-message', {}, msg(3, 'new', 2, 'a.js'))
    expect(b.console.sinceMark().map((e) => e.message)).toEqual(['new'])
  })

  // Electron 41's own shape: the details object is the first argument and the positional ones beside
  // it are deprecated. Read only positionally, a main-frame load would stop marking the rings the day
  // they go, and consoleErrors() would answer with the whole life of the tab.
  it('reads isMainFrame from the details object too', () => {
    const g = fakeGuest()
    const b = attachBuffers(g)
    g.emit('console-message', {}, msg(3, 'old', 1, 'a.js'))
    g.emit('did-start-navigation', { url: 'http://localhost:5173/', isSameDocument: false, isMainFrame: false })
    expect(b.console.sinceMark()).toHaveLength(1)
    g.emit('did-start-navigation', { url: 'http://localhost:5173/', isSameDocument: false, isMainFrame: true })
    g.emit('console-message', {}, msg(3, 'new', 2, 'a.js'))
    expect(b.console.sinceMark().map((e) => e.message)).toEqual(['new'])
  })

  it('detach removes the guest listeners', () => {
    const g = fakeGuest()
    const b = attachBuffers(g)
    expect(g.count('console-message')).toBe(1)
    b.detach()
    expect(g.count('console-message')).toBe(0)
    expect(g.count('did-start-navigation')).toBe(0)
  })

  it('detaching twice is safe — the second call does not throw and the listener count stays at zero', () => {
    const g = fakeGuest()
    const b = attachBuffers(g)
    b.detach()
    expect(() => b.detach()).not.toThrow()
    expect(g.count('console-message')).toBe(0)
    expect(g.count('did-start-navigation')).toBe(0)
  })
})

describe('installNetworkCapture', () => {
  it('routes failures and ≥400 completions to the buffers of the guest that made them', () => {
    const a = attachBuffers(fakeGuest())
    const other = attachBuffers(fakeGuest())
    const wr = fakeWebRequest()
    installNetworkCapture(wr, (id) => (id === 42 ? a : id === 99 ? other : null))
    wr.fireError({ webContentsId: 42, url: 'http://localhost:5173/api', method: 'GET', error: 'net::ERR_CONNECTION_REFUSED' })
    wr.fireCompleted({ webContentsId: 42, url: 'http://localhost:5173/x', method: 'POST', statusCode: 500 })
    wr.fireCompleted({ webContentsId: 42, url: 'http://localhost:5173/ok', method: 'GET', statusCode: 200 })
    wr.fireError({ webContentsId: 99, url: 'http://localhost:5173/other', method: 'GET', error: 'x' })
    expect(a.network.sinceMark()).toEqual([
      { url: 'http://localhost:5173/api', method: 'GET', error: 'net::ERR_CONNECTION_REFUSED' },
      { url: 'http://localhost:5173/x', method: 'POST', status: 500 }
    ])
    expect(other.network.sinceMark()).toEqual([{ url: 'http://localhost:5173/other', method: 'GET', error: 'x' }])
  })

  it('drops a request the browser abandoned because another navigation replaced it', () => {
    const wr = fakeWebRequest()
    const a = attachBuffers(fakeGuest())
    installNetworkCapture(wr, (id) => (id === 42 ? a : null))
    // Every first open() produces one of these: the tab is created pointing at the url and the
    // helper's own loadURL supersedes that first load. It is not a failure of the page.
    wr.fireError({ webContentsId: 42, url: 'http://localhost:4321/', method: 'GET', error: 'net::ERR_ABORTED' })
    wr.fireError({ webContentsId: 42, url: 'http://localhost:4321/api', method: 'GET', error: 'net::ERR_CONNECTION_REFUSED' })
    expect(a.network.sinceMark()).toEqual([
      { url: 'http://localhost:4321/api', method: 'GET', error: 'net::ERR_CONNECTION_REFUSED' }
    ])
  })

  it('drops a request whose guest is not an agent tab, and one with no webContentsId', () => {
    const a = attachBuffers(fakeGuest())
    const wr = fakeWebRequest()
    installNetworkCapture(wr, (id) => (id === 1 ? a : null))
    wr.fireCompleted({ webContentsId: 7, url: 'u', method: 'GET', statusCode: 500 })
    wr.fireCompleted({ url: 'u', method: 'GET', statusCode: 500 })
    expect(a.network.sinceMark()).toEqual([])
  })
})

// The bookkeeping ipc.ts's register/unregister handlers drive. A leak here is invisible in the app —
// nothing looks wrong, the process just holds one dead guest's listeners more after every remount —
// so the two indexes going away together is what these pin down.
describe('AgentBufferStore', () => {
  it('forget detaches the buffers and clears both indexes', () => {
    const store = new AgentBufferStore()
    const g = fakeGuest()
    const b = attachBuffers(g)
    store.set('s1', 42, b)
    expect(store.bySession('s1')).toBe(b)
    expect(store.byWebContents(42)).toBe(b)
    store.forget('s1')
    expect(g.count('console-message')).toBe(0)
    expect(g.count('did-start-navigation')).toBe(0)
    expect(store.bySession('s1')).toBeNull()
    expect(store.byWebContents(42)).toBeNull()
  })

  // The remount path: BrowserPane comes back with a new <webview>, so the same session registers a
  // second guest. The first one's listeners have to go, and its id must not keep answering lookups —
  // otherwise the old guest's buffers stay reachable from the network capture forever.
  it('re-registering a session under a new webContentsId detaches the old buffers and leaves no entry under the old id', () => {
    const store = new AgentBufferStore()
    const first = fakeGuest()
    const oldBuffers = attachBuffers(first)
    store.set('s1', 42, oldBuffers)
    const second = fakeGuest()
    const newBuffers = attachBuffers(second)
    store.set('s1', 77, newBuffers)
    expect(first.count('console-message')).toBe(0) // the old guest was detached
    expect(second.count('console-message')).toBe(1) // the new one is still listening
    expect(store.byWebContents(42)).toBeNull()
    expect(store.byWebContents(77)).toBe(newBuffers)
    expect(store.bySession('s1')).toBe(newBuffers)
  })

  it('an unknown webContentsId looks up nothing', () => {
    const store = new AgentBufferStore()
    store.set('s1', 42, attachBuffers(fakeGuest()))
    expect(store.byWebContents(43)).toBeNull()
    expect(store.bySession('s2')).toBeNull()
  })

  it('forgetting a session it never had is a no-op', () => {
    const store = new AgentBufferStore()
    const g = fakeGuest()
    store.set('s1', 42, attachBuffers(g))
    store.forget('s2')
    expect(store.bySession('s1')).not.toBeNull()
    expect(g.count('console-message')).toBe(1) // s1's guest was not touched
  })
})
