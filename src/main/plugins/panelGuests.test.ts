import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelGuests } from './panelGuests'
import type { PluginRow } from '../../core/plugins/pluginRows'
import { PLUGIN_UI_CSP } from '../../core/plugins/panelGuest'
import type { PluginAudit, PluginAuditRecord } from '../../core/plugins/pluginAudit'

// ADR-008 in main: a prepared panel, the plugin's session and files, how its guest attaches, and its bridge
type Handler = (req: { url: string }) => Promise<Response>
let dir: string
let pkg: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-panel-guests-'))
  pkg = path.join(dir, 'installed', 'hello-panel')
  await fs.mkdir(path.join(pkg, 'dist', 'ui'), { recursive: true })
  await fs.writeFile(path.join(pkg, 'dist', 'ui', 'index.html'), '<!doctype html><title>hello</title>')
  await fs.writeFile(path.join(pkg, 'dist', 'ui', 'app.js'), 'void 0')
  await fs.mkdir(path.join(dir, 'outside'), { recursive: true })
  await fs.writeFile(path.join(dir, 'outside', 'secret.txt'), 'secret')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const row = (over: Partial<PluginRow> = {}): PluginRow => ({
  id: 'hello-panel',
  enabled: true,
  status: 'ready',
  ui: 'dist/ui/index.html',
  dir: pkg,
  permissions: ['commands.register', 'panels.register'],
  contributes: { commands: [], panels: [{ id: 'main', title: 'Hello' }] },
  ...over
})

function fakeSessions() {
  const handlers = new Map<string, Handler>()
  const permissionRefusals: string[] = []
  const made: string[] = []
  // Electron hands back the same session object for a partition, and a guest's session is that object
  const cache = new Map<string, unknown>()
  const fromPartition = (partition: string) => {
    const known = cache.get(partition)
    if (known) return known
    const made1 = makeSession(partition)
    cache.set(partition, made1)
    return made1
  }
  const downloadsRefused: string[] = []
  const proxies: { partition: string; config: unknown }[] = []
  const pairingRefused: string[] = []
  const wiped: string[] = []
  /** What the wipe waits for, and whether it fails: set by a test. */
  const wipe: { gate: Promise<void>; fail: boolean } = { gate: Promise.resolve(), fail: false }
  const makeSession = (partition: string) => ({
    partition,
    clearStorageData: async () => {
      wiped.push(`${partition} storage`)
      await wipe.gate
      if (wipe.fail) throw new Error('disk busy')
    },
    clearCache: async () => void wiped.push(`${partition} cache`),
    on: (ev: string, fn: (e: { preventDefault: () => void }) => void) => {
      if (ev === 'will-download') fn({ preventDefault: () => void downloadsRefused.push(partition) })
    },
    setProxy: async (config: unknown) => void proxies.push({ partition, config }),
    setBluetoothPairingHandler: (fn: (d: unknown, cb: (r: { confirmed: boolean }) => void) => void) => fn({}, (r) => void (!r.confirmed && pairingRefused.push(partition))),
    setDevicePermissionHandler: (fn: () => boolean) => void (!fn() && pairingRefused.push(`${partition} device`)),
    protocol: {
      handle: (scheme: string, fn: Handler) => {
        made.push(`${partition} ${scheme}`)
        handlers.set(partition, fn)
      }
    },
    setPermissionRequestHandler: (fn: (wc: unknown, p: string, cb: (ok: boolean) => void) => void) => fn(null, 'camera', (ok) => void (!ok && permissionRefusals.push(partition))),
    setPermissionCheckHandler: (fn: () => boolean) => void (!fn() && permissionRefusals.push(`${partition} check`))
  })
  const sessionOf = (partition: string): unknown => cache.get(partition) ?? { partition }
  return { fromPartition, handlers, made, permissionRefusals, sessionOf, downloadsRefused, proxies, pairingRefused, wiped, wipe }
}

