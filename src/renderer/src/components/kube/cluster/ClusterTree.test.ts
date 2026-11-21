import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { KIND_GROUPS } from '../../../../../core/kube/cluster/kinds'
import { ClusterTree, kindPlural } from './ClusterTree'

vi.mock('../../../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'ko',
    t: (key: string, p?: Record<string, unknown>) => (p ? `${key}${JSON.stringify(p)}` : key),
    tm: (m: unknown) => String(m)
  })
}))

const noop = (): void => {}

type El = { props: Record<string, unknown> }
/** Every element under `node`, so a handler can be called without a DOM. */
function elements(node: unknown): El[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (node === null || typeof node !== 'object' || !('props' in node)) return []
  const el = node as El
  return [el, ...elements(el.props.children)]
}

describe('ClusterTree', () => {
  it('shows counts, a problem dot and a greyed forbidden kind', () => {
    const html = renderToStaticMarkup(
      React.createElement(ClusterTree, {
        groups: KIND_GROUPS,
        custom: [],
        counts: {
          pods: { count: 8, attention: true },
          secrets: { count: 0, attention: false, forbidden: 'secrets is forbidden' }
        },
        resource: 'pods',
        expanded: ['workloads', 'config'],
        onSelect: noop,
        onToggle: noop
      })
    )
    expect(html).toContain('kube.cluster.attention')
    expect(html).toContain('title="secrets is forbidden"')
  })

  it('lists the custom kinds under the custom group when it is expanded', () => {
    const html = renderToStaticMarkup(
      React.createElement(ClusterTree, {
        groups: KIND_GROUPS,
        custom: [{ kind: 'Widget', resource: 'widgets.example.com', namespaced: true }],
        counts: {},
        resource: 'pods',
        expanded: ['custom'],
        onSelect: noop,
        onToggle: noop
      })
    )
    expect(html).toContain('Widget')
  })

  // Final review M5 and spec 4.3: a Forbidden kind never fails the view, so it cannot be picked (its watch would fail
  // and grey the whole view as if the cluster were down).
  it('makes a Forbidden kind inert', () => {
    const picked: string[] = []
    const props = {
      groups: KIND_GROUPS,
      custom: [],
      counts: { secrets: { count: null, attention: false, forbidden: 'secrets is forbidden' } },
      resource: 'pods',
      expanded: ['config' as const],
      onSelect: (r: string) => void picked.push(r),
      onToggle: noop
    }
    expect(renderToStaticMarkup(React.createElement(ClusterTree, props))).toMatch(/<button type="button" class="kube-cluster-kind forbidden" title="secrets is forbidden" aria-label="Secrets" aria-disabled="true">/)
    const buttons = elements(ClusterTree(props)).filter((e) => typeof e.props.className === 'string' && e.props.className.startsWith('kube-cluster-kind'))
    for (const b of buttons) (b.props.onClick as (() => void) | undefined)?.()
    expect(picked).toEqual(['configmaps', 'horizontalpodautoscalers.autoscaling'])
  })

  // Task 15 S6: a kind button is named as it reads (its plural, the problem dot, the count), not by its raw resource.
  it('names each kind button by its display name, problem dot and count', () => {
    const html = renderToStaticMarkup(
      React.createElement(ClusterTree, {
        groups: KIND_GROUPS,
        custom: [],
        counts: {
          pods: { count: 8, attention: true },
          'deployments.apps': { count: 3, attention: false },
          'statefulsets.apps': { count: null, attention: false },
          secrets: { count: null, attention: false, forbidden: 'secrets is forbidden' }
        },
        resource: 'pods',
        expanded: ['workloads', 'config'],
        onSelect: noop,
        onToggle: noop
      })
    )
    expect(html).toContain('aria-label="Pods kube.cluster.attention 8"')
    expect(html).toContain('aria-label="Deployments 3"')
    expect(html).toContain('aria-label="StatefulSets"')
    expect(html).toContain('aria-label="Secrets"')
    expect(html).not.toContain('aria-label="deployments.apps"')
  })

  // Final review I1: a count that could not be read shows no number (never a false 0), and one kept from the last read
  // shows greyed with its problem dot.
  it('shows no number for an unknown count and greys a kept one', () => {
    const html = renderToStaticMarkup(
      React.createElement(ClusterTree, {
        groups: KIND_GROUPS,
        custom: [],
        counts: {
          pods: { count: 3, attention: true, stale: true },
          'deployments.apps': { count: null, attention: false }
        },
        resource: 'pods',
        expanded: ['workloads'],
        onSelect: noop,
        onToggle: noop
      })
    )
    expect(html).toContain('<span class="kube-cluster-count stale">3</span>')
    expect(html).toContain('kube-cluster-attn stale')
    expect(html).toMatch(/Deployments<\/span><span class="kube-cluster-count"><\/span>/)
  })
})

// Task 11 minor: the tree guessed a custom kind's plural from its kind (PodChaos read "PodChaoses"). It shows the CRD's
// own plural, the resource before its group, in the kind's case where the two agree.
describe('kindPlural', () => {
  it('shows a custom kind by its CRD plural', () => {
    expect(kindPlural({ kind: 'PodChaos', resource: 'podchaos.chaos-mesh.org', namespaced: true })).toBe('PodChaos')
    expect(kindPlural({ kind: 'Prometheus', resource: 'prometheuses.monitoring.coreos.com', namespaced: true })).toBe('Prometheuses')
    expect(kindPlural({ kind: 'Person', resource: 'people.example.com', namespaced: true })).toBe('People')
    expect(kindPlural({ kind: 'Widget', resource: 'gizmos.example.com', namespaced: true })).toBe('gizmos')
  })

  it('reads every fixed kind as spec 4.3 lists it', () => {
    expect(KIND_GROUPS.flatMap((g) => g.kinds).map(kindPlural)).toEqual([
      'Deployments', 'StatefulSets', 'DaemonSets', 'ReplicaSets', 'Jobs', 'CronJobs', 'Pods',
      'Services', 'Ingresses', 'EndpointSlices', 'NetworkPolicies',
      'ConfigMaps', 'Secrets', 'HorizontalPodAutoscalers',
      'PersistentVolumeClaims', 'PersistentVolumes', 'StorageClasses',
      'ServiceAccounts', 'Roles', 'RoleBindings', 'ClusterRoles', 'ClusterRoleBindings',
      'Nodes', 'Namespaces', 'CustomResourceDefinitions', 'Events'
    ])
  })

  it('draws a custom kind in the tree by its CRD plural', () => {
    const html = renderToStaticMarkup(
      React.createElement(ClusterTree, {
        groups: KIND_GROUPS,
        custom: [{ kind: 'PodChaos', resource: 'podchaos.chaos-mesh.org', namespaced: true }],
        counts: {},
        resource: 'pods',
        expanded: ['custom'],
        onSelect: noop,
        onToggle: noop
      })
    )
    expect(html).toContain('<span class="kube-cluster-kind-name">PodChaos</span>')
    expect(html).not.toContain('PodChaoses')
  })
})
