import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ClusterView } from './ClusterView'
import type { ClusterViewModel } from '../../../hooks/useClusterView'
import type { ClusterTableProps } from './ClusterTable'
import { KUBECTL_MISSING } from '../../../../../core/kube/cluster/types'

vi.mock('../../../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'ko',
    t: (key: string, p?: Record<string, unknown>) => (p ? `${key}${JSON.stringify(p)}` : key),
    tm: (m: unknown) => String(m)
  })
}))

// The table as it is, with the props ClusterView gave it kept, so a row double-click can be played.
let table: ClusterTableProps | null = null
vi.mock('./ClusterTable', async (original) => {
  const real = await original<typeof import('./ClusterTable')>()
  return {
    ...real,
    ClusterTable: (p: ClusterTableProps) => {
      table = p
      return React.createElement(real.ClusterTable, p)
    }
  }
})

const noop = (): void => {}
const model = {
  view: { context: 'kind-dev', namespace: null, resource: 'pods', selected: null, filter: '', sort: { by: 0, dir: 'asc' }, expanded: [], detailTab: 'summary' },
  contexts: { contexts: [{ name: 'kind-dev' }], current: 'kind-dev' },
  contextMissing: false,
  contextsError: null,
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

  // Final review T10: kubeconfig that could not be read says so, not that the remembered cluster is missing.
  it('shows a failed kubeconfig read instead of a missing cluster', () => {
    const detail = 'error: error loading config file "/home/u/.kube/config": yaml: line 3'
    const html = renderToStaticMarkup(
      React.createElement(ClusterView, { model: { ...model, contexts: { contexts: [], current: null }, contextMissing: false, contextsError: detail }, detail: null })
    )
    expect(html).toContain('kube.cluster.kubeconfigError')
    expect(html).toContain('yaml: line 3')
    expect(html).not.toContain('kube.cluster.contextMissing')
    expect(renderToStaticMarkup(React.createElement(ClusterView, { model, detail: null }))).not.toContain('kube.cluster.kubeconfigError')
  })

  // Re-review R1 and spec 4.3: a picked kind the person may not list says why in the table, and nothing is greyed.
  it('shows a Forbidden refusal of the picked kind in the table, not as the view\'s error', () => {
    const line = 'Error from server (Forbidden): pods is forbidden: User "u" cannot list resource "pods"'
    const html = renderToStaticMarkup(React.createElement(ClusterView, { model: { ...model, live: 'paused', listForbidden: line }, detail: null }))
    expect(table!.forbidden).toBe(line)
    expect(html).toContain('pods is forbidden')
    expect(html).not.toContain('stale')
    expect(html).not.toContain('kube.cluster.retry')
  })

  // Final review M4: a watch whose binary is missing says so in the person's language, not as main's English.
  it('says kubectl is missing in the catalog words', () => {
    const html = renderToStaticMarkup(React.createElement(ClusterView, { model: { ...model, live: { error: KUBECTL_MISSING } }, detail: null }))
    expect(html).toContain('kube.cluster.kubectlMissing')
    expect(html).not.toContain(KUBECTL_MISSING)
  })
})

// Spec 4.4 and 4.6: a double-click on a row opens the object in the editor when there is one, and selects it otherwise.
describe('ClusterView row open', () => {
  const rows = [{ uid: 'u1', name: 'w-1', namespace: 'api', cells: [], attention: false }]
  const withRows = (select: (uid: string | null) => void): ClusterViewModel =>
    ({ ...model, kind: { kind: 'Pod', resource: 'pods', namespaced: true }, rows, select }) as unknown as ClusterViewModel

  it('opens the row in the editor when an opener is given', () => {
    const opened: unknown[] = []
    const selected: unknown[] = []
    renderToStaticMarkup(React.createElement(ClusterView, { model: withRows((u) => void selected.push(u)), detail: null, onOpenInEditor: (r) => void opened.push(r) }))
    table!.onRowOpen('u1')
    expect(opened).toEqual([{ context: 'kind-dev', namespace: 'api', resource: 'pods', kind: 'Pod', name: 'w-1' }])
    expect(selected).toEqual([])
  })

  it('names no namespace for a cluster-scoped kind', () => {
    const opened: unknown[] = []
    const nodes = { ...withRows(noop), kind: { kind: 'Node', resource: 'nodes', namespaced: false }, rows: [{ ...rows[0], name: 'n1', namespace: null }] }
    renderToStaticMarkup(React.createElement(ClusterView, { model: nodes as unknown as ClusterViewModel, detail: null, onOpenInEditor: (r) => void opened.push(r) }))
    table!.onRowOpen('u1')
    expect(opened).toEqual([{ context: 'kind-dev', namespace: null, resource: 'nodes', kind: 'Node', name: 'n1' }])
  })

  it('selects the row without one', () => {
    const selected: unknown[] = []
    renderToStaticMarkup(React.createElement(ClusterView, { model: withRows((u) => void selected.push(u)), detail: null }))
    table!.onRowOpen('u1')
    expect(selected).toEqual(['u1'])
  })
})