let tokens = 0
const make = (rows: PluginRow[] | null, o: { audit?: PluginAudit; log?: (m: string) => void } = {}) => {
  const sessions = fakeSessions()
  currentSessions = sessions
  const trusted: { id: number; guest: unknown }[] = []
  const untrusted: number[] = []
  const guests = createPanelGuests({
    listPlugins: async () => rows,
    fromPartition: sessions.fromPartition as never,
    bridgePreload: '/out/preload/pluginBridge.js',
    trustGuest: (contents, guest) => void trusted.push({ id: contents.id, guest }),
    untrustGuest: (id) => void untrusted.push(id),
    now: () => 1000,
    token: () => `tok${++tokens}`,
    ...(o.audit ? { audit: o.audit } : {}),
    ...(o.log ? { log: o.log } : {})
  })
  return { guests, sessions, trusted, untrusted }
}
let currentSessions: ReturnType<typeof fakeSessions> | null = null

describe('prepare', () => {
  it('answers the page and partition of an enabled, ready plugin’s contributed panel, and sets its session up once', async () => {
    const { guests, sessions } = make([row()])
    const first = await guests.prepare('hello-panel', 'main', null)
    expect(first).toEqual({ ok: true, url: expect.stringMatching(/^astera-plugin:\/\/hello-panel\/dist\/ui\/index\.html\?panel=main&t=tok\d+$/), partition: 'plugin-hello-panel' })
    await guests.prepare('hello-panel', 'main', null)
    expect(sessions.made).toEqual(['plugin-hello-panel astera-plugin'])
    // The plugin's session grants no permission, asked either way
    expect(sessions.permissionRefusals).toEqual(['plugin-hello-panel', 'plugin-hello-panel check'])
  })

  it('refuses a plugin that is missing, disabled, not ready, has no page, or does not contribute the panel', async () => {
    const cases: [PluginRow[], string, string, string][] = [
      [[], 'hello-panel', 'missing', 'no plugin hello-panel is installed'],
      [[row({ enabled: false })], 'hello-panel', 'disabled', 'hello-panel is disabled'],
      [[row({ status: 'incompatible' })], 'hello-panel', 'notReady', 'hello-panel is incompatible'],
      [[row({ ui: undefined })], 'hello-panel', 'noUi', 'hello-panel has no ui page'],
      [[row({ contributes: { commands: [], panels: [] } })], 'hello-panel', 'noPanel', 'hello-panel contributes no panel main']
    ]
    // The code is what the renderer words in the person's language; the reason stays for logs
    for (const [rows, id, code, reason] of cases) expect(await make(rows).guests.prepare(id, 'main', null), reason).toEqual({ ok: false, code, reason })
  })
})

describe('the plugin’s files', () => {
  const served = async (rows: PluginRow[], url: string) => {
    const m = make(rows)
    await m.guests.prepare('hello-panel', 'main', null)
    return m.sessions.handlers.get('plugin-hello-panel')!({ url })
  }

  it('serves a file inside the package with the CSP header and its type', async () => {
    const r = await served([row()], 'astera-plugin://hello-panel/dist/ui/index.html?panel=main')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-security-policy')).toBe(PLUGIN_UI_CSP)
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await r.text()).toBe('<!doctype html><title>hello</title>')
    expect((await served([row()], 'astera-plugin://hello-panel/dist/ui/app.js')).headers.get('content-type')).toBe('text/javascript; charset=utf-8')
  })

  it('refuses a request the URL rules refuse, and a missing file', async () => {
    expect((await served([row()], 'astera-plugin://hello-panel/dist/%2e%2e%2f%2e%2e%2f..%2foutside/secret.txt')).status).toBe(403)
    expect((await served([row()], 'astera-plugin://hello-panel/dist/ui/missing.js')).status).toBe(404)
  })

  // Review Focus 3: a link inside the package that points out of it
  it('refuses a file reached through a link inside the package that points outside it', async () => {
    await fs.symlink(path.join(dir, 'outside'), path.join(pkg, 'dist', 'linked'), 'junction')
    expect((await served([row()], 'astera-plugin://hello-panel/dist/linked/secret.txt')).status).toBe(403)
  })

  // Review Focus 5: a plugin disabled after its panel was prepared serves nothing new
  it('serves nothing once a later prepare finds the plugin disabled', async () => {
    const rows = [row()]
    const m = make(rows)
    await m.guests.prepare('hello-panel', 'main', null)
    rows[0] = row({ enabled: false })
    expect(await m.guests.prepare('hello-panel', 'main', null)).toEqual({ ok: false, code: 'disabled', reason: 'hello-panel is disabled' })
    expect((await m.sessions.handlers.get('plugin-hello-panel')!({ url: 'astera-plugin://hello-panel/dist/ui/index.html' })).status).toBe(403)
  })
})

