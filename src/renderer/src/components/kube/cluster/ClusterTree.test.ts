import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { KIND_GROUPS } from '../../../../../core/kube/cluster/kinds'
import { ClusterTree } from './ClusterTree'

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
    expect(renderToStaticMarkup(React.createElement(ClusterTree, props))).toMatch(/<button type="button" class="kube-cluster-kind forbidden" title="secrets is forbidden" aria-disabled="true">/)
    const buttons = elements(ClusterTree(props)).filter((e) => typeof e.props.className === 'string' && e.props.className.startsWith('kube-cluster-kind'))
    for (const b of buttons) (b.props.onClick as (() => void) | undefined)?.()
    expect(picked).toEqual(['configmaps', 'horizontalpodautoscalers.autoscaling'])
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
