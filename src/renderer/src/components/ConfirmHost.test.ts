import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('../i18n/I18nProvider', () => ({ useI18n: () => ({ lang: 'en', t: (key: string) => key, tm: (m: unknown) => String(m) }) }))

const { ConfirmView } = await import('./ConfirmHost')

// 2d final review M7: the plugin install warning (spec §31) puts the trust sentence after the permissions, before the
// buttons; a confirm modal's footer is drawn there.
describe('ConfirmView', () => {
  it('draws the body, the choices, the footer, then the buttons', () => {
    const html = renderToStaticMarkup(
      React.createElement(ConfirmView, {
        pending: { title: 'TITLE', body: 'BODY-TEXT', footer: 'FOOTER-TEXT', choices: [{ id: 'a', label: 'CHOICE-LABEL' }], resolve: () => {} },
        checked: ['a'],
        onChecked: () => {}
      })
    )
    const at = (s: string): number => html.indexOf(s)
    expect(at('BODY-TEXT')).toBeLessThan(at('CHOICE-LABEL'))
    expect(at('CHOICE-LABEL')).toBeLessThan(at('FOOTER-TEXT'))
    expect(at('FOOTER-TEXT')).toBeLessThan(at('<button'))
  })

  it('draws no footer when there is none', () => {
    const html = renderToStaticMarkup(
      React.createElement(ConfirmView, { pending: { title: 'T', body: 'B', resolve: () => {} }, checked: [], onChecked: () => {} })
    )
    expect(html.match(/confirm-body/g)).toHaveLength(1)
    expect(html).not.toContain('<pre')
  })

  // Claude plugin sharing §5.4: a marketplace-declared command is shown to the person as it is, before it runs
  it('draws a command in a code block after the body, as it is', () => {
    const command = 'npx -y "@acme/helper@1.2.0" --token=%TOKEN% & echo <done>\nhttps://example.test/archive.tgz'
    const html = renderToStaticMarkup(
      React.createElement(ConfirmView, { pending: { title: 'T', body: 'BODY-TEXT', code: command, resolve: () => {} }, checked: [], onChecked: () => {} })
    )
    const pre = /<pre class="confirm-code">([\s\S]*?)<\/pre>/.exec(html)
    expect(pre).not.toBeNull()
    const shown = pre![1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/&amp;/g, '&')
    expect(shown).toBe(command)
    expect(html.indexOf('BODY-TEXT')).toBeLessThan(html.indexOf('<pre'))
    expect(html.indexOf('<pre')).toBeLessThan(html.indexOf('<button'))
  })
})
