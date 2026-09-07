import { describe, it, expect } from 'vitest'
import { AgentGuestRegistry, type GuestLike } from './registry'

const guest = (id: number, type = 'webview', destroyed = false): GuestLike => ({ id, isDestroyed: () => destroyed, getType: () => type })

describe('AgentGuestRegistry', () => {
  it('finds a registered, live webview guest by session', () => {
    const g = guest(7)
    const reg = new AgentGuestRegistry((id) => (id === 7 ? g : undefined))
    reg.register('s1', 7, 'D:/p')
    expect(reg.has('s1')).toBe(true)
    expect(reg.cwdOf('s1')).toBe('D:/p')
    expect(reg.guestOf('s1')).toBe(g)
    expect(reg.isAgentGuest(7)).toBe(true)
    expect(reg.isAgentGuest(8)).toBe(false)
  })

  it('null for a destroyed guest, a non-webview, or an unknown session', () => {
    const reg = new AgentGuestRegistry((id) => (id === 1 ? guest(1, 'webview', true) : id === 2 ? guest(2, 'window') : undefined))
    reg.register('dead', 1, 'D:/p')
    reg.register('win', 2, 'D:/p')
    reg.register('gone', 3, 'D:/p')
    expect(reg.guestOf('dead')).toBeNull()
    expect(reg.guestOf('win')).toBeNull()
    expect(reg.guestOf('gone')).toBeNull()
    expect(reg.guestOf('never')).toBeNull()
  })

  it('re-registering a session replaces its old guest id, not adds to it', () => {
    const reg = new AgentGuestRegistry(() => guest(9))
    reg.register('s', 7, 'D:/p')
    reg.register('s', 9, 'D:/p')
    expect(reg.isAgentGuest(7)).toBe(false)
    expect(reg.isAgentGuest(9)).toBe(true)
  })

  it('unregister forgets the session and the guest id', () => {
    const reg = new AgentGuestRegistry(() => guest(5))
    reg.register('s', 5, 'D:/p')
    reg.unregister('s')
    expect(reg.has('s')).toBe(false)
    expect(reg.isAgentGuest(5)).toBe(false)
  })

  it('waitFor resolves when the registration arrives, and null when it does not in time', async () => {
    const g = guest(9)
    const reg = new AgentGuestRegistry(() => g)
    const p = reg.waitFor('late', 200)
    setTimeout(() => reg.register('late', 9, 'D:/p'), 20)
    expect(await p).toBe(g)
    expect(await reg.waitFor('never', 20)).toBeNull()
  })

  it('a registration arriving after waitFor timed out resolves nothing late, and the next wait works', async () => {
    const g = guest(6)
    const reg = new AgentGuestRegistry(() => g)
    expect(await reg.waitFor('slow', 10)).toBeNull()
    reg.register('slow', 6, 'D:/p')
    expect(await reg.waitFor('slow', 10)).toBe(g)
  })

  it('one waiter timing out leaves a second waiter on the same session still waiting', async () => {
    const g = guest(6)
    const reg = new AgentGuestRegistry(() => g)
    const short = reg.waitFor('two', 10)
    const long = reg.waitFor('two', 500)
    expect(await short).toBeNull()
    reg.register('two', 6, 'D:/p')
    expect(await long).toBe(g)
  })

  it('waitFor on an already-registered session resolves at once', async () => {
    const g = guest(4)
    const reg = new AgentGuestRegistry(() => g)
    reg.register('now', 4, 'D:/p')
    expect(await reg.waitFor('now', 10)).toBe(g)
  })
})
