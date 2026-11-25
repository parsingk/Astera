// Plugin panel guests in main (ADR-008): the renderer asks for a panel, this checks a fresh Host plugin list and sets
// the plugin's session up once; the preview's attach guard (main/preview/guest.ts) asks it how a plugin partition's
// <webview> attaches and hands it the guest; the bridge's channel (ipc.ts, through ipcGuard) asks it to answer a call.
// The rules themselves are core/plugins/panelGuest.ts.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  PLUGIN_SCHEME,
  PLUGIN_UI_CSP,
  bridgeRefusal,
  panelAttach,
  pluginFilePath,
  pluginHostProblem,
  pluginPageUrl,
  pluginPartition,
  type PreparedPanel
} from '../../core/plugins/panelGuest'
import { contributionKey, pluginSchemeHost } from '../../core/plugins/manifest'

/** One installed plugin as the Host lists it, the fields a panel needs. */
export interface PluginRow {
  id: string
  enabled: boolean
  status: string
  ui?: string
  dir: string
  /** What the person granted. */
  permissions: string[]
  contributes?: { commands: { id: string; title: string; panel: string }[]; panels: { id: string; title: string }[] }
}

type SessionLike = {
  protocol: { handle: (scheme: string, handler: (req: { url: string }) => Promise<Response>) => void }
  setPermissionRequestHandler: (fn: (wc: unknown, permission: string, callback: (ok: boolean) => void) => void) => void
  setPermissionCheckHandler: (fn: () => boolean) => void
  setDevicePermissionHandler?: (fn: () => boolean) => void
  setBluetoothPairingHandler?: (fn: (details: unknown, callback: (r: { confirmed: boolean }) => void) => void) => void
  on: (event: 'will-download', fn: (e: { preventDefault: () => void }) => void) => void
  setProxy: (config: { proxyRules: string; proxyBypassRules: string }) => Promise<void>
}
type GuestLike = {
  id: number
  session: unknown
  setWindowOpenHandler: (fn: () => { action: 'deny' }) => void
  setWebRTCIPHandlingPolicy?: (policy: 'disable_non_proxied_udp') => void
  on: ((event: 'will-navigate' | 'will-redirect', fn: (e: { preventDefault: () => void; url?: string }, url?: string) => void) => void) &
    ((event: 'select-bluetooth-device', fn: (e: { preventDefault: () => void }, devices: unknown, callback?: (id: string) => void) => void) => void)
  once: (event: 'destroyed', fn: () => void) => void
  forcefullyCrashRenderer?: () => void
  close?: () => void
}
export type GuestIdentity = { pluginId: string; host: string }

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8'
}

/** The rows of the Host's `plugins-list` answer a panel needs; a malformed row is left out. */
export function pluginRowsOf(body: unknown): PluginRow[] {
  const list = typeof body === 'object' && body !== null ? (body as { plugins?: unknown }).plugins : undefined
  if (!Array.isArray(list)) return []
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const rows: PluginRow[] = []
  for (const r of list) {
    if (typeof r !== 'object' || r === null) continue
    const o = r as Record<string, unknown>
    if (typeof o.id !== 'string' || typeof o.dir !== 'string' || typeof o.status !== 'string') continue
    const c = o.contributes as PluginRow['contributes'] | undefined
    rows.push({
      id: o.id,
      enabled: o.enabled === true,
      status: o.status,
      dir: o.dir,
      permissions: strings(o.permissions),
      ...(typeof o.ui === 'string' ? { ui: o.ui } : {}),
      ...(c && Array.isArray(c.panels) && Array.isArray(c.commands) ? { contributes: c } : {})
    })
  }
  return rows
}

export type PanelGuests = ReturnType<typeof createPanelGuests>

/** How long a prepared page waits for its guest before it no longer admits one. */
const PREPARED_TTL_MS = 60_000

