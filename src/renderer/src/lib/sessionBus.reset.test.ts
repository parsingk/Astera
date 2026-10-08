// A remote session tab's checkpoint on the session bus (remote runtime design Phase 9b): `session:reset` replaces what
// was held for the tab, reaches the view that registered for it, and is held for a view that has not mounted yet.
import { describe, it, expect, beforeAll } from 'vitest'

const handlers = new Map<string, (p: unknown) => void>()
const fire = (channel: string, payload: unknown): void => handlers.get(channel)?.(payload)

let bus: typeof import('./sessionBus')
beforeAll(async () => {
  ;(globalThis as { window?: unknown }).window = {
    api: {
      on: (channel: string, fn: (p: unknown) => void) => {
        handlers.set(channel, fn)
        return () => handlers.delete(channel)
      },
      system: { rendererReady: () => {} },
      sessions: { write: () => {} }
    }
  }
  bus = await import('./sessionBus')
  bus.init()
})

const reset = (sessionId: string, state: string, pending = '') => ({ sessionId, state, pending, cols: 80, rows: 24 })

describe('sessionBus reset', () => {
  it('a reset drops output held before it, and a view mounting later gets the checkpoint, then what came after', () => {
    fire('session:data', { sessionId: 'rt:a', data: 'old' })
    fire('session:reset', reset('rt:a', 'STATE', 'P'))
    fire('session:data', { sessionId: 'rt:a', data: 'new' })
    const got: string[] = []
    bus.onReset('rt:a', (c) => void got.push(`reset:${c.state}${c.pending}`))
    bus.attach('rt:a', (d) => void got.push(d))
    expect(got).toEqual(['reset:STATEP', 'new'])
  })

  it('a mounted view gets each reset as it comes, never as data', () => {
    const got: string[] = []
    const offReset = bus.onReset('rt:b', (c) => void got.push(`reset:${c.state}`))
    const off = bus.attach('rt:b', (d) => void got.push(d))
    fire('session:data', { sessionId: 'rt:b', data: 'x' })
    fire('session:reset', reset('rt:b', 'S2'))
    fire('session:data', { sessionId: 'rt:b', data: 'y' })
    expect(got).toEqual(['x', 'reset:S2', 'y'])
    off()
    offReset()
  })

  it('a held checkpoint is handed over once; discard forgets it', () => {
    fire('session:reset', reset('rt:c', 'S'))
    const first: string[] = []
    bus.onReset('rt:c', (c) => void first.push(c.state))()
    const second: string[] = []
    bus.onReset('rt:c', (c) => void second.push(c.state))()
    expect(first).toEqual(['S'])
    expect(second).toEqual([])
    fire('session:reset', reset('rt:d', 'S'))
    bus.discard('rt:d')
    const none: string[] = []
    bus.onReset('rt:d', (c) => void none.push(c.state))
    expect(none).toEqual([])
  })
})
