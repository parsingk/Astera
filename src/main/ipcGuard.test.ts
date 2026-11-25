// The IPC sender check (spec E3, the Phase 0 audit section 5 item 4): every handler answers only the app's own window.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { createIpcGuard } from './ipcGuard'

type Listener = (e: unknown, ...args: unknown[]) => unknown

function fakeIpc(): { handle: (c: string, l: Listener) => void; on: (c: string, l: Listener) => void; handlers: Map<string, Listener>; listeners: Map<string, Listener> } {
  const handlers = new Map<string, Listener>()
  const listeners = new Map<string, Listener>()
  return { handle: (c, l) => void handlers.set(c, l), on: (c, l) => void listeners.set(c, l), handlers, listeners }
}

const OWN = 'file:///app/out/renderer/index.html'
const isOwn = (url: string): boolean => url === OWN
const webContents = (id: number): { id: number; once: (ev: string, cb: () => void) => void; destroy: () => void } => {
  let onDestroyed: (() => void) | null = null
  return { id, once: (_ev, cb) => void (onDestroyed = cb), destroy: () => onDestroyed?.() }
}
const event = (senderId: number, frame: { url: string; parent: unknown } | null = { url: OWN, parent: null }): unknown => ({
  sender: { id: senderId },
  senderFrame: frame
})

describe('the IPC sender check', () => {
  it('answers the trusted window’s top frame on the app’s own document', async () => {
    const target = fakeIpc()
    const guard = createIpcGuard(target, () => {})
    const handler = vi.fn(async (_e: unknown, a: unknown) => `got ${String(a)}`)
    const listener = vi.fn()
    guard.ipcMain.handle('files.read', handler as never)
    guard.ipcMain.on('sessions.write', listener as never)
    guard.trust(webContents(1), isOwn)
    expect(await target.handlers.get('files.read')!(event(1), 'x')).toBe('got x')
    target.listeners.get('sessions.write')!(event(1), 's1', 'data')
    expect(listener).toHaveBeenCalledWith(event(1), 's1', 'data')
  })

  it('refuses another webContents, a subframe, a frame that is gone and another document', async () => {
    const target = fakeIpc()
    const guard = createIpcGuard(target, () => {})
    const handler = vi.fn()
    const listener = vi.fn()
    guard.ipcMain.handle('files.read', handler as never)
    guard.ipcMain.on('sessions.write', listener as never)
    guard.trust(webContents(1), isOwn)
    const refused = [
      event(2),
      event(1, { url: OWN, parent: { url: OWN } }),
      event(1, null),
      event(1, { url: 'http://127.0.0.1:5173/', parent: null })
    ]
    for (const e of refused) {
      await expect(Promise.resolve().then(() => target.handlers.get('files.read')!(e))).rejects.toThrow('IPC_SENDER_REFUSED: files.read')
      target.listeners.get('sessions.write')!(e, 's1', 'data')
    }
    expect(handler).not.toHaveBeenCalled()
    expect(listener).not.toHaveBeenCalled()
  })

  // Handlers are registered before the window exists (registerIpc runs ahead of trust in some starts)
  it('decides on each call, so trust given after registration counts and a destroyed window loses it', async () => {
    const target = fakeIpc()
    const guard = createIpcGuard(target, () => {})
    guard.ipcMain.handle('ping', (() => 'pong') as never)
    const call = (): Promise<unknown> => Promise.resolve().then(() => target.handlers.get('ping')!(event(7)))
    await expect(call()).rejects.toThrow('IPC_SENDER_REFUSED: ping')
    const wc = webContents(7)
    guard.trust(wc, isOwn)
    expect(await call()).toBe('pong')
    wc.destroy()
    await expect(call()).rejects.toThrow('IPC_SENDER_REFUSED: ping')
  })

  // Final review I2: a refused sendSync was answered only at main's next garbage collection, freezing the sender
  it('answers a refused synchronous call at once, with null', () => {
    const target = fakeIpc()
    const guard = createIpcGuard(target, () => {})
    guard.ipcMain.on('clipboard.readTextSync', ((e: { returnValue: unknown }) => {
      e.returnValue = 'text'
    }) as never)
    const refused = { ...(event(9) as object), returnValue: undefined as unknown }
    target.listeners.get('clipboard.readTextSync')!(refused)
    expect(refused.returnValue).toBeNull()
  })

  it('logs a refusal once per channel, naming the sender’s address', async () => {
    const target = fakeIpc()
    const log = vi.fn()
    const guard = createIpcGuard(target, log)
    guard.ipcMain.on('win.close', (() => {}) as never)
    const bad = event(3, { url: 'http://evil.localhost/', parent: null })
    target.listeners.get('win.close')!(bad)
    target.listeners.get('win.close')!(bad)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toContain('win.close')
    expect(log.mock.calls[0][0]).toContain('http://evil.localhost/')
  })
})

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Does this source reach electron's ipcMain, or a webContents' or frame's own ipc, past the guard. */
function bypassesGuard(text: string): boolean {
  const electron = `['"]electron(?:/main)?['"]`
  if (new RegExp(`import\\s*\\{[^}]*\\bipcMain\\b[^}]*\\}\\s*from\\s*${electron}`).test(text)) return true
  if (new RegExp(`\\{[^}]*\\bipcMain\\b[^}]*\\}\\s*=\\s*require\\(\\s*${electron}\\s*\\)`).test(text)) return true
  for (const m of text.matchAll(new RegExp(`import\\s+(?:\\*\\s+as\\s+)?(\\w+)\\s+from\\s+${electron}`, 'g'))) {
    if (new RegExp(`\\b${m[1]}\\.ipcMain\\b`).test(text)) return true
  }
  return /\.ipc\.(?:handle|handleOnce|on|once)\(/.test(text)
}

// One guard for every handler: a file importing ipcMain straight from electron would register past it
describe('every handler goes through the guard', () => {
  const mainDir = __dirname
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) files.push(p)
    }
  }
  walk(mainDir)

  it('the detector catches every way past the guard (final review M1)', () => {
    for (const text of [
      "import { ipcMain } from 'electron'",
      'import { app, ipcMain as ipc } from "electron"',
      "import { ipcMain } from 'electron/main'",
      "import * as electron from 'electron'\nelectron.ipcMain.handle('x', f)",
      "import electron from 'electron'\nelectron.ipcMain.on('x', f)",
      "const { ipcMain } = require('electron')",
      "win.webContents.ipc.handle('x', f)",
      "frame.ipc.on('x', f)"
    ]) {
      expect(bypassesGuard(text), text).toBe(true)
    }
    for (const text of [
      "import { ipcMain } from './ipcGuard'",
      "import { app, webContents } from 'electron'",
      "import * as electron from 'electron'\nelectron.app.quit()",
      'const ipcMainLike = 1'
    ]) {
      expect(bypassesGuard(text), text).toBe(false)
    }
  })

  it('no file but the guard reaches electron’s ipcMain or a webContents ipc', () => {
    const offenders = files.filter((f) => path.basename(f) !== 'ipcGuard.ts' && bypassesGuard(readFileSync(f, 'utf8')))
    expect(offenders.map((f) => path.relative(mainDir, f))).toEqual([])
  })

  it('the files that register handlers take ipcMain from the guard, and the main window is trusted', () => {
    for (const [file, from] of [
      ['ipc.ts', './ipcGuard'],
      ['index.ts', './ipcGuard'],
      ['preview/capture.ts', '../ipcGuard'],
      ['preview/devtools.ts', '../ipcGuard'],
      ['preview/emulation.ts', '../ipcGuard']
    ]) {
      expect(readFileSync(path.join(mainDir, file), 'utf8')).toMatch(new RegExp(`import \\{[^}]*\\bipcMain\\b[^}]*\\} from '${escapeRe(from)}'`))
    }
    const index = readFileSync(path.join(mainDir, 'index.ts'), 'utf8')
    expect(index).toMatch(/trustWebContents\(win\.webContents, \(url\) => isOwnDocument\(url, process\.env\['ELECTRON_RENDERER_URL'\], indexFileUrl\)\)/)
  })
})

