import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ClusterView, namespaceCommit, rowObjectOf, rowRefOf } from './ClusterView'
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
  pauseReason: null,
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
    expect(html).toContain('<div class="kube-cluster-bar"><span class="switch-marker"></span><span class="kube-sel-tip"')
  })

  it('starts the row with the context pill without one', () => {
    const html = renderToStaticMarkup(React.createElement(ClusterView, { model, detail: null }))
    expect(html).toContain('<div class="kube-cluster-bar"><span class="kube-sel-tip"')
  })

  // The open list of a native select is drawn by the OS and ignores the theme: both pickers are the app's Select.
  it('draws the context and the namespace as the app dropdown', () => {
    const html = renderToStaticMarkup(React.createElement(ClusterView, { model, detail: null }))
    expect(html).not.toContain('<select')
    expect(html).toMatch(/<button[^>]*class="sel-trigger"[^>]*aria-label="kube.cluster.context"/)
    expect(html).toMatch(/<button[^>]*class="sel-trigger"[^>]*aria-label="kube.cluster.namespace"/)
    expect(html).toContain('title="kind-dev"')
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

  // Task 10 minor: a failed one-shot list read at the watch limit says why in the table.
  it('hands a failed one-shot list read to the table', () => {
    renderToStaticMarkup(React.createElement(ClusterView, { model: { ...model, live: 'limit', listFailed: 'Unable to connect to the server' }, detail: null }))
    expect(table!.failed).toBe('Unable to connect to the server')
  })

  // Spec 4.2: "paused" with the reason, the reason in full as its tooltip.
  it('says why the view is paused, with the kubectl line as the tooltip of a Forbidden kind', () => {
    const line = 'Error from server (Forbidden): pods is forbidden: User "u" cannot list resource "pods"'
    const forbidden = renderToStaticMarkup(
      React.createElement(ClusterView, { model: { ...model, live: 'paused', listForbidden: line, pauseReason: { forbidden: line } }, detail: null })
    )
    expect(forbidden).toContain('title="Error from server (Forbidden): pods is forbidden: User &quot;u&quot; cannot list resource &quot;pods&quot;">kube.cluster.pausedForbidden</span>')
    const ended = renderToStaticMarkup(React.createElement(ClusterView, { model: { ...model, live: 'paused', pauseReason: 'ended' }, detail: null }))
    expect(ended).toContain('title="kube.cluster.pausedEnded">kube.cluster.pausedEnded</span>')
    const limit = renderToStaticMarkup(React.createElement(ClusterView, { model: { ...model, live: 'limit', pauseReason: null }, detail: null }))
    expect(limit).toContain('title="kube.cluster.limit">kube.cluster.limit</span>')
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

// Task 12 minor: the row menu acted on the selection, so an item picked before the right-clicked row's selection came
// through did nothing. Its actions take the right-clicked row's own object, as opening a row does.
describe('rowRefOf', () => {
  const row = { uid: 'u1', name: 'w-1', namespace: 'api', cells: [], attention: false }

  it('names the object of the row itself, in its namespace', () => {
    expect(rowRefOf('kind-dev', { kind: 'Pod', resource: 'pods', namespaced: true }, row)).toEqual({
      context: 'kind-dev',
      namespace: 'api',
      resource: 'pods',
      kind: 'Pod',
      name: 'w-1'
    })
  })

  it('names no namespace for a cluster-scoped kind', () => {
    expect(rowRefOf('kind-dev', { kind: 'Node', resource: 'nodes', namespaced: false }, { ...row, name: 'n1', namespace: null })).toEqual({
      context: 'kind-dev',
      namespace: null,
      resource: 'nodes',
      kind: 'Node',
      name: 'n1'
    })
  })
})

// Spec 4.7: the row menu's logs open on the Pod's default container, which only the object says. The right-click selects
// the row, so the object is the selected one, when it is the row's.
describe('rowObjectOf', () => {
  const ref = { context: 'kind-dev', namespace: 'api', resource: 'pods', kind: 'Pod', name: 'w-1' }
  const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'w-1', namespace: 'api' } }

  it('is the selected object when it is the row\'s', () => {
    expect(rowObjectOf(pod, { ...ref }, ref)).toBe(pod)
  })

  it('is nothing while another object, or none, is selected', () => {
    expect(rowObjectOf(pod, { ...ref, name: 'w-2' }, ref)).toBeNull()
    expect(rowObjectOf(pod, { ...ref, namespace: 'web' }, ref)).toBeNull()
    expect(rowObjectOf(pod, { ...ref, context: 'kind-prod' }, ref)).toBeNull()
    expect(rowObjectOf(pod, { ...ref, resource: 'deployments.apps', kind: 'Deployment' }, ref)).toBeNull()
    expect(rowObjectOf(null, null, ref)).toBeNull()
  })
})

// Task 11 minor: the typed namespace (listing namespaces is Forbidden) was committed on every blur, unchanged too, and
// twice on Enter (Enter, then the blur that follows). Only a changed value is committed, once.
describe('namespaceCommit', () => {
  it('commits a changed namespace, trimmed, and an emptied field as All namespaces', () => {
    expect(namespaceCommit('  api ', 'web')).toBe('api')
    expect(namespaceCommit('api', null)).toBe('api')
    expect(namespaceCommit('', 'api')).toBeNull()
    expect(namespaceCommit('   ', 'api')).toBeNull()
  })

  it('commits nothing for the namespace last committed, so the blur after Enter does nothing', () => {
    expect(namespaceCommit('api', 'api')).toBeUndefined()
    expect(namespaceCommit(' api ', 'api')).toBeUndefined()
    expect(namespaceCommit('', null)).toBeUndefined()
  })
})
