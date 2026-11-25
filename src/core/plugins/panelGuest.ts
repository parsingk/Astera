// What a plugin panel guest may load, attach as and ask (ADR-008), decided apart from Electron so each rule is tested.
// main/plugins/panelGuests.ts listens to Electron and asks these.
import path from 'node:path'
import { pluginSchemeHost } from './manifest'

/** The privileged scheme a plugin's pages come from, one host per plugin. */
export const PLUGIN_SCHEME = 'astera-plugin'
const PARTITION_PREFIX = 'plugin-'

/** A plugin's own partition, in memory: its storage and cookies are its own and go when the app quits. */
export const pluginPartition = (id: string): string => PARTITION_PREFIX + pluginSchemeHost(id)
export const isPluginPartition = (p: string | undefined): boolean => typeof p === 'string' && p.startsWith(PARTITION_PREFIX)

/** What a plugin page may load: its own files, styles inline, images and fonts from data:, and nothing from the network,
 *  no frame and no inline script. */
export const PLUGIN_UI_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

/** The page a panel loads: the plugin's `ui` on its scheme host, the panel named in the query. */
export function pluginPageUrl(id: string, ui: string, panel: string): string {
  const page = ui.replace(/^\.\//, '').split('/').map(encodeURIComponent).join('/')
  return `${PLUGIN_SCHEME}://${pluginSchemeHost(id)}/${page}?panel=${encodeURIComponent(panel)}`
}

/** A name Windows reads as a device, with or without an extension. */
const DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i
const CONTROL = /[\x00-\x1f\x7f]/

/** The file in the plugin's folder a request names, by the URL alone (main resolves symlinks and checks again). 403 for
 *  a request that is not this plugin's or would leave its folder, 404 for a folder, 400 for an address that does not
 *  decode. */
export function pluginFilePath(
  root: string,
  url: string,
  host: string
): { ok: true; file: string } | { ok: false; status: 400 | 403 | 404 } {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { ok: false, status: 400 }
  }
  if (u.protocol !== `${PLUGIN_SCHEME}:` || u.host !== host) return { ok: false, status: 403 }
  let decoded: string
  try {
    decoded = decodeURIComponent(u.pathname)
  } catch {
    return { ok: false, status: 400 }
  }
  if (decoded.includes('\\') || CONTROL.test(decoded)) return { ok: false, status: 403 }
  const parts = decoded.split('/').slice(1)
  if (parts.length === 0 || parts[parts.length - 1] === '') return { ok: false, status: 404 }
  if (parts.some((p) => p === '' || p === '.' || p === '..' || DEVICE.test(p) || /[. ]$/.test(p))) return { ok: false, status: 403 }
  const file = path.join(root, ...parts)
  const rel = path.relative(root, file)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, status: 403 }
  return { ok: true, file }
}

/** A panel main agreed to show, with the exact page and partition its guest must use. */
export interface PreparedPanel {
  key: string
  pluginId: string
  panelId: string
  partition: string
  url: string
}

/** How a `<webview>` attaches: a non-plugin partition is the preview rule's to decide; a plugin partition attaches only a
 *  prepared panel's exact page. */
export function panelAttach(
  params: { src?: string; partition?: string },
  prepared: readonly PreparedPanel[]
): { kind: 'preview' } | { kind: 'plugin'; key: string } | { kind: 'refuse' } {
  if (!isPluginPartition(params.partition)) return { kind: 'preview' }
  const match = prepared.find((p) => p.partition === params.partition && p.url === params.src)
  return match ? { kind: 'plugin', key: match.key } : { kind: 'refuse' }
}

/** The bridge's methods in Phase 2. */
export const BRIDGE_METHODS = ['context'] as const
export const BRIDGE_MAX_PAYLOAD = 64 * 1024
export const BRIDGE_MAX_CALLS_PER_SECOND = 20

/** Why a guest's bridge call is refused, or null when it may be answered. `calls` is that guest's recent call times,
 *  kept here: a call that is answered is counted. */
export function bridgeRefusal(calls: number[], method: unknown, payload: unknown, now: number): string | null {
  if (typeof method !== 'string' || !(BRIDGE_METHODS as readonly string[]).includes(method)) return `UNKNOWN_METHOD: ${String(method)}`
  let size: number
  try {
    size = (JSON.stringify(payload ?? null) ?? '').length
  } catch {
    return 'PAYLOAD_NOT_JSON'
  }
  if (size > BRIDGE_MAX_PAYLOAD) return `PAYLOAD_TOO_LARGE: at most ${BRIDGE_MAX_PAYLOAD} bytes as JSON`
  while (calls.length > 0 && now - calls[0] >= 1000) calls.shift()
  if (calls.length >= BRIDGE_MAX_CALLS_PER_SECOND) return `TOO_MANY_CALLS: at most ${BRIDGE_MAX_CALLS_PER_SECOND} a second`
  calls.push(now)
  return null
}