// Plugin panel guests (ADR-008): the bridge channel answers a trusted guest's own top frame on its plugin host, and the
// main window's channels never answer a guest
describe('the guest channel', () => {
  const guestEvent = (id: number, url: string, parent: unknown = null): unknown => ({ sender: { id }, senderFrame: { url, parent } })

  it('answers a trusted guest’s top frame on its plugin host, handing the handler the guest it trusted', async () => {
    const target = fakeIpc()
    const guard = createIpcGuard(target, () => {})
    const seen: unknown[] = []
    guard.ipcMain.handleGuest('plugin-ui.call', ((_e: unknown, guest: unknown, method: unknown) => {
      seen.push([guest, method])
      return 'ok'
    }) as never)
    guard.trustGuest(webContents(9), { pluginId: 'hello-panel', host: 'hello-panel' })
    expect(await target.handlers.get('plugin-ui.call')!(guestEvent(9, 'astera-plugin://hello-panel/dist/ui/index.html?panel=main'), 'context')).toBe('ok')
    expect(seen).toEqual([[{ pluginId: 'hello-panel', host: 'hello-panel' }, 'context']])
  })

  it('refuses an untrusted guest, a guest that navigated off its host, a subframe and a guest that is gone', async () => {
    const target = fakeIpc()
    const guard = createIpcGuard(target, () => {})
    guard.ipcMain.handleGuest('plugin-ui.call', (() => 'ok') as never)
    const wc = webContents(9)
    guard.trustGuest(wc, { pluginId: 'hello-panel', host: 'hello-panel' })
    const call = (e: unknown): Promise<unknown> => Promise.resolve().then(() => target.handlers.get('plugin-ui.call')!(e, 'context'))
    await expect(call(guestEvent(10, 'astera-plugin://hello-panel/x.html'))).rejects.toThrow('IPC_SENDER_REFUSED: plugin-ui.call')
    await expect(call(guestEvent(9, 'astera-plugin://other/x.html'))).rejects.toThrow('IPC_SENDER_REFUSED: plugin-ui.call')
    await expect(call(guestEvent(9, 'astera-plugin://hello-panel/x.html', { url: 'x' }))).rejects.toThrow('IPC_SENDER_REFUSED: plugin-ui.call')
    wc.destroy()
    await expect(call(guestEvent(9, 'astera-plugin://hello-panel/x.html'))).rejects.toThrow('IPC_SENDER_REFUSED: plugin-ui.call')
  })

  it('never lets a trusted guest reach the main window’s channels', async () => {
    const target = fakeIpc()
    const guard = createIpcGuard(target, () => {})
    guard.ipcMain.handle('files.read', (() => 'secret') as never)
    guard.trustGuest(webContents(9), { pluginId: 'hello-panel', host: 'hello-panel' })
    await expect(Promise.resolve().then(() => target.handlers.get('files.read')!(guestEvent(9, 'astera-plugin://hello-panel/x.html')))).rejects.toThrow(
      'IPC_SENDER_REFUSED: files.read'
    )
  })
})
