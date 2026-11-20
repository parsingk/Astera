import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ClusterView } from './ClusterView'
import type { ClusterViewModel } from '../../../hooks/useClusterView'

vi.mock('../../../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'ko',
    t: (key: string, p?: Record<string, unknown>) => (p ? `${key}${JSON.stringify(p)}` : key),
    tm: (m: unknown) => String(m)
  })
}))

const noop = (): void => {}
const model = {
  view: { context: 'kind-dev', namespace: null, resource: 'pods', selected: null, filter: '', sort: { by: 0, dir: 'asc' }, expanded: [], detailTab: 'summary' },
  contexts: { contexts: [{ name: 'kind-dev' }], current: 'kind-dev' },
  contextMissing: false,
  namespaces: [],
  namespacesForbidden: false,
  groups: [],
  customKinds: [],
  counts: {},
  kind: null,
  columns: [],
  rows: [],
  loading: false,
  selected: null,
  selectedRef: null,
  live: 'live',
  setContext: noop,
  setNamespace: noop,
  selectKind: noop,
  select: noop,
  setFilter: noop,
  sortBy: noop,
  toggleGroup: noop,
  setDetailTab: noop,
  refresh: noop,
  retry: noop
} as unknown as ClusterViewModel

describe('ClusterView', () => {
  // Spec 4.2: the segmented switch is the toolbar row's first item, before the context pill.
  it('puts the leading node first in the toolbar row', () => {
    const html = renderToStaticMarkup(
      React.createElement(ClusterView, { model, detail: null, toolbarStart: React.createElement('span', { className: 'switch-marker' }) })
    )
    expect(html).toContain('<div class="kube-cluster-bar"><span class="switch-marker"></span><select')
  })

  it('starts the row with the context pill without one', () => {
    const html = renderToStaticMarkup(React.createElement(ClusterView, { model, detail: null }))
    expect(html).toContain('<div class="kube-cluster-bar"><select')
  })
})
