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
}
type GuestLike = {
  id: number
  session: unknown
  setWindowOpenHandler: (fn: () => { action: 'deny' }) => void
  on: (event: 'will-navigate' | 'will-redirect', fn: (e: { preventDefault: () => void; url?: string }, url?: string) => void) => void
  once: (event: 'destroyed', fn: () => void) => void
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

export function createPanelGuests(d: {
  listPlugins?: () => Promise<PluginRow[]>
  fromPartition: (partition: string) => SessionLike
  bridgePreload: string
  trustGuest: (contents: { id: number; once: (event: 'destroyed', fn: () => void) => unknown }, guest: GuestIdentity) => void
  now: () => number
}) {
  let listPlugins = d.listPlugins ?? (async () => [])
  /** Prepared panels by key, with what their guests need. */
  const prepared = new Map<string, PreparedPanel & { host: string; project?: { root: string; name: string } }>()
  /** The folder each plugin host serves, while its plugin is ready; a later refusal takes it away. */
  const roots = new Map<string, string>()
  /** Partitions whose session is set up, and which partition a session object is. */
  const setUp = new Set<string>()
  const partitionOfSession = new Map<unknown, string>()
  /** Attaches the guard allowed, waiting for their guest, by partition. */
  const waiting = new Map<string, string[]>()
  /** Live guests: their panel and their recent call times. */
  const guests = new Map<number, { key: string; calls: number[] }>()

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

  const forget = (pluginId: string): void => {
    roots.delete(pluginSchemeHost(pluginId))
    for (const [key, p] of prepared) if (p.pluginId === pluginId) prepared.delete(key)
  }

  return {
    /** Where the Host's plugin list comes from (ipc.ts, once its plugins route exists). */
    listFrom(fn: () => Promise<PluginRow[]>): void {
      listPlugins = fn
    },

    /** Agrees to show a panel: the page and partition its guest must use, or why not. */
    async prepare(
      pluginId: string,
      panelId: string,
      projectRoot: string | null
    ): Promise<{ ok: true; url: string; partition: string } | { ok: false; reason: string }> {
      const p = (await listPlugins()).find((r) => r.id === pluginId)
      const refuse = (reason: string): { ok: false; reason: string } => {
        forget(pluginId)
        return { ok: false, reason }
      }
      if (!p) return refuse(`no plugin ${pluginId} is installed`)
      if (!p.enabled) return refuse(`${pluginId} is disabled`)
      if (p.status !== 'ready' && p.status !== 'running') return refuse(`${pluginId} is ${p.status}`)
      if (p.ui === undefined) return refuse(`${pluginId} has no ui page`)
      // An unknown panel of a usable plugin is refused alone: its other panels and its files stay as they were
      if (!p.contributes?.panels.some((x) => x.id === panelId)) return { ok: false, reason: `${pluginId} contributes no panel ${panelId}` }
      const host = pluginSchemeHost(pluginId)
      const partition = pluginPartition(pluginId)
      const url = pluginPageUrl(pluginId, p.ui, panelId)
      roots.set(host, p.dir)
      if (!setUp.has(partition)) {
        const s = d.fromPartition(partition)
        s.protocol.handle(PLUGIN_SCHEME, serve(host))
        // A plugin page asks for nothing: camera, notifications and the rest are refused, asked either way
        s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
        s.setPermissionCheckHandler(() => false)
        setUp.add(partition)
        partitionOfSession.set(s, partition)
      }
      const key = contributionKey(pluginId, panelId)
      const workspaceRead = p.permissions.includes('workspace.read')
      const project = workspaceRead && projectRoot !== null ? { root: projectRoot, name: path.basename(projectRoot) } : undefined
      prepared.set(key, { key, pluginId, panelId, partition, url, host, ...(project ? { project } : {}) })
      return { ok: true, url, partition }
    },

    /** How a `<webview>` attaches (the preview guard's will-attach-webview): a plugin partition attaches a prepared
     *  panel's exact page with only the bridge preload; anything else in a plugin partition is refused. */
    decideAttach(params: { src?: string; partition?: string }, webPreferences: object): 'preview' | 'plugin' | 'refuse' {
      const decision = panelAttach(params, [...prepared.values()])
      if (decision.kind !== 'plugin') return decision.kind
      const prefs = webPreferences as Record<string, unknown>
      for (const k of Object.keys(prefs)) if (k === 'preload' || k === 'preloadURL') delete prefs[k]
      prefs.preload = d.bridgePreload
      prefs.nodeIntegration = false
      prefs.contextIsolation = true
      prefs.sandbox = true
      prefs.webSecurity = true
      const partition = params.partition as string
      waiting.set(partition, [...(waiting.get(partition) ?? []), decision.key])
      return 'plugin'
    },

    /** Takes a guest that attached in a plugin partition (did-attach-webview); false for any other guest. */
    attached(webContents: object): boolean {
      // Electron's WebContents, read through the few members this needs
      const guest = webContents as GuestLike
      const partition = partitionOfSession.get(guest.session)
      if (partition === undefined) return false
      const queue = waiting.get(partition) ?? []
      const key = queue.shift()
      const panel = key !== undefined ? prepared.get(key) : undefined
      if (!panel) return true // a plugin partition's guest with no panel waiting: it gets no trust and no bridge
      guests.set(guest.id, { key: panel.key, calls: [] })
      d.trustGuest(guest as never, { pluginId: panel.pluginId, host: panel.host })
      guest.setWindowOpenHandler(() => ({ action: 'deny' }))
      const own = `${PLUGIN_SCHEME}://${panel.host}/`
      const hold = (e: { preventDefault: () => void; url?: string }, url?: string): void => {
        if (!(e.url ?? url ?? '').startsWith(own)) e.preventDefault()
      }
      guest.on('will-navigate', hold)
      guest.on('will-redirect', hold)
      guest.once('destroyed', () => guests.delete(guest.id))
      return true
    },

    /** Answers a bridge call from a live guest, or throws why not. */
    async call(guestId: number, method: unknown, payload: unknown): Promise<unknown> {
      const g = guests.get(guestId)
      const panel = g ? prepared.get(g.key) : undefined
      if (!g || !panel) throw new Error('PANEL_GONE')
      const refusal = bridgeRefusal(g.calls, method, payload, d.now())
      if (refusal !== null) throw new Error(refusal)
      // context, the one method in Phase 2
      return { plugin: panel.pluginId, panel: panel.panelId, ...(panel.project ? { project: panel.project } : {}) }
    }
  }
}
