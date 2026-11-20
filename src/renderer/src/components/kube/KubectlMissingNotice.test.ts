import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { KubectlMissingNotice } from './KubectlMissingNotice'

vi.mock('../../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'ko',
    t: (key: string, p?: Record<string, unknown>) => (p ? `${key}${JSON.stringify(p)}` : key),
    tm: (m: unknown) => String(m)
  })
}))

const here = path.dirname(fileURLToPath(import.meta.url))
const source = (rel: string): string => readFileSync(path.join(here, rel), 'utf8')

// Task 13 minor: the Cluster segment copied the manifests toolbar's kubectl-missing markup, and its row was a few pixels
// shorter than the log's, so the switch moved about 2px between them. One notice for both, and the Cluster segment
// draws it in the log row's frame (App.tsx is pinned by its text, as App.layoutWriteThrough.test.ts does).
describe('KubectlMissingNotice', () => {
  it('says kubectl is missing, with a link to its setting', () => {
    const html = renderToStaticMarkup(React.createElement(KubectlMissingNotice, { onOpenSettings: () => {} }))
    expect(html).toBe('<span class="kube-notice">kube.toolbar.kubectlMissing</span><button type="button" class="kube-link">kube.toolbar.openSettings</button>')
  })

  it('is the one copy: the manifests toolbar and the Cluster segment both draw it', () => {
    for (const file of ['KubeToolbar.tsx', '../../App.tsx']) {
      const src = source(file)
      expect(src).toContain('<KubectlMissingNotice')
      expect(src).not.toContain("t('kube.toolbar.kubectlMissing')")
    }
  })

  it('heads the Cluster segment with the switch in the log row\'s frame, so the switch stays in place', () => {
    const src = source('../../App.tsx')
    expect(src).toMatch(/<div className="kube-segment-bar">\s*\{switcher\}\s*<KubectlMissingNotice/)
  })
})
