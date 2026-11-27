import { describe, it, expect } from 'vitest'
import { themeById } from '../theme/themes'
import { THEME_CONTRAST_CHECKS } from '../theme/contrastChecks'
import { isStoredThemeId, mirrorChange, paletteMirror, parsePluginThemeId, pluginThemeId, pluginThemeOf, pluginThemeProblem, readPaletteMirror, resolveTheme } from './pluginThemes'

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

  // Final review M10: dim text on the main surface, which a darker elevated surface used to hide
  it('refuses dim text that reads poorly on bg though it reads on elevated', () => {
    expect(pluginThemeProblem({ base: 'vega', colors: { bg: '#303236', elevated: '#000000', textDim: '#777777', text: '#ffffff', panel: '#000000', textFaint: '#9a9a9a', mdLink: '#9ec5ff', accent: '#5aa9e6' } })).toMatch(/^text-dim on bg is \d\.\d:1; at least 3:1$/)
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

describe('isStoredThemeId', () => {
  it('takes a built-in id and a plugin theme id, nothing else', () => {
    expect(isStoredThemeId('vega')).toBe(true)
    expect(isStoredThemeId('plugin:dusk-theme:dusk')).toBe(true)
    for (const v of ['darcula', 'plugin:dusk-theme', '', null, 7]) expect(isStoredThemeId(v), String(v)).toBe(false)
  })
})

describe('resolveTheme', () => {
  const dusk = pluginThemeOf('dusk-theme', 'Dusk', { id: 'dusk', title: 'Dusk', base: 'vega', colors: { accent: '#3fa7d6' } })

  it('shows a built-in id as that theme, whatever the plugins are', () => {
    expect(resolveTheme('orion', null, null).colors).toEqual(themeById('orion').colors)
  })

  it('shows a plugin theme the plugin list holds', () => {
    expect(resolveTheme(dusk.id, [dusk], null).colors.accent).toBe('#3fa7d6')
  })

  it('shows the mirrored palette until the plugin list is read, then the default when the plugin no longer offers it', () => {
    const mirror = readPaletteMirror(paletteMirror(dusk), dusk.id)
    expect(resolveTheme(dusk.id, null, mirror).colors.accent).toBe('#3fa7d6')
    expect(resolveTheme(dusk.id, [], mirror).colors).toEqual(themeById('umbra').colors)
    expect(resolveTheme(dusk.id, null, null).colors).toEqual(themeById('umbra').colors)
  })
})

describe('the palette mirror', () => {
  const dusk = pluginThemeOf('dusk-theme', 'Dusk', { id: 'dusk', title: 'Dusk', base: 'vega', colors: { accent: '#3fa7d6' } })

  it('reads back only for the id it was written for, and only colours the theme rules take', () => {
    const raw = paletteMirror(dusk)
    expect(readPaletteMirror(raw, dusk.id)?.colors.accent).toBe('#3fa7d6')
    expect(readPaletteMirror(raw, 'plugin:other:dusk')).toBeNull()
    expect(readPaletteMirror(JSON.stringify({ id: dusk.id, base: 'vega', colors: { accent: 'url(x)' } }), dusk.id)).toBeNull()
    expect(readPaletteMirror('not json', dusk.id)).toBeNull()
    expect(readPaletteMirror(null, dusk.id)).toBeNull()
  })
})

// Final review M5: a plugin theme no longer offered does not paint the first frames of every start
describe('mirrorChange', () => {
  const dusk = pluginThemeOf('dusk-theme', 'Dusk', { id: 'dusk', title: 'Dusk', base: 'vega', colors: { accent: '#3fa7d6' } })
  it('writes the palette of a plugin theme the list offers', () => {
    expect(mirrorChange(dusk.id, [dusk])).toEqual({ write: paletteMirror(dusk) })
  })
  it('clears it once a read list does not offer the stored theme, or a built-in one is stored', () => {
    expect(mirrorChange(dusk.id, [])).toBe('clear')
    expect(mirrorChange('vega', [dusk])).toBe('clear')
  })
  it('leaves it while the list is not read yet', () => {
    expect(mirrorChange(dusk.id, null)).toBeNull()
  })
})
