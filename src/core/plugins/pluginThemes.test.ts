import { describe, it, expect } from 'vitest'
import { themeById } from '../theme/themes'
import { THEME_CONTRAST_CHECKS } from '../theme/contrastChecks'
import { parsePluginThemeId, pluginThemeId, pluginThemeOf, pluginThemeProblem } from './pluginThemes'

describe('pluginThemeProblem', () => {
  it('takes a dark palette over a built-in base that keeps every contrast floor', () => {
    expect(pluginThemeProblem({ base: 'vega', colors: { accent: '#3fa7d6' } })).toBeNull()
    expect(pluginThemeProblem({ base: 'umbra', colors: {} })).toBeNull()
  })

  it('refuses a base that is not a built-in theme', () => {
    expect(pluginThemeProblem({ base: 'nova', colors: {} })).toBe('base nova is not a built-in theme; they are vega, orion, umbra, aurora, antares, quasar, sirius')
    expect(pluginThemeProblem({ colors: {} })).toMatch(/^base undefined is not a built-in theme/)
  })

  it('refuses colours that are not an object of known keys', () => {
    expect(pluginThemeProblem({ base: 'vega', colors: [] })).toBe('colors is not an object')
    expect(pluginThemeProblem({ base: 'vega', colors: { background: '#000000' } })).toBe('colors.background is not a theme colour; they are ' + Object.keys(themeById('vega').colors).join(', '))
  })

  it('refuses a value that is not #rrggbb, so nothing but a colour reaches a CSS variable', () => {
    for (const v of ['url(https://x.example/a.png)', 'var(--accent)', '#fff', 'red', 'rgb(1,2,3)', '#12345g', '#1234567', ' #123456', 7]) {
      expect(pluginThemeProblem({ base: 'vega', colors: { accent: v } }), String(v)).toBe(`colors.accent ${JSON.stringify(v)} is not a #rrggbb colour`)
    }
  })

  it('refuses a palette under a contrast floor, naming the pair', () => {
    expect(pluginThemeProblem({ base: 'vega', colors: { text: '#2a2a2e' } })).toMatch(/^text on bg is \d+\.\d:1; at least 7:1$/)
    expect(pluginThemeProblem({ base: 'vega', colors: { statusInk: '#0e6478' } })).toMatch(/^status-ink on status-bg is 1\.0:1; at least 4\.5:1$/)
  })

  it('refuses a surface brighter than the brightest built-in one: the shared colours are tuned for dark surfaces', () => {
    expect(pluginThemeProblem({ base: 'vega', colors: { panel: '#f4f4f4' } })).toBe('panel #f4f4f4 is brighter than #303236: Astera’s shared colours need a dark surface')
  })

  it('applies the same checks as the built-in themes', () => {
    expect(THEME_CONTRAST_CHECKS.map((c) => c.label)).toContain('accent-ink on accent')
  })
})

describe('pluginThemeOf', () => {
  it('merges the colours over the base and keeps the base’s shape, keyed by plugin and theme', () => {
    const t = pluginThemeOf('@acme/dusk', 'Dusk', { id: 'dusk', title: 'Dusk', base: 'vega', colors: { accent: '#3fa7d6' } })
    expect(t.id).toBe('plugin:@acme/dusk:dusk')
    expect(t.name).toBe('Dusk')
    expect(t.pluginName).toBe('Dusk')
    expect(t.theme.colors.accent).toBe('#3fa7d6')
    expect(t.theme.colors.bg).toBe(themeById('vega').colors.bg)
    expect(t.theme.radius).toEqual(themeById('vega').radius)
    expect(t.theme.font).toEqual(themeById('vega').font)
    // data-theme follows the base, so a base's own CSS exceptions still apply
    expect(t.theme.id).toBe('vega')
  })
})

describe('plugin theme ids', () => {
  it('round-trips a scoped plugin id and a theme id', () => {
    expect(pluginThemeId('@acme/dusk', 'dusk')).toBe('plugin:@acme/dusk:dusk')
    expect(parsePluginThemeId('plugin:@acme/dusk:dusk')).toEqual({ pluginId: '@acme/dusk', themeId: 'dusk' })
    expect(parsePluginThemeId('plugin:dusk-theme:night.1')).toEqual({ pluginId: 'dusk-theme', themeId: 'night.1' })
  })

  it('reads nothing else as one', () => {
    for (const v of ['vega', 'plugin:', 'plugin:a', 'plugin::b', 'plugin:a:', 'plugin:A:b', 'plugin:a:B', 'plugin:a:b:c', `plugin:a:${'x'.repeat(65)}`, 7, null]) {
      expect(parsePluginThemeId(v), String(v)).toBeNull()
    }
  })
})
