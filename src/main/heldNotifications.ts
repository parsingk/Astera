// Notifications currently on screen. Electron does not retain a `new Notification()` for you: an unreferenced one can
// be garbage-collected before it is clicked, and a collected notification never fires 'click'. That hits hardest the
// toast this feature exists for, the one that sits unclicked until someone walks back to the desk.
//
// Held until clicked, closed or failed (performance audit M7). Windows does not guarantee 'close', so a toast nobody
// touched used to be held for the app's life; only the newest `max` are held, and a toast that old is long gone from
// the screen's stack.

/** What this needs of a Notification: its events. */
export interface NotificationEvents {
  on(event: 'click' | 'close' | 'failed', listener: (...args: unknown[]) => void): unknown
}

export const NOTIFICATIONS_HELD = 64

export function createHeldNotifications(max = NOTIFICATIONS_HELD): {
  hold(n: NotificationEvents): void
  has(n: NotificationEvents): boolean
  size(): number
} {
  const held = new Set<NotificationEvents>()
  return {
    hold: (n) => {
      held.add(n)
      const release = (): void => void held.delete(n)
      n.on('click', release)
      n.on('close', release)
      n.on('failed', release)
      for (const old of held) {
        if (held.size <= max) break
        held.delete(old)
      }
    },
    has: (n) => held.has(n),
    size: () => held.size
  }
}
