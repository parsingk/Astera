import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { t as translate, type MessageKey, type MessageParams } from '../../../core/i18n'
import { pluginThemeOf } from '../../../core/plugins/pluginThemes'
import { themeById } from '../../../core/theme/themes'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'en', t: (key: MessageKey, params?: MessageParams) => translate('en', key, params), tm: (m: unknown) => String(m) })
}))
const { ThemeContext } = await import('../lib/theme')
const { ThemeSettings } = await import('./ThemeSettings')

const dusk = pluginThemeOf('dusk-theme', 'Dusk pack', { id: 'dusk', title: 'Dusk', base: 'vega', colors: { accent: '#3fa7d6' } })
const render = (themeId: string, pluginThemes: typeof dusk[] | null): string =>
  renderToStaticMarkup(
    React.createElement(
      ThemeContext.Provider,
      { value: { theme: themeById('umbra'), themeId, setThemeId: () => {}, pluginThemes, setPluginThemes: () => {} } },
      React.createElement(ThemeSettings)
    )
  )

// Phase 2 remaining: plugin themes are picked beside the built-in ones
describe('ThemeSettings with plugin themes', () => {
  it('lists a plugin’s themes after the built-in ones, each named with its plugin, drawn in its own palette', () => {
    const html = render('umbra', [dusk])
    expect(html).toContain('Plugin themes')
    expect(html.indexOf('Dusk')).toBeGreaterThan(html.indexOf('Sirius'))
    expect(html).toContain('Dusk pack')
    expect(html).toContain('#3fa7d6')
  })

  it('marks the stored plugin theme as chosen', () => {
    expect(render(dusk.id, [dusk])).toMatch(/aria-pressed="true"[^>]*>(?:(?!<button).)*Dusk/)
  })

  it('says a stored plugin theme no plugin offers now is not shown, and keeps the default marked as what is shown', () => {
    const html = render(dusk.id, [])
    expect(html).toContain(translate('en', 'settings.theme.pluginGone'))
    expect(html).not.toContain('Plugin themes')
  })
})
