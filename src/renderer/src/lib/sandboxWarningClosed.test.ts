// Task E fix round 3: the line above a sandboxed session's terminal or chat that says its start warning can be closed,
// and stays closed for that session: across a tab switch (a chat's pane unmounts), a move to another pane and an app
// restart (a session the Host keeps comes back under its own id).
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A module singleton, so each test imports it afresh (as hiddenProjects.test.ts does)
let mod: typeof import('./sandboxWarningClosed')
let store: Record<string, string>

/** vitest runs with environment: 'node', which has no localStorage: a minimal one, put in before the import. */
function installStorage(initial: Record<string, string> = {}, opts: { failSetItem?: boolean; failGetItem?: boolean } = {}): void {
  store = { ...initial }
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string): string | null => {
      if (opts.failGetItem) throw new Error('storage disabled')
      return k in store ? store[k] : null
    },
    setItem: (k: string, v: string): void => {
      if (opts.failSetItem) throw new Error('quota exceeded')
      store[k] = v
    },
    removeItem: (k: string): void => {
      delete store[k]
    }
  }
}

const load = async (initial?: Record<string, string>, opts?: { failSetItem?: boolean; failGetItem?: boolean }): Promise<void> => {
  vi.resetModules()
  installStorage(initial, opts)
  mod = await import('./sandboxWarningClosed')
}

beforeEach(async () => {
  await load()
})

describe('the closed sandbox warning lines', () => {
  it('closes one session’s line and no other, and tells the listeners once', () => {
    let calls = 0
    mod.subscribe(() => calls++)
    expect(mod.isClosed('s1')).toBe(false)
    mod.close('s1')
    mod.close('s1')
    expect(mod.isClosed('s1')).toBe(true)
    expect(mod.isClosed('s2')).toBe(false)
    expect(calls).toBe(1)
  })

  it('stays closed after a restart', async () => {
    mod.close('s1')
    await load(store)
    expect(mod.isClosed('s1')).toBe(true)
  })

  it('keeps only the most recent sessions it was told, so the list does not grow for ever', async () => {
    for (let i = 0; i < mod.CLOSED_KEPT + 5; i++) mod.close(`s${i}`)
    await load(store)
    expect(mod.isClosed('s0')).toBe(false)
    expect(mod.isClosed('s4')).toBe(false)
    expect(mod.isClosed('s5')).toBe(true)
    expect(mod.isClosed(`s${mod.CLOSED_KEPT + 4}`)).toBe(true)
  })

  it('reads a broken or foreign value as nothing closed, and closes for this run when it cannot be kept', async () => {
    await load({ 'cm.sandboxWarningClosed': '{ broken' })
    expect(mod.isClosed('s1')).toBe(false)
    await load({ 'cm.sandboxWarningClosed': JSON.stringify(['s1', 7, null]) })
    expect(mod.isClosed('s1')).toBe(true)
    await load({}, { failSetItem: true })
    mod.close('s1')
    expect(mod.isClosed('s1')).toBe(true)
    await load({}, { failGetItem: true })
    expect(mod.isClosed('s1')).toBe(false)
  })

  it('stops telling a listener that unsubscribed', () => {
    let calls = 0
    const off = mod.subscribe(() => calls++)
    off()
    mod.close('s1')
    expect(calls).toBe(0)
  })
})
