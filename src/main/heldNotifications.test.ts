import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHeldNotifications } from './heldNotifications'

// Performance audit M7: Windows does not always send 'close', so a toast nobody clicked stayed held for the app's
// life, and one the OS failed to show stayed held too. Held until clicked, closed or failed, and only the newest few.
describe('createHeldNotifications', () => {
  it('lets go of a notification once it is clicked, closed or failed', () => {
    const held = createHeldNotifications(10)
    const [a, b, c] = [new EventEmitter(), new EventEmitter(), new EventEmitter()]
    held.hold(a)
    held.hold(b)
    held.hold(c)
    expect(held.size()).toBe(3)
    a.emit('click')
    b.emit('close')
    c.emit('failed', 'denied')
    expect(held.size()).toBe(0)
  })

  it('holds only the newest ones', () => {
    const held = createHeldNotifications(3)
    const all = Array.from({ length: 5 }, () => new EventEmitter())
    for (const n of all) held.hold(n)
    expect(held.size()).toBe(3)
    expect(held.has(all[0])).toBe(false)
    expect(held.has(all[4])).toBe(true)
  })
})