describe('attaching and the bridge', () => {
  const guest = (id: number, partition: string) => {
    const listeners = new Map<string, (...a: unknown[]) => void>()
    let openHandler: (() => { action: string }) | null = null
    const g = {
      id,
      webrtc: null as string | null,
      closed: false,
      session: currentSessions!.sessionOf(partition),
      setWebRTCIPHandlingPolicy: (p: string) => void (g.webrtc = p),
      close: () => void (g.closed = true),
      setWindowOpenHandler: (fn: () => { action: string }) => void (openHandler = fn),
      on: (ev: string, fn: (...a: unknown[]) => void) => void listeners.set(ev, fn),
      once: (ev: string, fn: (...a: unknown[]) => void) => void listeners.set(ev, fn),
      emit: (ev: string, ...a: unknown[]) => listeners.get(ev)?.(...a),
      open: () => openHandler?.()
    }
    return g
  }

  it('attaches a prepared panel with only the bridge preload and the guest rules forced, and refuses an unprepared one', async () => {
    const { guests } = make([row()])
    const p = await guests.prepare('hello-panel', 'main', null)
    if (!p.ok) throw new Error(p.reason)
    const prefs: Record<string, unknown> = { preload: 'file:///evil.js', nodeIntegration: true, sandbox: false }
    expect(guests.decideAttach({ partition: p.partition, src: p.url }, prefs)).toBe('plugin')
    expect(prefs).toEqual({
      preload: '/out/preload/pluginBridge.js',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      webviewTag: false,
      disablePopups: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false
    })
    expect(guests.decideAttach({ partition: p.partition, src: 'astera-plugin://hello-panel/dist/ui/app.js' }, {})).toBe('refuse')
    expect(guests.decideAttach({ partition: 'persist:preview', src: 'http://localhost:5173/' }, {})).toBe('preview')
  })

  it('trusts the attached guest for its plugin, opens no window, keeps it on its host and forgets it when it goes', async () => {
    const { guests, trusted } = make([row()])
    const p = await guests.prepare('hello-panel', 'main', '/work/proj')
    if (!p.ok) throw new Error(p.reason)
    guests.decideAttach({ partition: p.partition, src: p.url }, {})
    const g = guest(41, p.partition)
    expect(guests.attached(g as never)).toBe(true)
    expect(trusted).toEqual([{ id: 41, guest: { pluginId: 'hello-panel', host: 'hello-panel' } }])
    expect(g.webrtc).toBe('disable_non_proxied_udp')
    expect(g.open()).toEqual({ action: 'deny' })
    const away = { preventDefault: vi.fn() }
    g.emit('will-navigate', away, 'https://example.com/')
    expect(away.preventDefault).toHaveBeenCalled()
    const stay = { preventDefault: vi.fn() }
    g.emit('will-navigate', stay, 'astera-plugin://hello-panel/dist/ui/other.html')
    expect(stay.preventDefault).not.toHaveBeenCalled()
    expect(await guests.call(41, 'context', null)).toEqual({ plugin: 'hello-panel', panel: 'main' })
    g.emit('destroyed')
    await expect(guests.call(41, 'context', null)).rejects.toThrow('PANEL_GONE')
    // A guest of another partition is not this manager's
    expect(guests.attached(guest(42, 'persist:preview') as never)).toBe(false)
  })

  it('names the open project in context only when workspace.read is granted, and refuses what the bridge does not answer', async () => {
    const { guests } = make([row({ permissions: ['panels.register', 'workspace.read'] })])
    const p = await guests.prepare('hello-panel', 'main', path.resolve('/work/proj'))
    if (!p.ok) throw new Error(p.reason)
    guests.decideAttach({ partition: p.partition, src: p.url }, {})
    guests.attached(guest(7, p.partition) as never)
    expect(await guests.call(7, 'context', null)).toEqual({ plugin: 'hello-panel', panel: 'main', project: { root: path.resolve('/work/proj'), name: 'proj' } })
    await expect(guests.call(7, 'files.read', null)).rejects.toThrow('UNKNOWN_METHOD: files.read')
  })
})

