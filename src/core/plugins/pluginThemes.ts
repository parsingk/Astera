// A plugin's colour themes (Phase 2 remaining, design 2026-11-27): JSON colours over a built-in theme, nothing else. A
// value is `#rrggbb` only, so nothing but a colour ever reaches a CSS variable (no url(), no var(), no expression); the
// merged palette keeps the contrast floors the built-in themes keep, and its surfaces stay dark, since the colours Astera
// shares across themes (file icons, git, danger) are tuned for dark surfaces.
import { relativeLuminance, contrastRatio } from '../theme/contrast'
import { BRIGHTEST_SURFACE, THEME_CONTRAST_CHECKS } from '../theme/contrastChecks'
import { THEMES, isThemeId, themeById, type Theme, type ThemeColors, type ThemeId } from '../theme/themes'

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
    theme: { ...base, colors: { ...base.colors, ...decl.colors } }
  }
}
