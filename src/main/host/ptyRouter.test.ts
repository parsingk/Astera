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

  // The quit path asks this before it decides whether to end every running session (main/index.ts's
  // will-quit). With no Host the ptys are this process's own children and killing them is still
  // right; with a Host they belong to a process that outlives this one, and killing them would undo
  // the whole slice.
  it('says the ptys do not outlive the app until a Host factory is installed', () => {
    const r = createPtyRouter(stub('local', []))
    expect(r.ptysOutliveApp()).toBe(false)
    r.use(stub('host', []))
    expect(r.ptysOutliveApp()).toBe(true)
    r.use(null)
    expect(r.ptysOutliveApp()).toBe(false)
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
