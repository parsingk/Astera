import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('../../../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'ko',
    t: (key: string, p?: Record<string, unknown>) => (p ? `${key}${JSON.stringify(p)}` : key),
    tm: (m: unknown) => String(m)
  })
}))
vi.mock('../../../lib/terminalFont', () => ({ useTerminalFont: () => ({ family: 'monospace' }) }))
vi.mock('../../../lib/theme', () => ({ useTheme: () => ({ theme: { id: 'dark' } }) }))

import { KubeShellView } from './KubeShellView'

const spec = { ref: { context: 'kind-dev', namespace: 'api', resource: 'pods', kind: 'Pod', name: 'worker-1' }, container: 'worker' }

describe('KubeShellView', () => {
  it('draws the terminal host and no find bar before find is asked', () => {
    const html = renderToStaticMarkup(
      React.createElement(KubeShellView, { spec, visible: true, clear: 0, find: 0, onEnded: () => {}, onOpenUrl: () => {} })
    )
    expect(html).toContain('kube-shell')
    expect(html).toContain('run-panel-host')
    expect(html).not.toContain('run-find')
  })
})
