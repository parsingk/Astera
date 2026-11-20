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
