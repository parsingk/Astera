import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ClusterDetail, PodsTable } from './ClusterDetail'
import { KubeYamlView } from './KubeYamlView'
import type { ClusterViewModel } from '../../../hooks/useClusterView'
import type { K8sObject } from '../../../../../core/kube/objects'

vi.mock('../../../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'ko',
    t: (key: string, p?: Record<string, unknown>) => (p ? `${key}${JSON.stringify(p)}` : key),
    tm: (m: unknown) => String(m)
  })
}))

const noop = (): void => {}
const ref = (kind: string, resource: string, name: string) => ({ context: 'c', namespace: 'dev', resource, kind, name })

function model(kind: string, resource: string, object: K8sObject, extra: Partial<ClusterViewModel> = {}): ClusterViewModel {
  return {
    view: { context: 'c', namespace: 'dev', resource, selected: 'u1', filter: '', sort: { by: 0, dir: 'asc' }, expanded: [], detailTab: 'summary' },
    kind: { kind, resource, namespaced: true },
    selected: object,
    selectedRef: ref(kind, resource, object.metadata.name ?? ''),
    deleted: false,
    detailError: null,
    owners: [],
    events: null,
    describe: null,
    pods: null,
    setDetailTab: noop,
    select: noop,
    selectRef: noop,
    ...extra
  } as unknown as ClusterViewModel
}

const render = (m: ClusterViewModel, props: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(React.createElement(ClusterDetail, { model: m, ...props }))


/** A tag's attributes, to follow the ids that tie a tab to its panel. */
const attrs = (tag: string): Record<string, string> => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]))
const tabsIn = (html: string): Array<Record<string, string>> => [...html.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map((m) => attrs(m[0]))
const panelIn = (html: string): Record<string, string> => attrs(html.match(/<div[^>]*role="tabpanel"[^>]*>/)?.[0] ?? '')

describe('ClusterDetail', () => {
  it('shows a Pods tab only for kinds with a selector', () => {
    const deployment: K8sObject = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'web', namespace: 'dev' },
      spec: { selector: { matchLabels: { app: 'web' } } }
    }
    const configMap: K8sObject = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'cfg', namespace: 'dev' } }
    expect(render(model('Deployment', 'deployments.apps', deployment))).toContain('kube.cluster.tab.pods')
    expect(render(model('ConfigMap', 'configmaps', configMap))).not.toContain('kube.cluster.tab.pods')
  })

  it('draws the header, and the editor button only when it is handled', () => {
    const cm: K8sObject = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'cfg', namespace: 'dev' } }
    const without = render(model('ConfigMap', 'configmaps', cm))
    expect(without).toContain('cfg')
    expect(without).toContain('kube.cluster.more')
    expect(without).not.toContain('kube.cluster.openInEditor')
    expect(render(model('ConfigMap', 'configmaps', cm), { onOpenInEditor: noop })).toContain('kube.cluster.openInEditor')
  })

  // Task 15 S5: a pencil reads as "edit" in a part that only reads; boards A and B draw open-in-editor as "open elsewhere".
  it('draws the editor button with the open-elsewhere icon, not a pencil', () => {
    const cm: K8sObject = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'cfg', namespace: 'dev' } }
    const html = render(model('ConfigMap', 'configmaps', cm), { onOpenInEditor: noop })
    expect(html).toMatch(/aria-label="kube\.cluster\.openInEditor"><svg [^>]*class="lucide lucide-external-link"/)
    expect(html).not.toContain('lucide-square-pen')
  })

  it('says a deleted object is deleted and keeps its content', () => {
    const cm: K8sObject = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'cfg', namespace: 'dev' } }
    const html = render(model('ConfigMap', 'configmaps', cm, { deleted: true }))
    expect(html).toContain('kube.cluster.deleted')
    expect(html).toContain('cfg')
  })

  // Final review M5: a failed watch of the selected object shows in the detail, not as the whole view's error.
  it('shows a failed watch of the selected object in the detail, with retry', () => {
    const cm: K8sObject = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'cfg', namespace: 'dev' } }
    const html = render(model('ConfigMap', 'configmaps', cm, { detailError: 'Error from server (Forbidden): configmaps "cfg" is forbidden' }))
    expect(html).toContain('<div class="kube-detail-watch-error" role="status">')
    expect(html).toContain('configmaps &quot;cfg&quot; is forbidden')
    expect(html).toContain('aria-label="kube.cluster.retry"')
    expect(render(model('ConfigMap', 'configmaps', cm, { detailError: null }))).not.toContain('kube-detail-watch-error')
  })

  // Task 12 minor: the tabs had no panel, no aria-controls and no arrow keys. The shown tab controls the one panel, which
  // is labelled by it, and only the shown tab is a tab stop (the arrows move between them).
  it('ties the shown tab to its panel, with one tab stop', () => {
    const cm: K8sObject = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'cfg', namespace: 'dev' } }
    const html = render(model('ConfigMap', 'configmaps', cm, { view: { ...model('ConfigMap', 'configmaps', cm).view, detailTab: 'yaml' } }))
    const tabs = tabsIn(html)
    const panel = panelIn(html)
    const shown = tabs.filter((tb) => tb['aria-selected'] === 'true')
    expect(shown).toHaveLength(1)
    expect(panel.id).toBeTruthy()
    expect(shown[0]['aria-controls']).toBe(panel.id)
    expect(panel['aria-labelledby']).toBe(shown[0].id)
    expect(tabs.map((tb) => tb.tabindex)).toEqual(tabs.map((tb) => (tb === shown[0] ? '0' : '-1')))
    expect(new Set(tabs.map((tb) => tb.id)).size).toBe(tabs.length)
  })

  it('draws nothing without a selection', () => {
    const cm: K8sObject = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'cfg' } }
    expect(render(model('ConfigMap', 'configmaps', cm, { selected: null, selectedRef: null }))).toBe('')
  })
})

