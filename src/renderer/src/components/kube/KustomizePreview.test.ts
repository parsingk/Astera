import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { KustomizePreview, splitRenderedDocs, defaultDocIndex } from './KustomizePreview'

vi.mock('../../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'ko', t: (key: string) => key, tm: (m: unknown) => String(m) })
}))

const output = 'kind: Service\nmetadata:\n  name: dev-api\n---\nkind: Deployment\nmetadata:\n  name: dev-api\nspec:\n  replicas: 2\n'
const patch = 'kind: Deployment\nmetadata:\n  name: api\nspec:\n  replicas: 2\n'

describe('rendered documents', () => {
  it('splits the output at --- lines and labels each kind and name', () => {
    const docs = splitRenderedDocs(output)
    expect(docs.map((d) => d.label)).toEqual(['Service · dev-api', 'Deployment · dev-api'])
    expect(docs[1].text).toContain('replicas: 2')
  })

  it('defaults to the document the patch is for, else the first', () => {
    const docs = splitRenderedDocs(output)
    expect(defaultDocIndex(docs, patch)).toBe(1)
    expect(defaultDocIndex(docs, 'kind: Job\nmetadata:\n  name: x\n')).toBe(0)
    expect(defaultDocIndex(docs, '- op: add')).toBe(0)
  })
})

describe('KustomizePreview before the render answers', () => {
  it('shows the header, the read-only badge, the legend and the loading text', () => {
    const html = renderToStaticMarkup(
      React.createElement(KustomizePreview, { overlayDir: '/p/overlays/dev', patchText: patch, refreshKey: 0 })
    )
    for (const k of ['kube.render.title', 'kube.render.readOnly', 'kube.render.legend', 'kube.render.loading'])
      expect(html).toContain(k)
  })
})
