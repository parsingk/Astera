import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'ko', t: (key: string) => key, tm: (m: unknown) => String(m) })
}))
// localStorage exists only in a browser; the component reads the saved ratio while rendering.
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })

const { MarkdownSplit } = await import('./MarkdownSplit')

const noop = (): void => {}
const html = (p: { markdown?: boolean; asideOpen?: boolean; aside?: React.ReactNode }): string =>
  renderToStaticMarkup(
    React.createElement(MarkdownSplit, {
      markdown: p.markdown ?? false,
      mode: 'split',
      onModeChange: noop,
      text: '',
      docPath: '/p/patch.yaml',
      onOpenFile: noop,
      onSave: noop,
      editor: React.createElement('div', { id: 'the-editor' }),
      editorView: null,
      aside: p.aside,
      asideOpen: p.asideOpen
    })
  )

const editorPane = (markup: string): string => {
  const m = /<div class="md-pane md-pane-editor"[^>]*>.*?<\/div><\/div>/.exec(markup)
  if (!m) throw new Error(markup)
  return m[0]
}

describe('MarkdownSplit aside', () => {
  const aside = React.createElement('div', { id: 'the-aside' })

  it('shows the resizer and the aside when asideOpen, and neither when closed', () => {
    const open = html({ asideOpen: true, aside })
    expect(open).toContain('md-resizer')
    expect(open).toContain('id="the-aside"')
    const closed = html({ asideOpen: false, aside })
    expect(closed).not.toContain('md-resizer')
    expect(closed).not.toContain('the-aside')
  })

  it('keeps the editor pane identical whether the aside is open or not', () => {
    const open = editorPane(html({ asideOpen: true, aside }))
    const closed = editorPane(html({ asideOpen: false, aside }))
    expect(open).toBe(closed)
    expect(open).toContain('id="the-editor"')
  })

  it('ignores the aside for a markdown file', () => {
    const md = html({ markdown: true, asideOpen: true, aside })
    expect(md).not.toContain('the-aside')
    expect(md).toBe(html({ markdown: true, asideOpen: false, aside }))
  })
})
