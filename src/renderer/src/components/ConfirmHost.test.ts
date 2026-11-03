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

  // Task 10 review I1: a command confirmation opens from a poll, not a click, so a stray Enter must not run the command
  it('focuses Cancel, not the confirm button, when it shows a command', () => {
    const buttons = (pending: { title: string; body: string; code?: string; resolve: () => void }): string[] =>
      [...renderToStaticMarkup(React.createElement(ConfirmView, { pending, checked: [], onChecked: () => {} })).matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(
        (m) => `${m[1]}${/autofocus/.test(m[0]) ? ' [focused]' : ''}`
      )
    expect(buttons({ title: 'T', body: 'B', code: 'npx run-me', resolve: () => {} })).toEqual(['common.cancel [focused]', 'common.confirm'])
    expect(buttons({ title: 'T', body: 'B', resolve: () => {} })).toEqual(['common.cancel', 'common.confirm [focused]'])
  })
})
