import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { KubeContexts } from '../../../../core/kube/types'
import { ClusterPicker, NamespacePicker, filterContexts, pickerCursor, pickerEnter } from './ClusterPicker'

vi.mock('../../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'ko',
    t: (key: string, p?: Record<string, unknown>) => (p ? `${key}${JSON.stringify(p)}` : key),
    tm: (m: unknown) => String(m)
  })
}))

const ARN = 'arn:aws:eks:us-east-1:123456789012:cluster/prod'
const GKE = 'gke_proj_asia-northeast3_staging'
const contexts: KubeContexts = {
  current: 'kind-dev',
  contexts: [
    { name: 'kind-dev', namespace: 'dev', cluster: 'kind-dev', provider: null },
    { name: ARN, namespace: null, cluster: ARN, provider: 'eks' },
    { name: GKE, namespace: null, cluster: GKE, provider: 'gke' }
  ]
}
const noop = (): void => {}
const props = {
  contexts,
  selected: ARN as string | null,
  rememberFolder: '/p/k8s',
  rememberChoices: ['/p/k8s/deep', '/p/k8s', '/p'],
  projectRoot: '/p',
  onPick: noop,
  onUseContext: noop,
  onAddKubeconfig: noop,
  onOpenSettings: noop,
  onClose: noop
}
const render = (over: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(React.createElement(ClusterPicker, { ...props, ...over } as never))

describe('ClusterPicker', () => {
  it('lists contexts with the short name, the full name as tooltip and the provider tag', () => {
    const html = render()
    expect(html).toContain('>prod<')
    expect(html).toContain(`title="${ARN}"`)
    expect(html).toContain('>EKS<')
    expect(html).toContain('>GKE<')
    expect(html).toContain('>staging<')
    expect(html).toContain('kube.picker.search')
  })

  it('checks the selected context and marks kubeconfig current', () => {
    const html = render()
    const rows = html.split('<li').slice(1)
    const selected = rows.filter((r) => r.includes('aria-selected="true"'))
    expect(selected).toHaveLength(1)
    expect(selected[0]).toContain('prod')
    expect(selected[0]).toContain('lucide-check')
    expect(html.match(/lucide-check/g)).toHaveLength(1)
    const current = rows.filter((r) => r.includes('kube.picker.current'))
    expect(current).toHaveLength(1)
    expect(current[0]).toContain('kind-dev')
  })

  it('lists the folder chooser from the file folder up to the root, defaulting to the service folder', () => {
    const html = render()
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked=""/)
    const opts = [...html.matchAll(/<option value="([^"]+)"( selected="")?/g)].map((m) => [m[1], !!m[2]])
    expect(opts).toEqual([
      ['/p/k8s/deep', false],
      ['/p/k8s', true],
      ['/p', false]
    ])
    expect(html).toContain('k8s/deep')
  })

  it('falls back to the first choice when the service folder is not among them, and hides the row without choices', () => {
    const html = render({ rememberFolder: '/elsewhere' })
    expect([...html.matchAll(/<option value="([^"]+)"( selected="")?/g)][0][2]).toBe(' selected=""')
    expect(render({ rememberChoices: [] })).not.toContain('type="checkbox"')
  })

  it('offers the explicit use-context item for the selection, add kubeconfig and settings', () => {
    const html = render()
    expect(html).toContain('kube.picker.useContext{&quot;name&quot;:&quot;prod&quot;}')
    expect(html).toContain('kube.picker.addKubeconfig')
    expect(html).toContain('kube.picker.settings')
  })

  it('has no use-context item without a selection', () => {
    expect(render({ selected: null })).not.toContain('kube.picker.useContext')
  })

  it('says so when no context exists', () => {
    expect(render({ contexts: { contexts: [], current: null } })).toContain('kube.picker.empty')
  })
})

describe('NamespacePicker', () => {
  it('is a text input holding the current value', () => {
    const html = renderToStaticMarkup(
      React.createElement(NamespacePicker, { value: 'dev', onPick: noop, onClose: noop } as never)
    )
    expect(html).toMatch(/<input[^>]*value="dev"/)
    expect(html).toContain('kube.picker.namespacePlaceholder')
  })
})

describe('filterContexts', () => {
  const names = (q: string): string[] => filterContexts(contexts.contexts, q).map((c) => c.name)

  it('finds an EKS context by its short cluster name and by part of the ARN', () => {
    expect(names('prod')).toEqual([ARN])
    expect(names('123456')).toEqual([ARN])
    expect(names('us-east')).toEqual([ARN])
  })

  it('finds a GKE context by its short name, ignoring case and surrounding spaces', () => {
    expect(names('  STAGING ')).toEqual([GKE])
  })

  it('an empty or blank query returns everything in order', () => {
    expect(names('')).toEqual(['kind-dev', ARN, GKE])
    expect(names('   ')).toEqual(['kind-dev', ARN, GKE])
  })

  it('no match returns an empty list', () => {
    expect(names('nope')).toEqual([])
  })
})

describe('pickerCursor and pickerEnter', () => {
  it('moves down and up, wrapping at both ends', () => {
    expect(pickerCursor(0, 3, 'ArrowDown')).toBe(1)
    expect(pickerCursor(2, 3, 'ArrowDown')).toBe(0)
    expect(pickerCursor(0, 3, 'ArrowUp')).toBe(2)
    expect(pickerCursor(2, 3, 'ArrowUp')).toBe(1)
  })

  it('clamps a stale cursor and stays at 0 for an empty list', () => {
    expect(pickerCursor(7, 3, 'ArrowDown')).toBe(2)
    expect(pickerCursor(0, 0, 'ArrowDown')).toBe(0)
  })

  it('Enter picks the item under the cursor, the first one at the start, a clamped one when stale', () => {
    expect(pickerEnter(contexts.contexts, 0)).toBe('kind-dev')
    expect(pickerEnter(contexts.contexts, 1)).toBe(ARN)
    expect(pickerEnter(contexts.contexts, 5)).toBe(GKE)
  })

  it('Enter with an empty list picks nothing', () => {
    expect(pickerEnter([], 0)).toBeNull()
  })
})