/** What a plugin guest attaches with: these and nothing the element asked for (security gate review I1). */
const PLUGIN_GUEST_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  webviewTag: false,
  disablePopups: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false
}
/** The keys of the element's preferences a plugin guest keeps: where it lives and its zoom. */
const KEPT_PREFERENCES = new Set(['partition', 'zoomFactor'])
/** The proxy a plugin session gets: one that refuses, loopback included, so WebRTC's TURN and anything else that could
 *  leave the page goes nowhere (review I4, measured with the WebRTC policy below: no candidate, nothing sent). */
const DEAD_PROXY = { proxyRules: 'http://127.0.0.1:9', proxyBypassRules: '<-loopback>' }

type Prepared = PreparedPanel & { host: string; project?: { root: string; name: string }; at: number }
type Snapshot = { pluginId: string; panelId: string; host: string; project?: { root: string; name: string } }

export function createPanelGuests(d: {
  /** The Host's plugin list, or null when it could not be read. */
  listPlugins?: () => Promise<PluginRow[] | null>
  fromPartition: (partition: string) => SessionLike
  bridgePreload: string
  trustGuest: (contents: { id: number; once: (event: 'destroyed', fn: () => void) => unknown }, guest: GuestIdentity) => void
  untrustGuest: (id: number) => void
  now: () => number
  /** A fresh one-time token for each prepared page. */
  token: () => string
}) {
  let listPlugins = d.listPlugins ?? (async () => [])
  /** Prepared pages by their exact URL: each admits one guest, once (review I3). */
  const prepared = new Map<string, Prepared>()
  /** The folder each plugin host serves, while its plugin is usable; forgetting it takes it away. */
  const roots = new Map<string, string>()
  /** Partitions whose session is set up, and which partition a session object is. */
  const setUp = new Set<string>()
  const partitionOfSession = new Map<unknown, string>()
  /** The attach the guard just allowed in a partition, for the guest Electron hands over in the same call. */
  const pending = new Map<string, Prepared>()
  /** Live guests: what they were prepared as, their recent call times, and how to close them. */
  const guests = new Map<number, { snapshot: Snapshot; calls: number[]; close: () => void }>()

  const refusedHere = (status: number): Response => new Response(null, { status })

  /** Serves one plugin host's files: inside its folder, links resolved and checked again, with the CSP header. */
  const serve = (host: string) => async (req: { url: string }): Promise<Response> => {
    const root = roots.get(host)
    if (root === undefined) return refusedHere(403)
    const named = pluginFilePath(root, req.url, host)
    if (!named.ok) return refusedHere(named.status)
    const [realRoot, realFile] = await Promise.all([fs.realpath(root).catch(() => null), fs.realpath(named.file).catch(() => null)])
    if (realRoot === null || realFile === null) return refusedHere(404)
    const rel = path.relative(realRoot, realFile)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return refusedHere(403)
    const stat = await fs.stat(realFile).catch(() => null)
    if (!stat?.isFile()) return refusedHere(404)
    const type = TYPES[path.extname(realFile).toLowerCase()] ?? 'application/octet-stream'
    return new Response(await fs.readFile(realFile), {
      status: 200,
      headers: { 'content-type': type, 'content-security-policy': PLUGIN_UI_CSP, 'x-content-type-options': 'nosniff' }
    })
  }

  /** A plugin that can no longer show panels: its files are no longer served, its prepared pages admit nobody, and its
   *  open panels lose the bridge and are closed (ADR-008 §6, review I2). */
  const forget = (pluginId: string): void => {
    roots.delete(pluginSchemeHost(pluginId))
    for (const [url, p] of prepared) if (p.pluginId === pluginId) prepared.delete(url)
    for (const [id, g] of guests) {
      if (g.snapshot.pluginId !== pluginId) continue
      guests.delete(id)
      d.untrustGuest(id)
      g.close()
    }
  }

  /** Why a plugin cannot show a panel now, or null. */
  const unusable = (pluginId: string, p: PluginRow | undefined): string | null => {
    if (!p) return `no plugin ${pluginId} is installed`
    if (!p.enabled) return `${pluginId} is disabled`
    if (p.status !== 'ready' && p.status !== 'running') return `${pluginId} is ${p.status}`
    if (p.ui === undefined) return `${pluginId} has no ui page`
    return null
  }

  async function setUpSession(partition: string, host: string): Promise<void> {
    if (setUp.has(partition)) return
    setUp.add(partition)
    const s = d.fromPartition(partition)
    partitionOfSession.set(s, partition)
    s.protocol.handle(PLUGIN_SCHEME, serve(host))
    // A plugin page asks for nothing: camera, notifications, devices and the rest are refused, asked either way
    s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    s.setPermissionCheckHandler(() => false)
    s.setDevicePermissionHandler?.(() => false)
    s.setBluetoothPairingHandler?.((_details, callback) => callback({ confirmed: false }))
    // No download: Electron would answer one with a Save As dialog under Astera's name (review I5)
    s.on('will-download', (e) => e.preventDefault())
    await s.setProxy(DEAD_PROXY)
  }

  return {
    /** Where the Host's plugin list comes from (ipc.ts, once its plugins route exists). */
    listFrom(fn: () => Promise<PluginRow[] | null>): void {
      listPlugins = fn
    },

    /** Agrees to show a panel: the page (with a one-time token) and partition its guest must use, or why not. */
    async prepare(
      pluginId: string,
      panelId: string,
      projectRoot: string | null
    ): Promise<{ ok: true; url: string; partition: string } | { ok: false; reason: string }> {
      const list = await listPlugins()
      // A Host that cannot answer says nothing about the plugin: nothing is forgotten (review M3)
      if (list === null) return { ok: false, reason: 'the Host’s plugin list could not be read' }
      const p = list.find((r) => r.id === pluginId)
      const why = unusable(pluginId, p)
      if (why !== null || !p) {
        forget(pluginId)
        return { ok: false, reason: why ?? `no plugin ${pluginId} is installed` }
      }
      // An unknown panel of a usable plugin is refused alone: its other panels and its files stay as they were
      if (!p.contributes?.panels.some((x) => x.id === panelId)) return { ok: false, reason: `${pluginId} contributes no panel ${panelId}` }
      const host = pluginSchemeHost(pluginId)
      const addressProblem = pluginHostProblem(pluginId)
      if (addressProblem !== null) return { ok: false, reason: addressProblem }
      const partition = pluginPartition(pluginId)
      const url = pluginPageUrl(pluginId, p.ui as string, panelId, d.token())
      roots.set(host, p.dir)
      await setUpSession(partition, host)
      const now = d.now()
      for (const [u, x] of prepared) if (now - x.at > PREPARED_TTL_MS) prepared.delete(u)
      const workspaceRead = p.permissions.includes('workspace.read')
      const project = workspaceRead && projectRoot !== null ? { root: projectRoot, name: path.basename(projectRoot) } : undefined
      prepared.set(url, { key: contributionKey(pluginId, panelId), pluginId, panelId, partition, url, host, at: now, ...(project ? { project } : {}) })
      return { ok: true, url, partition }
    },

    /** How a `<webview>` attaches (the preview guard's will-attach-webview): a plugin partition attaches a prepared page's
     *  exact URL once, with preferences rebuilt from Astera's own; anything else in a plugin partition is refused. */
    decideAttach(params: { src?: string; partition?: string }, webPreferences: object): 'preview' | 'plugin' | 'refuse' {
      const decision = panelAttach(params, [...prepared.values()])
      if (decision.kind !== 'plugin') return decision.kind
      const entry = prepared.get(params.src as string)
      if (!entry) return 'refuse'
      prepared.delete(entry.url)
      const prefs = webPreferences as Record<string, unknown>
      for (const k of Object.keys(prefs)) if (!KEPT_PREFERENCES.has(k)) delete prefs[k]
      Object.assign(prefs, PLUGIN_GUEST_PREFERENCES, { preload: d.bridgePreload })
      const partition = entry.partition
      pending.set(partition, entry)
      // will-attach and did-attach run in one call: an attach Electron abandons leaves nothing for the next guest
      queueMicrotask(() => {
        if (pending.get(partition) === entry) pending.delete(partition)
      })
      return 'plugin'
    },

    /** Takes a guest that attached in a plugin partition (did-attach-webview); false for any other guest. Every guest in
     *  a plugin partition opens no window, picks no Bluetooth device and sends nothing over WebRTC; one with no prepared
     *  page behind it also gets no trust and goes nowhere (review I1). */
    attached(webContents: object): boolean {
      // Electron's WebContents, read through the few members this needs
      const guest = webContents as GuestLike
      const partition = partitionOfSession.get(guest.session)
      if (partition === undefined) return false
      const entry = pending.get(partition)
      pending.delete(partition)
      guest.setWindowOpenHandler(() => ({ action: 'deny' }))
      guest.setWebRTCIPHandlingPolicy?.('disable_non_proxied_udp')
      guest.on('select-bluetooth-device', (e, _devices, callback) => {
        e.preventDefault()
        callback?.('')
      })
      if (!entry) {
        const nowhere = (e: { preventDefault: () => void }): void => e.preventDefault()
        guest.on('will-navigate', nowhere)
        guest.on('will-redirect', nowhere)
        return true
      }
      const snapshot: Snapshot = { pluginId: entry.pluginId, panelId: entry.panelId, host: entry.host, ...(entry.project ? { project: entry.project } : {}) }
      // close() alone leaves a guest's page drawn with its scripts running (measured): its renderer is ended first
      guests.set(guest.id, {
        snapshot,
        calls: [],
        close: () => {
          guest.forcefullyCrashRenderer?.()
          guest.close?.()
        }
      })
      d.trustGuest(guest as never, { pluginId: entry.pluginId, host: entry.host })
      const own = `${PLUGIN_SCHEME}://${entry.host}/`
      const hold = (e: { preventDefault: () => void; url?: string }, url?: string): void => {
        if (!(e.url ?? url ?? '').startsWith(own)) e.preventDefault()
      }
      guest.on('will-navigate', hold)
      guest.on('will-redirect', hold)
      guest.once('destroyed', () => guests.delete(guest.id))
      return true
    },

    /** Answers a bridge call from a live guest with what it was prepared as, or throws why not. */
    async call(guestId: number, method: unknown, payload: unknown): Promise<unknown> {
      const g = guests.get(guestId)
      if (!g) throw new Error('PANEL_GONE')
      const refusal = bridgeRefusal(g.calls, method, payload, d.now())
      if (refusal !== null) throw new Error(refusal)
      // context, the one method in Phase 2: what this guest was prepared as, whatever was prepared since (review I3)
      const s = g.snapshot
      return { plugin: s.pluginId, panel: s.panelId, ...(s.project ? { project: s.project } : {}) }
    },

    /** A plugin turned off, removed or replaced through this app: forgotten before the Host is asked (ADR-008 §6). */
    forget,

    /** Whether anything is served or open, so the watch below has something to do. */
    active(): boolean {
      return roots.size > 0 || guests.size > 0
    },

    /** Forgets every plugin that can no longer show panels: one turned off or removed outside this app (the CLI) is
     *  caught here. A list that cannot be read changes nothing. */
    async refresh(): Promise<void> {
      const list = await listPlugins()
      if (list === null) return
      const watched = new Set<string>()
      for (const g of guests.values()) watched.add(g.snapshot.pluginId)
      for (const p of prepared.values()) watched.add(p.pluginId)
      for (const p of list) if (roots.has(pluginSchemeHost(p.id))) watched.add(p.id)
      for (const host of roots.keys()) if (!list.some((p) => pluginSchemeHost(p.id) === host)) roots.delete(host)
      for (const id of watched) if (unusable(id, list.find((r) => r.id === id)) !== null) forget(id)
    }
  }
}