describe('KubeYamlView', () => {
  const masked: K8sObject = { apiVersion: 'v1', kind: 'Secret', metadata: { name: 's', namespace: 'dev' }, data: { password: '***' } }
  const view = (reveal: React.ComponentProps<typeof KubeYamlView>['reveal']): string =>
    renderToStaticMarkup(React.createElement(KubeYamlView, { object: masked, kind: 'Secret', reveal }))

  it('masks a Secret until revealed', () => {
    const hidden = view({ values: null, failed: null, onReveal: noop, onHide: noop })
    expect(hidden).toContain('***')
    expect(hidden).toContain('kube.cluster.showValues')
    expect(hidden).not.toContain('hunter2')
    const shown = view({ values: [{ key: 'password', text: 'hunter2', base64: 'aHVudGVyMg==' }], failed: null, onReveal: noop, onHide: noop })
    expect(shown).toContain('hunter2')
    expect(shown).toContain('kube.cluster.hideValues')
    expect(shown).not.toContain('***')
  })

  // Task 12 minor: a failed "show values" showed nothing. It says so in a short line, kubectl's line as the tooltip.
  it('says a failed reveal failed, and nothing while there is no failure', () => {
    const html = view({ values: null, failed: 'Error from server (Forbidden): secrets "s" is forbidden', onReveal: noop, onHide: noop })
    expect(html).toContain('<div class="kube-yaml-note kube-yaml-error" role="alert" title="Error from server (Forbidden): secrets &quot;s&quot; is forbidden">kube.cluster.revealFailed</div>')
    expect(view({ values: null, failed: null, onReveal: noop, onHide: noop })).not.toContain('kube.cluster.revealFailed')
  })

  it('lists the keys kept as base64', () => {
    const html = view({ values: [{ key: 'blob', text: null, base64: 'AAEC' }], failed: null, onReveal: noop, onHide: noop })
    expect(html).toContain('kube.cluster.binaryKeys')
    expect(html).toContain('blob')
  })

  it('has no reveal button for other kinds', () => {
    const cm: K8sObject = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'c' }, data: { a: 'b' } }
    const html = renderToStaticMarkup(React.createElement(KubeYamlView, { object: cm, kind: 'ConfigMap', reveal: null }))
    expect(html).not.toContain('kube.cluster.showValues')
    expect(html).toContain('kube.cluster.serverFields')
  })
})

