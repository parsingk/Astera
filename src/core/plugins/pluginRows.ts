// The Host's plugin list as panels need it, read the same way in main (which prepares a panel) and in the renderer
// (which lists the commands and keeps the tabs): which plugins are installed, which can show a panel now, and why not.
// node: no imports, the renderer imports this.
import { INVISIBLE, contributionKey, type ContributionKey, type PluginContributions } from './manifest'
import { pluginThemeOf, pluginThemeProblem, type PluginTheme, type PluginThemeDecl } from './pluginThemes'

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
  /** When this copy was installed: a later one is a reinstall (`plugins dev`, the CLI), whose old pages are stale. */
  installedAt?: number
  /** Which install this is: an update keeps it, a removal and install again does not (final review I2). */
  installId?: string
  contributes?: PluginContributions
}

const isText = (v: unknown): v is string => typeof v === 'string'
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
/** The items of a listed contribution whose named fields are all text, each copied with those fields only. */
const itemsOf = <K extends string>(v: unknown, fields: readonly K[]): Record<K, string>[] =>
  Array.isArray(v)
    ? v.filter((x): x is Record<string, unknown> => isRecord(x) && fields.every((f) => isText(x[f]))).map((x) => Object.fromEntries(fields.map((f) => [f, x[f]])) as Record<K, string>)
    : []

/** A listed row's contributions, their shape checked again here (final review M7): a list that is not one and an item
 *  whose fields are not text are dropped, so nothing malformed reaches an effect or a render; a theme's colours are
 *  checked again where it is used (pluginThemesOf). Undefined when panels and commands are not lists. */
function contributionsOf(v: unknown): PluginContributions | undefined {
  if (!isRecord(v) || !Array.isArray(v.panels) || !Array.isArray(v.commands)) return undefined
  const out: PluginContributions = { commands: itemsOf(v.commands, ['id', 'title', 'panel'] as const), panels: itemsOf(v.panels, ['id', 'title'] as const) }
  const sidebar = itemsOf(v.sidebar, ['id', 'title', 'panel'] as const)
  if (sidebar.length > 0) out.sidebar = sidebar
  const statusBar = itemsOf(v.statusBar, ['id', 'text', 'command'] as const)
  if (statusBar.length > 0) out.statusBar = statusBar
  const themes = Array.isArray(v.themes)
    ? v.themes
        .filter((t): t is Record<string, unknown> => isRecord(t) && isText(t.id) && isText(t.title) && isText(t.base) && isRecord(t.colors))
        .map((t) => ({ id: t.id as string, title: t.title as string, base: t.base as PluginThemeDecl['base'], colors: { ...(t.colors as PluginThemeDecl['colors']) } }))
    : []
  if (themes.length > 0) out.themes = themes
  return out
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
    const c = contributionsOf(o.contributes)
    rows.push({
      id: o.id,
      enabled: o.enabled === true,
      status: o.status,
      dir: o.dir,
      permissions: strings(o.permissions),
      ...(typeof o.ui === 'string' ? { ui: o.ui } : {}),
      ...(typeof o.displayName === 'string' ? { displayName: o.displayName } : {}),
      ...(typeof o.installedAt === 'number' ? { installedAt: o.installedAt } : {}),
      ...(typeof o.installId === 'string' ? { installId: o.installId } : {}),
      ...(c ? { contributes: c } : {})
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

/** The themes the plugins offer now (Phase 2 remaining): an enabled, ready plugin granted themes.register, each theme
 *  checked again by the theme rules, since what reaches a CSS variable must be a colour whatever a Host listed. */
export function pluginThemesOf(rows: readonly PluginRow[]): PluginTheme[] {
  return rows.flatMap((p) => {
    // A theme is data the app applies itself: a trusted plugin's process starting, stopped or failed does not take it
    // away; turned off or incompatible does (final review M6)
    if (!p.enabled || p.status === 'incompatible' || p.status === 'disabled' || !p.permissions.includes('themes.register')) return []
    return (p.contributes?.themes ?? []).filter((d) => pluginThemeProblem(d) === null).map((d) => pluginThemeOf(p.id, shownName(p), d))
  })
}

/** A plugin's sidebar view the rail offers a button for (Phase 2 remaining). */
export interface SidebarViewEntry {
  key: ContributionKey
  pluginId: string
  viewId: string
  /** The contributed panel it shows: the same guest a panel tab draws. */
  panelId: string
  title: string
  pluginName: string
}

/** The sidebar views of the plugins that can show a panel now and were granted panels.register, in the Host's order; a
 *  view whose panel is not contributed is left out. */
export function sidebarViewsOf(rows: readonly PluginRow[]): SidebarViewEntry[] {
  return rows.flatMap((p) => {
    if (unusablePlugin(p.id, p) !== null || !p.contributes || !p.permissions.includes('panels.register')) return []
    const panels = new Set(p.contributes.panels.map((x) => x.id))
    return (p.contributes.sidebar ?? [])
      .filter((v) => panels.has(v.panel))
      .map((v) => ({ key: contributionKey(p.id, v.id), pluginId: p.id, viewId: v.id, panelId: v.panel, title: v.title, pluginName: shownName(p) }))
  })
}

/** At most this many plugin items share the status bar, so plugins never crowd out Astera's own. */
export const STATUS_ITEMS_MAX = 6

/** A plugin's status item (Phase 2 remaining): its text, and the command clicking it runs. */
export interface StatusItemEntry {
  key: ContributionKey
  text: string
  pluginName: string
  command: PanelCommand
}

/** The status items of the plugins that can run their commands now and were granted commands.register, in plugin id
 *  order, at most STATUS_ITEMS_MAX; an item whose command the palette would not list is left out. */
export function statusItemsOf(rows: readonly PluginRow[]): StatusItemEntry[] {
  const commands = new Map(panelCommands(rows).map((c) => [c.key, c]))
  return [...rows]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .flatMap((p) => {
      if (!p.permissions.includes('commands.register')) return []
      return (p.contributes?.statusBar ?? []).flatMap((item) => {
        const command = commands.get(contributionKey(p.id, item.command))
        return command ? [{ key: contributionKey(p.id, item.id), text: item.text, pluginName: shownName(p), command }] : []
      })
    })
    .slice(0, STATUS_ITEMS_MAX)
}
