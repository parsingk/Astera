import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { KubeContexts } from '../../../../core/kube/types'
import { ClusterPicker, NamespacePicker } from './ClusterPicker'

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