// Final review I5 and spec 4.5: the owner chain (Pod, ReplicaSet, Deployment) is drawn, each owner a link that selects it.
describe('ClusterDetail owner chain', () => {
  it('draws every owner of the chain as a link, nearest first', () => {
    const pod: K8sObject = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'w-1', namespace: 'dev', ownerReferences: [{ kind: 'ReplicaSet', name: 'w-6b8f9c', controller: true }] }
    }
    const rs = { context: 'c', namespace: 'dev', resource: 'replicasets.apps', kind: 'ReplicaSet', name: 'w-6b8f9c' }
    const deploy = { context: 'c', namespace: 'dev', resource: 'deployments.apps', kind: 'Deployment', name: 'w' }
    const html = render(model('Pod', 'pods', pod, { owners: [rs, deploy] }))
    expect(html).toContain('<button type="button" class="kube-detail-link">ReplicaSet w-6b8f9c</button>')
    expect(html).toContain('<button type="button" class="kube-detail-link">Deployment w</button>')
    expect(html.indexOf('ReplicaSet w-6b8f9c')).toBeLessThan(html.indexOf('Deployment w'))
  })
})

// Final review M3: "14, last 12m ago" is worded through the catalogs.
describe('ClusterDetail restarts', () => {
  it('words the restart count and when the last one was with a catalog key', () => {
    const pod: K8sObject = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'p', namespace: 'dev' },
      status: {
        phase: 'Running',
        containerStatuses: [{ name: 'a', restartCount: 14, lastState: { terminated: { exitCode: 1, reason: 'Error', finishedAt: new Date(Date.now() - 12 * 60_000).toISOString() } } }]
      }
    }
    const html = render(model('Pod', 'pods', pod))
    expect(html).toContain('kube.cluster.restartsAgo{&quot;count&quot;:&quot;14&quot;,&quot;ago&quot;:&quot;12m&quot;}')
    expect(html).not.toContain(' ago')
  })
})

describe('ClusterDetail containers', () => {
  it('labels requests and limits with catalog keys', () => {
    const pod: K8sObject = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'p', namespace: 'dev' },
      spec: { containers: [{ name: 'app', image: 'x:1', resources: { requests: { cpu: '100m' }, limits: { memory: '1Gi' } } }] }
    }
    const html = render(model('Pod', 'pods', pod))
    expect(html).toContain('kube.cluster.requests')
    expect(html).toContain('kube.cluster.limits')
    expect(html).not.toContain('>requests cpu')
    expect(html).not.toContain('; limits ')
  })
})

type El = { type: unknown; props: Record<string, unknown> }
/** Every element under `node`, so a handler can be called without a DOM (as ClusterTree.test.ts does). */
function elements(node: unknown): El[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (node === null || typeof node !== 'object' || !('props' in node)) return []
  const el = node as El
  return [el, ...elements(el.props.children)]
}

// Task 12 minor: the Pods rows were tab stops with a click handler and nothing for the keyboard. Enter and Space select
// the row's Pod, as a click does.
describe('PodsTable', () => {
  const row = { uid: 'p1', name: 'w-1', namespace: 'dev', cells: [{ text: 'w-1' }], attention: false }

  it('selects the Pod of a row with Enter or Space, and nothing with another key', () => {
    const picked: string[] = []
    const tree = PodsTable({ columns: [{ key: 'name', label: 'name', i18n: true }], rows: [row], onPick: (r) => void picked.push(r.name) })
    const tr = elements(tree).find((e) => e.props.className === 'kube-detail-pod')!
    const key = (k: string): boolean => {
      let prevented = false
      ;(tr.props.onKeyDown as ((e: unknown) => void) | undefined)?.({ key: k, preventDefault: () => (prevented = true) })
      return prevented
    }
    expect(key('Enter')).toBe(true)
    expect(key(' ')).toBe(true)
    expect(key('a')).toBe(false)
    expect(picked).toEqual(['w-1', 'w-1'])
  })
})
