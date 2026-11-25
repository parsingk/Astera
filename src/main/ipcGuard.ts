// The IPC sender check (spec E3, the Phase 0 audit section 5 item 4). Every handler main registers answers only the app's
// own window: a webContents main trusted (the main window), its top frame, showing the app's own document. A <webview>
// guest, a frame inside the page, or the window after it navigated somewhere else gets a refusal instead, so a plugin
// UI or a page that slips into the renderer later cannot reach a handler.
//
// One facade over electron's ipcMain rather than a check in each of the ~360 handlers: the files that register take
// `ipcMain` from here, kube and Higgsfield receive it from ipc.ts, and ipcGuard.test.ts fails when a file imports
// ipcMain from electron directly. The decision is made on every call, so a handler registered before the window
// exists checks the window that sends.
import { ipcMain as electronIpcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'

/* eslint-disable @typescript-eslint/no-explicit-any -- the same listener shape electron's own IpcMain declares */
export type GuardedIpcMain = {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void
  on(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void): void
  /** A channel only a trusted plugin panel guest answers (ADR-008): its top frame, on its own plugin host. The listener is
   *  handed the guest's identity as main recorded it when the guest attached, never anything from the message. */
  handleGuest(channel: string, listener: (event: IpcMainInvokeEvent, guest: GuestIdentity, ...args: any[]) => unknown): void
}

/** A plugin panel guest as main recorded it when it attached (main/plugins/panelGuests.ts). */
export type GuestIdentity = { pluginId: string; host: string }

/** What the guard registers on: electron's ipcMain, or a fake in the tests. */
type Target = {
  handle(channel: string, listener: (event: any, ...args: any[]) => unknown): void
  on(channel: string, listener: (event: any, ...args: any[]) => void): unknown
}
/* eslint-enable @typescript-eslint/no-explicit-any */
type TrustedContents = { id: number; once: (event: 'destroyed', listener: () => void) => unknown }
type SenderEvent = { sender: { id: number }; senderFrame: { url: string; parent: unknown } | null }

export function createIpcGuard(
  target: Target,
  log: (message: string) => void
): {
  ipcMain: GuardedIpcMain
  trust: (contents: TrustedContents, isOwnDocument: (url: string) => boolean) => void
  trustGuest: (contents: TrustedContents, guest: GuestIdentity) => void
} {
  const trusted = new Map<number, (url: string) => boolean>()
  const guests = new Map<number, GuestIdentity>()
  /** A trusted guest's top frame on its own plugin host; the guest it is, or null. */
  const guestOf = (e: SenderEvent): GuestIdentity | null => {
    const guest = guests.get(e.sender.id)
    const frame = e.senderFrame
    if (!guest || !frame || frame.parent !== null || !frame.url.startsWith(`astera-plugin://${guest.host}/`)) return null
    return guest
  }
  const logged = new Set<string>()
  const allowed = (e: SenderEvent): boolean => {
    const frame = e.senderFrame
    const isOwnDocument = trusted.get(e.sender.id)
    // A frame that is gone reads as null; a frame with a parent is inside the page, not the page
    return !!frame && frame.parent === null && !!isOwnDocument && isOwnDocument(frame.url)
  }
  const refuse = (channel: string, e: SenderEvent): void => {
    if (logged.has(channel)) return
    logged.add(channel)
    log(`[ipc] refused ${channel} from ${e.senderFrame?.url ?? 'a frame that is gone'} (webContents ${e.sender.id})`)
  }
  const ipcMain: GuardedIpcMain = {
    handle(channel, listener) {
      target.handle(channel, (e: SenderEvent, ...args: unknown[]) => {
        if (!allowed(e)) {
          refuse(channel, e)
          throw new Error(`IPC_SENDER_REFUSED: ${channel}`)
        }
        return (listener as (e: unknown, ...a: unknown[]) => unknown)(e, ...args)
      })
    },
    on(channel, listener) {
      target.on(channel, (e: SenderEvent & { returnValue?: unknown }, ...args: unknown[]) => {
        if (!allowed(e)) {
          refuse(channel, e)
          // A refused sendSync is otherwise answered only at main's next garbage collection, the sender frozen till
          // then; on an ordinary message the value goes nowhere
          e.returnValue = null
          return
        }
        ;(listener as (e: unknown, ...a: unknown[]) => void)(e, ...args)
      })
    },
    handleGuest(channel, listener) {
      target.handle(channel, (e: SenderEvent, ...args: unknown[]) => {
        const guest = guestOf(e)
        if (guest === null) {
          refuse(channel, e)
          throw new Error(`IPC_SENDER_REFUSED: ${channel}`)
        }
        return (listener as (e: unknown, g: GuestIdentity, ...a: unknown[]) => unknown)(e, guest, ...args)
      })
    }
  }
  return {
    ipcMain,
    trust(contents, isOwnDocument) {
      trusted.set(contents.id, isOwnDocument)
      contents.once('destroyed', () => trusted.delete(contents.id))
    },
    trustGuest(contents, guest) {
      guests.set(contents.id, guest)
      contents.once('destroyed', () => guests.delete(contents.id))
    }
  }
}

const guard = createIpcGuard(electronIpcMain, (message) => console.warn(message))

/** electron's ipcMain behind the sender check: what every file in main registers handlers on. */
export const ipcMain = guard.ipcMain

/** Lets one webContents (the main window) reach the handlers while its top frame shows the app's own document. */
export const trustWebContents = guard.trust

/** Lets one plugin panel guest reach the guest channels while its top frame is on its plugin host (ADR-008). */
export const trustPluginGuest = guard.trustGuest