// Screen check: a refused panel of a ready plugin took the plugin's other panels and files with it
describe('a refused panel of a usable plugin', () => {
  it('leaves the plugin’s prepared panels and files as they were', async () => {
    const m = make([row()])
    const p = await m.guests.prepare('hello-panel', 'main', null)
    if (!p.ok) throw new Error(p.reason)
    expect(await m.guests.prepare('hello-panel', 'side', null)).toEqual({ ok: false, code: 'noPanel', reason: 'hello-panel contributes no panel side' })
    expect((await m.sessions.handlers.get('plugin-hello-panel')!({ url: p.url })).status).toBe(200)
    expect(m.guests.decideAttach({ partition: p.partition, src: p.url }, {})).toBe('plugin')
  })
})

// The plugin panels final review
describe('final review fixes', () => {
  const guestOf = (id: number, partition: string) => {
    const listeners = new Map<string, (...a: unknown[]) => void>()
    const g = {
      id,
      webrtc: null as string | null,
      closed: false,
      session: currentSessions!.sessionOf(partition),
      opened: null as null | (() => { action: string }),
      setWebRTCIPHandlingPolicy: (p: string) => void (g.webrtc = p),
      crashed: false,
      forcefullyCrashRenderer: () => void (g.crashed = true),
      close: () => void (g.closed = true),
      setWindowOpenHandler: (fn: () => { action: string }) => void (g.opened = fn),
      on: (ev: string, fn: (...a: unknown[]) => void) => void listeners.set(ev, fn),
      once: (ev: string, fn: (...a: unknown[]) => void) => void listeners.set(ev, fn),
      emit: (ev: string, ...a: unknown[]) => listeners.get(ev)?.(...a)
    }
    return g
  }
  const open = async (m: ReturnType<typeof make>, id: number, project: string | null = null) => {
    const p = await m.guests.prepare('hello-panel', 'main', project)
    if (!p.ok) throw new Error(p.reason)
    expect(m.guests.decideAttach({ partition: p.partition, src: p.url }, {})).toBe('plugin')
    const g = guestOf(id, p.partition)
    expect(m.guests.attached(g as never)).toBe(true)
    return { p, g }
  }

  // I1: the element's preferences cannot carry anything into a plugin guest
  it('rebuilds the preferences, keeping only the partition and the zoom', async () => {
    const m = make([row()])
    const p = await m.guests.prepare('hello-panel', 'main', null)
    if (!p.ok) throw new Error(p.reason)
    const prefs: Record<string, unknown> = { partition: p.partition, zoomFactor: 1.5, webviewTag: true, experimentalFeatures: true, allowRunningInsecureContent: true, enableBlinkFeatures: 'X', javascript: true }
    m.guests.decideAttach({ partition: p.partition, src: p.url }, prefs)
    expect(prefs.partition).toBe(p.partition)
    expect(prefs.zoomFactor).toBe(1.5)
    expect(prefs.webviewTag).toBe(false)
    expect(prefs.experimentalFeatures).toBe(false)
    expect(prefs.allowRunningInsecureContent).toBe(false)
    expect('enableBlinkFeatures' in prefs).toBe(false)
    expect('javascript' in prefs).toBe(false)
  })

  // I1: a guest that lands in a plugin session with no prepared page gets no trust and goes nowhere
  it('holds a plugin session’s guest with nothing prepared behind it: no window, no navigation, no trust', async () => {
    const m = make([row()])
    await m.guests.prepare('hello-panel', 'main', null)
    const g = guestOf(9, 'plugin-hello-panel')
    expect(m.guests.attached(g as never)).toBe(true)
    expect(m.trusted).toEqual([])
    expect(g.opened?.()).toEqual({ action: 'deny' })
    const nav = { preventDefault: vi.fn() }
    g.emit('will-navigate', nav, 'astera-plugin://hello-panel/dist/ui/index.html')
    expect(nav.preventDefault).toHaveBeenCalled()
    await expect(m.guests.call(9, 'context', null)).rejects.toThrow('PANEL_GONE')
  })

  // I3: a prepared page admits one guest, once, and a guest answers what it was prepared as
  it('admits one guest per prepare, and keeps each guest’s project as it was when it attached', async () => {
    const m = make([row({ permissions: ['panels.register', 'workspace.read'] })])
    const a = await open(m, 1, path.resolve('/work/a'))
    expect(m.guests.decideAttach({ partition: a.p.partition, src: a.p.url }, {})).toBe('refuse')
    await open(m, 2, path.resolve('/work/b'))
    expect(await m.guests.call(1, 'context', null)).toMatchObject({ project: { name: 'a' } })
    expect(await m.guests.call(2, 'context', null)).toMatchObject({ project: { name: 'b' } })
  })

  // I2: turning a plugin off through this app forgets it at once: its panels close and lose the bridge, its files stop
  it('forgets a plugin: its open panels close and lose the bridge, its files and prepared pages stop', async () => {
    const m = make([row()])
    const { g } = await open(m, 5)
    const later = await m.guests.prepare('hello-panel', 'main', null)
    if (!later.ok) throw new Error(later.reason)
    m.guests.forget('hello-panel')
    // Screen check: close() alone left the page drawn with its scripts running; its renderer is ended first
    expect(g.crashed).toBe(true)
    expect(g.closed).toBe(true)
    expect(m.untrusted).toEqual([5])
    await expect(m.guests.call(5, 'context', null)).rejects.toThrow('PANEL_GONE')
    expect((await m.sessions.handlers.get('plugin-hello-panel')!({ url: later.url })).status).toBe(403)
    expect(m.guests.decideAttach({ partition: later.partition, src: later.url }, {})).toBe('refuse')
  })

  // I2: one turned off outside this app (the CLI) is caught by the watch
  it('forgets on refresh a plugin the Host no longer lists as usable', async () => {
    const rows = [row()]
    const m = make(rows)
    const { g } = await open(m, 6)
    expect(m.guests.active()).toBe(true)
    rows[0] = row({ enabled: false })
    await m.guests.refresh()
    expect(g.closed).toBe(true)
    expect(m.guests.active()).toBe(false)
  })

  // Phase 2 step 4b: a plugin installed again (plugins dev, the CLI) ends the panels showing its old pages, so each asks
  // again for the new one; a plugin that was not installed again keeps its panels
  it('forgets on refresh a plugin installed again since its panels were prepared, and keeps one that was not', async () => {
    const rows = [row({ installedAt: 1 }), row({ id: 'other', installedAt: 5 })]
    const m = make(rows)
    const { g } = await open(m, 11)
    const other = await m.guests.prepare('other', 'main', null)
    if (!other.ok) throw new Error(other.reason)
    await m.guests.refresh()
    expect(g.closed).toBe(false)
    rows[0] = row({ installedAt: 2 })
    await m.guests.refresh()
    expect(g.closed).toBe(true)
    expect(m.untrusted).toEqual([11])
    expect(m.guests.decideAttach({ partition: other.partition, src: other.url }, {})).toBe('plugin')
  })

  // Final review of plugins dev M4: a tab asking again right after the app turned the plugin off, removed or replaced it
  // waits for that change, so it is not shown the plugin as it was
  it('waits for a change the app is making to the plugin before preparing its panel', async () => {
    const rows = [row()]
    const m = make(rows)
    let finish: () => void = () => {}
    m.guests.hold('hello-panel', new Promise<void>((r) => (finish = r)))
    const asked = m.guests.prepare('hello-panel', 'main', null)
    rows[0] = row({ enabled: false })
    finish()
    expect(await asked).toMatchObject({ ok: false, code: 'disabled' })
  })

  // M3: a Host that cannot answer changes nothing
  it('says the list could not be read, and forgets nothing', async () => {
    const live = make([row()])
    await open(live, 7)
    live.guests.listFrom(async () => null)
    expect(await live.guests.prepare('hello-panel', 'main', null)).toEqual({ ok: false, code: 'host', reason: 'the Host’s plugin list could not be read' })
    await live.guests.refresh()
    expect(await live.guests.call(7, 'context', null)).toEqual({ plugin: 'hello-panel', panel: 'main' })
  })

  // M4: a plugin id that reads as an address is refused with a reason
  it('refuses a plugin whose id reads as an address', async () => {
    const m = make([row({ id: '123' })])
    expect(await m.guests.prepare('123', 'main', null)).toEqual({ ok: false, code: 'address', reason: '123 reads as an address, so its panels cannot be shown; rename the plugin' })
  })

  // I4, I5, I6: a plugin session sends nothing past the page, downloads nothing, pairs with nothing; its guests pick no device
  it('sets the session’s refusing proxy, refuses downloads and pairing, and a guest picks no Bluetooth device', async () => {
    const m = make([row()])
    const { g } = await open(m, 8)
    expect(m.sessions.proxies).toEqual([{ partition: 'plugin-hello-panel', config: { proxyRules: 'http://127.0.0.1:9', proxyBypassRules: '<-loopback>' } }])
    expect(m.sessions.downloadsRefused).toEqual(['plugin-hello-panel'])
    expect(m.sessions.pairingRefused).toEqual(expect.arrayContaining(['plugin-hello-panel', 'plugin-hello-panel device']))
    const pick = { preventDefault: vi.fn() }
    const chosen: string[] = []
    g.emit('select-bluetooth-device', pick, [{ deviceId: 'd1' }], (id: string) => chosen.push(id))
    expect(pick.preventDefault).toHaveBeenCalled()
    expect(chosen).toEqual([''])
  })

  // Phase 2 gate, spec E3 "audit": an opened panel, a refused bridge call and a refused attach are recorded, a burst under
  // one key for the writer to count
  it('records an opened panel, a refused bridge call under one key per kind, and a refused attach without its token', async () => {
    const recs: [PluginAuditRecord, string | undefined][] = []
    const m = make([row()], { audit: { record: (e, k) => void recs.push([e, k]), flushed: async () => {}, drain: async () => {}, drainSync: () => {} } })
    const { p } = await open(m, 21)
    await expect(m.guests.call(21, 'files.read', null)).rejects.toThrow('UNKNOWN_METHOD: files.read')
    await expect(m.guests.call(21, 'files.read', null)).rejects.toThrow('UNKNOWN_METHOD: files.read')
    const again = await m.guests.prepare('hello-panel', 'main', null)
    if (!again.ok) throw new Error(again.reason)
    expect(m.guests.decideAttach({ partition: p.partition, src: `${again.url}&x=1` }, {})).toBe('refuse')
    const refusedCall = { plugin: 'hello-panel', event: 'bridge-refused', detail: 'UNKNOWN_METHOD: files.read' }
    expect(recs).toEqual([
      [{ plugin: 'hello-panel', event: 'panel-opened', detail: 'panel main' }, undefined],
      [refusedCall, 'hello-panel bridge UNKNOWN_METHOD'],
      [refusedCall, 'hello-panel bridge UNKNOWN_METHOD'],
      [{ plugin: 'hello-panel', event: 'attach-refused', detail: 'astera-plugin://hello-panel/dist/ui/index.html' }, 'hello-panel attach']
    ])
  })

  // Spec E3 Bridge row: the payload's plugin id is not trusted
  it('ignores a plugin or panel named in a call’s payload: context answers what the guest was prepared as', async () => {
    const m = make([row(), row({ id: 'other' })])
    await open(m, 22)
    expect(await m.guests.call(22, 'context', { plugin: 'other', panel: 'side', project: { root: '/etc', name: 'etc' } })).toEqual({ plugin: 'hello-panel', panel: 'main' })
  })

  // Phase 2 gate: a plugin removed and installed again in the same app run must not find its old page's storage
  it('wipes a removed plugin’s panel storage and cache, on refresh, on prepare and when the app removes it', async () => {
    const rows = [row()]
    const m = make(rows)
    await open(m, 23)
    rows.length = 0
    await m.guests.refresh()
    expect(m.sessions.wiped).toEqual(['plugin-hello-panel storage', 'plugin-hello-panel cache'])
    const n = make([row()])
    await open(n, 24)
    n.guests.listFrom(async () => [])
    expect((await n.guests.prepare('hello-panel', 'main', null)).ok).toBe(false)
    expect(n.sessions.wiped).toEqual(['plugin-hello-panel storage', 'plugin-hello-panel cache'])
    const q = make([row()])
    await open(q, 25)
    q.guests.forget('hello-panel', { wipe: true })
    expect(q.sessions.wiped).toEqual(['plugin-hello-panel storage', 'plugin-hello-panel cache'])
  })

  it('wipes a plugin removed outside the app after its panel was closed, once', async () => {
    const rows = [row()]
    const m = make(rows)
    const { g } = await open(m, 27)
    g.emit('destroyed')
    rows.length = 0
    await m.guests.refresh()
    await m.guests.refresh()
    expect(m.sessions.wiped).toEqual(['plugin-hello-panel storage', 'plugin-hello-panel cache'])
  })

  // Final review I2 (a): turning it off stops the watch, so a removal outside the app is caught when it is opened again
  it('wipes a plugin turned off, then removed and installed again outside the app, before its page is served again', async () => {
    const rows = [row({ installId: 'aaaaaaaaaaaa' })]
    const m = make(rows)
    await open(m, 31)
    rows[0] = row({ enabled: false, installId: 'aaaaaaaaaaaa' })
    await m.guests.refresh()
    expect(m.sessions.wiped).toEqual([])
    rows[0] = row({ installId: 'bbbbbbbbbbbb' })
    expect((await m.guests.prepare('hello-panel', 'main', null)).ok).toBe(true)
    expect(m.sessions.wiped).toEqual(['plugin-hello-panel storage', 'plugin-hello-panel cache'])
  })

  // Final review I2 (b): removed and installed again between two looks reads as an update by installedAt alone
  it('wipes a plugin removed and installed again between two looks of the watch', async () => {
    const rows = [row({ installId: 'aaaaaaaaaaaa', installedAt: 1 })]
    const m = make(rows)
    const { g } = await open(m, 32)
    rows[0] = row({ installId: 'bbbbbbbbbbbb', installedAt: 2 })
    await m.guests.refresh()
    expect(g.closed).toBe(true)
    expect(m.sessions.wiped).toEqual(['plugin-hello-panel storage', 'plugin-hello-panel cache'])
  })

  it('keeps the storage of an update, which keeps its install id', async () => {
    const rows = [row({ installId: 'aaaaaaaaaaaa', installedAt: 1 })]
    const m = make(rows)
    const { g } = await open(m, 33)
    rows[0] = row({ installId: 'aaaaaaaaaaaa', installedAt: 2 })
    await m.guests.refresh()
    expect(g.closed).toBe(true)
    expect((await m.guests.prepare('hello-panel', 'main', null)).ok).toBe(true)
    expect(m.sessions.wiped).toEqual([])
  })

  // Final review M7: a page still running cannot write after the wipe began, and a prepare does not race it
  it('closes a removed plugin’s pages before wiping, and a prepare waits for the wipe', async () => {
    const rows = [row({ installId: 'aaaaaaaaaaaa' })]
    const m = make(rows)
    const { g } = await open(m, 34)
    const order: string[] = []
    const close = g.close
    g.close = () => {
      order.push('close')
      close()
    }
    let release: () => void = () => {}
    m.sessions.wipe.gate = new Promise<void>((r) => (release = r))
    const wiped = m.sessions.wiped
    const push = wiped.push.bind(wiped)
    wiped.push = (...items: string[]) => {
      order.push(...items)
      return push(...items)
    }
    rows[0] = row({ installId: 'bbbbbbbbbbbb' })
    await m.guests.refresh()
    expect(order.slice(0, 2)).toEqual(['close', 'plugin-hello-panel storage'])
    let prepared = false
    const p = m.guests.prepare('hello-panel', 'main', null).then((r) => (prepared = r.ok))
    await new Promise((r) => setTimeout(r, 20))
    expect(prepared).toBe(false)
    release()
    await p
    expect(prepared).toBe(true)
  })

  it('says in its log when a wipe fails', async () => {
    const said: string[] = []
    const rows = [row()]
    const m = make(rows, { log: (s) => void said.push(s) })
    await open(m, 35)
    m.sessions.wipe.fail = true
    rows.length = 0
    await m.guests.refresh()
    await new Promise((r) => setTimeout(r, 10))
    expect(said).toEqual([expect.stringMatching(/^the panel storage of hello-panel could not be cleared: disk busy/)])
  })

  // Final review M9: a wiped partition still names its plugin, so plugins audit --id finds the refusal
  it('names the plugin of a refused attach after its storage was wiped', async () => {
    const recs: [PluginAuditRecord, string | undefined][] = []
    const rows = [row()]
    const m = make(rows, { audit: { record: (e, k) => void recs.push([e, k]), flushed: async () => {}, drain: async () => {}, drainSync: () => {} } })
    await open(m, 36)
    rows.length = 0
    await m.guests.refresh()
    expect(m.guests.decideAttach({ partition: 'plugin-hello-panel', src: 'astera-plugin://hello-panel/x.html' }, {})).toBe('refuse')
    expect(recs.at(-1)).toEqual([{ plugin: 'hello-panel', event: 'attach-refused', detail: 'astera-plugin://hello-panel/x.html' }, 'hello-panel attach'])
  })

  it('keeps the panel storage of a plugin turned off or installed again, and touches no session never used', async () => {
    const rows = [row({ installedAt: 1 })]
    const m = make(rows)
    await open(m, 26)
    rows[0] = row({ enabled: false, installedAt: 1 })
    await m.guests.refresh()
    rows[0] = row({ installedAt: 2 })
    await m.guests.refresh()
    expect(await m.guests.prepare('hello-panel', 'main', null)).toMatchObject({ ok: true })
    m.guests.forget('hello-panel')
    expect(m.sessions.wiped).toEqual([])
    const never = make([])
    expect((await never.guests.prepare('hello-panel', 'main', null)).ok).toBe(false)
    never.guests.forget('hello-panel', { wipe: true })
    expect(never.sessions.wiped).toEqual([])
  })
})
