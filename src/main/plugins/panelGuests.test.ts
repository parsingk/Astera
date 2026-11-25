import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelGuests, pluginRowsOf, type PluginRow } from './panelGuests'
import { PLUGIN_UI_CSP } from '../../core/plugins/panelGuest'

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
  const makeSession = (partition: string) => ({
    partition,
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
  return { fromPartition, handlers, made, permissionRefusals, sessionOf }
}

const make = (rows: PluginRow[]) => {
  const sessions = fakeSessions()
  currentSessions = sessions
  const trusted: { id: number; guest: unknown }[] = []
  const guests = createPanelGuests({
    listPlugins: async () => rows,
    fromPartition: sessions.fromPartition as never,
    bridgePreload: '/out/preload/pluginBridge.js',
    trustGuest: (contents, guest) => void trusted.push({ id: contents.id, guest }),
    now: () => 1000
  })
  return { guests, sessions, trusted }
}
let currentSessions: ReturnType<typeof fakeSessions> | null = null

describe('prepare', () => {
  it('answers the page and partition of an enabled, ready plugin’s contributed panel, and sets its session up once', async () => {
    const { guests, sessions } = make([row()])
    expect(await guests.prepare('hello-panel', 'main', null)).toEqual({
      ok: true,
      url: 'astera-plugin://hello-panel/dist/ui/index.html?panel=main',
      partition: 'plugin-hello-panel'
    })
    await guests.prepare('hello-panel', 'main', null)
    expect(sessions.made).toEqual(['plugin-hello-panel astera-plugin'])
    // The plugin's session grants no permission, asked either way
    expect(sessions.permissionRefusals).toEqual(['plugin-hello-panel', 'plugin-hello-panel check'])
  })

  it('refuses a plugin that is missing, disabled, not ready, has no page, or does not contribute the panel', async () => {
    const cases: [PluginRow[], string, string][] = [
      [[], 'hello-panel', 'no plugin hello-panel is installed'],
      [[row({ enabled: false })], 'hello-panel', 'hello-panel is disabled'],
      [[row({ status: 'incompatible' })], 'hello-panel', 'hello-panel is incompatible'],
      [[row({ ui: undefined })], 'hello-panel', 'hello-panel has no ui page'],
      [[row({ contributes: { commands: [], panels: [] } })], 'hello-panel', 'hello-panel contributes no panel main']
    ]
    for (const [rows, id, reason] of cases) expect(await make(rows).guests.prepare(id, 'main', null), reason).toEqual({ ok: false, reason })
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
    expect(await m.guests.prepare('hello-panel', 'main', null)).toEqual({ ok: false, reason: 'hello-panel is disabled' })
    expect((await m.sessions.handlers.get('plugin-hello-panel')!({ url: 'astera-plugin://hello-panel/dist/ui/index.html' })).status).toBe(403)
  })
})

describe('attaching and the bridge', () => {
  const guest = (id: number, partition: string) => {
    const listeners = new Map<string, (...a: unknown[]) => void>()
    let openHandler: (() => { action: string }) | null = null
    return {
      id,
      session: currentSessions!.sessionOf(partition),
      setWindowOpenHandler: (fn: () => { action: string }) => void (openHandler = fn),
      on: (ev: string, fn: (...a: unknown[]) => void) => void listeners.set(ev, fn),
      once: (ev: string, fn: (...a: unknown[]) => void) => void listeners.set(ev, fn),
      emit: (ev: string, ...a: unknown[]) => listeners.get(ev)?.(...a),
      open: () => openHandler?.()
    }
  }

  it('attaches a prepared panel with only the bridge preload and the guest rules forced, and refuses an unprepared one', async () => {
    const { guests } = make([row()])
    const p = await guests.prepare('hello-panel', 'main', null)
    if (!p.ok) throw new Error(p.reason)
    const prefs: Record<string, unknown> = { preload: 'file:///evil.js', nodeIntegration: true, sandbox: false }
    expect(guests.decideAttach({ partition: p.partition, src: p.url }, prefs)).toBe('plugin')
    expect(prefs).toEqual({ preload: '/out/preload/pluginBridge.js', nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true })
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
    expect(g.open()).toEqual({ action: 'deny' })
    const away = { preventDefault: vi.fn() }
    g.emit('will-navigate', away, 'https://example.com/')
    expect(away.preventDefault).toHaveBeenCalled()
    const stay = { preventDefault: vi.fn() }
    g.emit('will-navigate', stay, 'astera-plugin://hello-panel/dist/ui/index.html?panel=main')
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

describe('pluginRowsOf', () => {
  it('reads the rows a panel needs from the Host’s list, leaving out a malformed one', () => {
    expect(
      pluginRowsOf({
        plugins: [
          { id: 'hello-panel', enabled: true, status: 'ready', dir: '/p/hello', ui: 'dist/ui/index.html', permissions: ['panels.register', 7], contributes: { commands: [], panels: [{ id: 'main', title: 'Hello' }] } },
          { id: 'old', enabled: true, status: 'running', dir: '/p/old', permissions: [] },
          { id: 'broken', status: 'ready' },
          'junk'
        ]
      })
    ).toEqual([
      { id: 'hello-panel', enabled: true, status: 'ready', dir: '/p/hello', ui: 'dist/ui/index.html', permissions: ['panels.register'], contributes: { commands: [], panels: [{ id: 'main', title: 'Hello' }] } },
      { id: 'old', enabled: true, status: 'running', dir: '/p/old', permissions: [] }
    ])
    expect(pluginRowsOf(null)).toEqual([])
  })
})

// Screen check: a refused panel of a ready plugin took the plugin's other panels and files with it
describe('a refused panel of a usable plugin', () => {
  it('leaves the plugin’s prepared panels and files as they were', async () => {
    const m = make([row()])
    const p = await m.guests.prepare('hello-panel', 'main', null)
    if (!p.ok) throw new Error(p.reason)
    expect(await m.guests.prepare('hello-panel', 'side', null)).toEqual({ ok: false, reason: 'hello-panel contributes no panel side' })
    expect((await m.sessions.handlers.get('plugin-hello-panel')!({ url: p.url })).status).toBe(200)
    expect(m.guests.decideAttach({ partition: p.partition, src: p.url }, {})).toBe('plugin')
  })
})
