// Second pass M2-3: each DevTools window left a `destroyed` and a `devtools-closed` listener on its guest when the person
// closed it, so a preview tab whose DevTools were opened and closed ten times warned MaxListenersExceeded and held ten
// destroyed windows.
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { wireDevtoolsWindow } from './devtoolsWiring'

const fakeHost = () => Object.assign(new EventEmitter(), { destroyed: false, isDestroyed() { return this.destroyed }, close() { this.emit('closed') } })
const fakeGuest = () => Object.assign(new EventEmitter(), { open: true, isDestroyed: () => false, isDevToolsOpened() { return this.open }, closeDevTools() { this.open = false } })

describe('wireDevtoolsWindow', () => {
  it('a window the person closes takes its listeners off the guest', () => {
    const guest = fakeGuest()
    for (let i = 0; i < 12; i++) {
      const host = fakeHost()
      let forgot = 0
      wireDevtoolsWindow(host, guest, () => void forgot++)
      host.emit('closed')
      expect(forgot).toBe(1)
    }
    expect(guest.listenerCount('destroyed')).toBe(0)
    expect(guest.listenerCount('devtools-closed')).toBe(0)
    expect(guest.open).toBe(false)
  })

  it('the guest closing DevTools closes the window', () => {
    const guest = fakeGuest()
    const host = fakeHost()
    let closed = 0
    host.on('closed', () => void closed++)
    wireDevtoolsWindow(host, guest, () => {})
    guest.emit('devtools-closed')
    expect(closed).toBe(1)
    expect(guest.listenerCount('destroyed')).toBe(0)
  })
})
