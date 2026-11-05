import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

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

  // The register dialog: an account's servers, skills and plugins are areas, each named once, with a rule between them,
  // rather than a kind word on every row
  it('draws each group of choices under its name once, with a rule between groups', () => {
    const html = renderToStaticMarkup(
      React.createElement(ConfirmView, {
        pending: {
          title: 'T',
          body: 'B',
          choices: [
            { id: 'a', label: 'LINEAR', group: 'GROUP-MCP' },
            { id: 'b', label: 'GITHUB', group: 'GROUP-MCP' },
            { id: 'c', label: 'HUD', group: 'GROUP-PLUGINS' }
          ],
          resolve: () => {}
        },
        checked: [],
        onChecked: () => {}
      })
    )
    const at = (s: string): number => html.indexOf(s)
    expect(html.match(/GROUP-MCP/g)).toHaveLength(1)
    expect(html.match(/<hr/g)).toHaveLength(1)
    expect(at('GROUP-MCP')).toBeLessThan(at('LINEAR'))
    expect(at('LINEAR')).toBeLessThan(at('GITHUB'))
    expect(at('GITHUB')).toBeLessThan(at('<hr'))
    expect(at('<hr')).toBeLessThan(at('GROUP-PLUGINS'))
    expect(at('GROUP-PLUGINS')).toBeLessThan(at('HUD'))
  })

  it('draws choices without a group as one list, with no name and no rule', () => {
    const html = renderToStaticMarkup(
      React.createElement(ConfirmView, {
        pending: { title: 'T', body: 'B', choices: [{ id: 'a', label: 'A-LABEL' }, { id: 'b', label: 'B-LABEL' }], resolve: () => {} },
        checked: [],
        onChecked: () => {}
      })
    )
    expect(html).toContain('B-LABEL')
    expect(html).not.toContain('<hr')
    expect(html).not.toContain('confirm-choices-group')
  })

  // The register dialog with many servers, skills and plugins ran past the window at both ends, its buttons out of
  // reach. It stops at 80% of the window and its list of choices scrolls, the title, body, footer and buttons staying
  // in view. Layout cannot be measured here, so the rules are read from styles.css, as shrinkCss.test.ts does.
  it('stops at 80% of the window and scrolls its list of choices inside', () => {
    const html = renderToStaticMarkup(
      React.createElement(ConfirmView, {
        pending: { title: 'T', body: 'B', choices: [{ id: 'a', label: 'A' }], resolve: () => {} },
        checked: [],
        onChecked: () => {}
      })
    )
    expect(html).toContain('class="modal confirm-modal"')
    const styles = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../styles.css'), 'utf8')
    expect(styles).toMatch(/\.modal\.confirm-modal\s*\{[^}]*max-height:\s*80vh/)
    // min-height: 0 lets the list, a flex item of the modal's column, shrink below its rows; overflow scrolls them
    expect(styles).toMatch(/\.confirm-modal \.confirm-choices\s*\{[^}]*min-height:\s*0/)
    expect(styles).toMatch(/\.confirm-modal \.confirm-choices\s*\{[^}]*overflow-y:\s*auto/)
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
