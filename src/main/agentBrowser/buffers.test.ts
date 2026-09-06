import { describe, it, expect } from 'vitest'
import { attachBuffers, installNetworkCapture } from './buffers'

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

  it('detach removes the guest listeners', () => {
    const g = fakeGuest()
    const b = attachBuffers(g)
    expect(g.count('console-message')).toBe(1)
    b.detach()
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

  it('drops a request whose guest is not an agent tab, and one with no webContentsId', () => {
    const a = attachBuffers(fakeGuest())
    const wr = fakeWebRequest()
    installNetworkCapture(wr, (id) => (id === 1 ? a : null))
    wr.fireCompleted({ webContentsId: 7, url: 'u', method: 'GET', statusCode: 500 })
    wr.fireCompleted({ url: 'u', method: 'GET', statusCode: 500 })
    expect(a.network.sinceMark()).toEqual([])
  })
})
