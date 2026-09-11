import { describe, it, expect } from 'vitest'
import { createPtyRouter } from './ptyRouter'
import type { PtyFactory, PtyLike } from '../../core/sessions/pty'

const stub = (tag: string, calls: string[]): PtyFactory => (file) => {
  calls.push(`${tag}:${file}`)
  return { pid: 1, onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {}, pause: () => {}, resume: () => {} } as PtyLike
}

const opts = { cwd: 'D:/p', cols: 80, rows: 24, env: {} }

describe('createPtyRouter', () => {
  // The three managers are built before the Host client exists, so the factory they are handed has
  // to be the same object for the app's whole life.
  it('uses the fallback until a factory is given, and the given one after', () => {
    const calls: string[] = []
    const r = createPtyRouter(stub('local', calls))
    r.factory('a', [], opts)
    r.use(stub('host', calls))
    r.factory('b', [], opts)
    expect(calls).toEqual(['local:a', 'host:b'])
  })

  it('falls back again when the factory is taken away', () => {
    const calls: string[] = []
    const r = createPtyRouter(stub('local', calls))
    r.use(stub('host', calls))
    r.use(null)
    r.factory('c', [], opts)
    expect(calls).toEqual(['local:c'])
  })

  // The Host client installs the factory on every completed handshake, not only the first, so that a
  // first handshake landing after startup gave up still switches the router. That makes a repeat
  // install ordinary rather than a mistake, and it has to stay a no-op for everything already running.
  it('installing the same factory again changes nothing, for the next call or for a live handle', () => {
    const calls: string[] = []
    const host: PtyFactory = (file) => {
      calls.push(`host:${file}`)
      return {
        pid: 1,
        onData: () => {},
        onExit: () => {},
        write: (data) => calls.push(`host:write:${data}`),
        resize: () => {},
        kill: () => {},
        pause: () => {},
        resume: () => {}
      } as PtyLike
    }
    const r = createPtyRouter(stub('local', calls))
    r.use(host)
    const p = r.factory('a', [], opts)
    r.use(host)
    p.write('still mine')
    r.factory('b', [], opts)
    expect(calls).toEqual(['host:a', 'host:write:still mine', 'host:b'])
  })

  // **Who made a pty is the one thing nobody can work out afterwards.** The quit path has to end the
  // ptys that are this process's own children and leave the Host's alone, and by then both are the
  // same PtyLike behind the same manager. The router is the only place that still knows, so it says
  // so on the handle it hands back and the answer travels with the pty.
  it('marks each handle with whether its pty outlives the app, from the factory it routed to', () => {
    const r = createPtyRouter(stub('local', []))
    expect(r.factory('a', [], opts).outlivesApp).toBe(false)
    r.use(stub('host', []))
    expect(r.factory('b', [], opts).outlivesApp).toBe(true)
    r.use(null)
    expect(r.factory('c', [], opts).outlivesApp).toBe(false)
  })

  // use() changes which factory the *next* call to r.factory reaches — it does not touch a PtyLike
  // handle already handed back. A pty spawned through the fallback keeps behaving exactly as it did
  // before the switch: nothing about it is retargeted onto the Host.
  it('leaves a handle already spawned through the fallback alone when a Host factory arrives', () => {
    const calls: string[] = []
    const writing: PtyFactory = (file) => {
      calls.push(`local:${file}`)
      return {
        pid: 1,
        onData: () => {},
        onExit: () => {},
        write: (data) => calls.push(`local:write:${data}`),
        resize: () => {},
        kill: () => {},
        pause: () => {},
        resume: () => {}
      } as PtyLike
    }
    const r = createPtyRouter(writing)
    const p = r.factory('a', [], opts)
    r.use(stub('host', calls))
    p.write('still local')
    expect(calls).toEqual(['local:a', 'local:write:still local'])
  })
})
