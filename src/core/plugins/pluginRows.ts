// The Host's plugin list as panels need it, read the same way in main (which prepares a panel) and in the renderer
// (which lists the commands and keeps the tabs): which plugins are installed, which can show a panel now, and why not.
// node: no imports, the renderer imports this.
import { INVISIBLE, contributionKey, type ContributionKey } from './manifest'

/** One installed plugin as the Host lists it, the fields a panel needs. */
export interface PluginRow {
  id: string
  enabled: boolean
  status: string
  ui?: string
  dir: string
  /** What the person granted. */
  permissions: string[]
  /** The name the plugin shows people; absent when its manifest gives none. */
  displayName?: string
  contributes?: { commands: { id: string; title: string; panel: string }[]; panels: { id: string; title: string }[] }
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
      ...(typeof o.displayName === 'string' ? { displayName: o.displayName } : {}),
      ...(c && Array.isArray(c.panels) && Array.isArray(c.commands) ? { contributes: c } : {})
    })
  }
  return rows
}

/** Why a panel was not shown, as the renderer words it: the Host could not list plugins, the plugin is not installed,
 *  turned off, not ready, has no page, does not contribute that panel, its id reads as an address, or the request named
 *  no plugin and panel. */
export type PanelRefusalCode = 'host' | 'missing' | 'disabled' | 'notReady' | 'noUi' | 'noPanel' | 'address' | 'invalid'

/** Why a plugin cannot show a panel now, or null; `reason` is main's English for logs. */
export function unusablePlugin(pluginId: string, p: PluginRow | undefined): { code: PanelRefusalCode; reason: string } | null {
  if (!p) return { code: 'missing', reason: `no plugin ${pluginId} is installed` }
  if (!p.enabled) return { code: 'disabled', reason: `${pluginId} is disabled` }
  if (p.status !== 'ready' && p.status !== 'running') return { code: 'notReady', reason: `${pluginId} is ${p.status}` }
  if (p.ui === undefined) return { code: 'noUi', reason: `${pluginId} has no ui page` }
  return null
}

/** A contributed command the palette lists: running it opens its panel. */
export interface PanelCommand {
  key: ContributionKey
  pluginId: string
  panelId: string
  /** The command's title, as the palette lists it. */
  title: string
  /** The title of the panel it opens, which that panel's tab shows. */
  panelTitle: string
  /** The plugin's display name, or its id when it has none. */
  pluginName: string
}

/** The name a plugin is shown by: its display name, or its id when it has none or its display name holds a character
 *  that could make it read as another plugin's. */
const shownName = (p: PluginRow): string => (p.displayName !== undefined && !INVISIBLE.test(p.displayName) ? p.displayName : p.id)

/** The commands of the plugins that can show a panel now, in the Host's order; a command whose panel is not
 *  contributed is left out. */
export function panelCommands(rows: readonly PluginRow[]): PanelCommand[] {
  return rows.flatMap((p) => {
    if (unusablePlugin(p.id, p) !== null || !p.contributes) return []
    const panels = new Map(p.contributes.panels.map((x) => [x.id, x.title]))
    return p.contributes.commands.flatMap((c) => {
      const panelTitle = panels.get(c.panel)
      return panelTitle === undefined
        ? []
        : [{ key: contributionKey(p.id, c.id), pluginId: p.id, panelId: c.panel, title: c.title, panelTitle, pluginName: shownName(p) }]
    })
  })
}

/** An installed plugin's panel, whether or not the plugin can show it now; null when the plugin is not installed or no
 *  longer contributes it. */
export function panelInfo(rows: readonly PluginRow[], pluginId: string, panelId: string): { title: string; pluginName: string } | null {
  const p = rows.find((r) => r.id === pluginId)
  const panel = p?.contributes?.panels.find((x) => x.id === panelId)
  return p && panel ? { title: panel.title, pluginName: shownName(p) } : null
}
