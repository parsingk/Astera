// A plugin's colour themes (Phase 2 remaining, design 2026-11-27): JSON colours over a built-in theme, nothing else. A
// value is `#rrggbb` only, so nothing but a colour ever reaches a CSS variable (no url(), no var(), no expression); the
// merged palette keeps the contrast floors the built-in themes keep, and its surfaces stay dark, since the colours Astera
// shares across themes (file icons, git, danger) are tuned for dark surfaces.
import { relativeLuminance, contrastRatio } from '../theme/contrast'
import { BRIGHTEST_SURFACE, THEME_CONTRAST_CHECKS } from '../theme/contrastChecks'
import { DEFAULT_THEME_ID, THEMES, isThemeId, themeById, type Theme, type ThemeColors, type ThemeId } from '../theme/themes'

/** A theme as a manifest declares it, read. */
export interface PluginThemeDecl {
  id: string
  title: string
  base: ThemeId
  colors: Partial<ThemeColors>
}

/** A plugin theme ready to apply: `theme.id` is its base, so a base's own CSS exceptions still apply. */
export interface PluginTheme {
  /** `plugin:<pluginId>:<themeId>`: what Settings stores. */
  id: string
  name: string
  pluginId: string
  pluginName: string
  base: ThemeId
  /** The colours the plugin set, which the first-paint mirror keeps (a base's own may be rgba, which a plugin's may not). */
  overrides: Partial<ThemeColors>
  theme: Theme
}

const HEX = /^#[0-9a-fA-F]{6}$/
/** The surfaces a theme paints large areas with: each no brighter than the brightest built-in one. */
const SURFACES: readonly (keyof ThemeColors)[] = ['bg', 'rail', 'panel', 'elevated', 'surfaceHover', 'termBg']
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Why `decl`'s base and colours cannot be a theme, or null. */
export function pluginThemeProblem(decl: { base?: unknown; colors?: unknown }): string | null {
  if (!isThemeId(decl.base)) return `base ${String(decl.base)} is not a built-in theme; they are ${THEMES.map((t) => t.id).join(', ')}`
  const base = themeById(decl.base)
  if (!isObject(decl.colors)) return 'colors is not an object'
  const keys = Object.keys(base.colors) as (keyof ThemeColors)[]
  const merged: ThemeColors = { ...base.colors }
  for (const [k, v] of Object.entries(decl.colors)) {
    if (!(keys as string[]).includes(k)) return `colors.${k} is not a theme colour; they are ${keys.join(', ')}`
    if (typeof v !== 'string' || !HEX.test(v)) return `colors.${k} ${JSON.stringify(v)} is not a #rrggbb colour`
    merged[k as keyof ThemeColors] = v
  }
  const ceiling = relativeLuminance(BRIGHTEST_SURFACE)
  for (const s of SURFACES) {
    // Only what the plugin set: a base surface is a built-in one, which the ceiling is taken from
    const v = (decl.colors as Record<string, string>)[s]
    if (v !== undefined && relativeLuminance(v) > ceiling) return `${s} ${v} is brighter than ${BRIGHTEST_SURFACE}: Astera’s shared colours need a dark surface`
  }
  for (const c of THEME_CONTRAST_CHECKS) {
    const ratio = contrastRatio(merged[c.fg], merged[c.bg])
    if (ratio < c.min) return `${c.label} is ${(Math.floor(ratio * 10) / 10).toFixed(1)}:1; at least ${c.min}:1`
  }
  return null
}

export const pluginThemeId = (pluginId: string, themeId: string): string => `plugin:${pluginId}:${themeId}`

const PLUGIN_THEME_ID = /^plugin:((?:@[a-z0-9-][a-z0-9-._]*\/)?[a-z0-9-][a-z0-9-._]*):([a-z0-9][a-z0-9._-]{0,63})$/

/** The plugin and theme a stored theme id names, or null for anything else (a built-in id included). */
export function parsePluginThemeId(v: unknown): { pluginId: string; themeId: string } | null {
  if (typeof v !== 'string') return null
  const m = PLUGIN_THEME_ID.exec(v)
  return m ? { pluginId: m[1], themeId: m[2] } : null
}

/** `decl` (already checked by pluginThemeProblem) merged over its base. */
export function pluginThemeOf(pluginId: string, pluginName: string, decl: PluginThemeDecl): PluginTheme {
  const base = themeById(decl.base)
  return {
    id: pluginThemeId(pluginId, decl.id),
    name: decl.title,
    pluginId,
    pluginName,
    base: decl.base,
    overrides: { ...decl.colors },
    theme: { ...base, colors: { ...base.colors, ...decl.colors } }
  }
}

/** What Settings may store as the theme: a built-in id, or a plugin theme's (kept while its plugin is off). */
export const isStoredThemeId = (v: unknown): v is string => isThemeId(v) || parsePluginThemeId(v) !== null

/** A plugin theme as the first-paint mirror keeps it: the app reads it before the plugin list arrives. */
export const paletteMirror = (t: PluginTheme): string => JSON.stringify({ id: t.id, base: t.base, colors: t.overrides })

/** The theme a mirror written for `id` holds, checked again by the theme rules; null for anything else. */
export function readPaletteMirror(raw: string | null, id: string): Theme | null {
  if (raw === null) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isObject(v) || v.id !== id || pluginThemeProblem(v) !== null) return null
  const base = themeById(v.base as ThemeId)
  return { ...base, colors: { ...base.colors, ...(v.colors as Partial<ThemeColors>) } }
}

/** What the first-paint mirror should become: the palette of a plugin theme the list offers, cleared once a read list
 *  does not offer the stored one or a built-in one is stored (final review M5), untouched while the list is not read. */
export function mirrorChange(storedId: string, pluginThemes: readonly PluginTheme[] | null): { write: string } | 'clear' | null {
  if (isThemeId(storedId)) return 'clear'
  if (pluginThemes === null) return null
  const offered = pluginThemes.find((t) => t.id === storedId)
  return offered ? { write: paletteMirror(offered) } : 'clear'
}

/** The theme to show for a stored id: a built-in one as itself; a plugin's from the list (null while not read yet, when
 *  the mirror stands in); the default when no plugin offers it now, the stored id kept for when one does again. */
export function resolveTheme(storedId: string, pluginThemes: readonly PluginTheme[] | null, mirror: Theme | null): Theme {
  if (isThemeId(storedId)) return themeById(storedId)
  if (pluginThemes !== null) return pluginThemes.find((t) => t.id === storedId)?.theme ?? themeById(DEFAULT_THEME_ID)
  return mirror ?? themeById(DEFAULT_THEME_ID)
}
