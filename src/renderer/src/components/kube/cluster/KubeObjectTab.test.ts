import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { KubeObjectTab } from './KubeObjectTab'
import { liveErrorText } from './ClusterView'
import { KUBECTL_MISSING } from '../../../../../core/kube/cluster/types'

vi.mock('../../../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'ko',
    t: (key: string, p?: Record<string, unknown>) => (p ? `${key}${JSON.stringify(p)}` : key),
    tm: (m: unknown) => String(m)
  })
}))

const pod = { context: 'arn:aws:eks:ap-northeast-2:1:cluster/live', namespace: 'api', resource: 'pods', kind: 'Pod', name: 'w-1' }
const render = (target: typeof pod | { context: string; namespace: null; resource: string; kind: string; name: string }): string =>
  renderToStaticMarkup(React.createElement(KubeObjectTab, { target, visible: true }))


/** A tag's attributes, to follow the ids that tie a tab to its panel. */
const attrs = (tag: string): Record<string, string> => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]))
const tabsIn = (html: string): Array<Record<string, string>> => [...html.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map((m) => attrs(m[0]))
const panelIn = (html: string): Record<string, string> => attrs(html.match(/<div[^>]*role="tabpanel"[^>]*>/)?.[0] ?? '')

// Spec 4.6 and board B: where the object lives, a read-only chip, and the views; P1 has no edit, apply or compare.
describe('KubeObjectTab', () => {
  it('draws where the object lives, the read-only chip and the view switch', () => {
    const html = render(pod)
    expect(html).toContain('live / api')
    expect(html).toContain('kube.cluster.readOnly')
    for (const v of ['yaml', 'describe', 'events']) expect(html).toContain(`kube.cluster.tab.${v}`)
    expect(html).toContain('kube.cluster.loading') // nothing read yet
  })

  // Task 12 minor, as in the detail: the view switch's tabs control the tab's body, with one tab stop.
  it('ties the shown view to the body, with one tab stop', () => {
    const html = render(pod)
    const tabs = tabsIn(html)
    const panel = panelIn(html)
    expect(tabs.map((tb) => tb['aria-selected'])).toEqual(['true', 'false', 'false'])
    expect(tabs[0]['aria-controls']).toBe(panel.id)
    expect(panel['aria-labelledby']).toBe(tabs[0].id)
    expect(tabs.map((tb) => tb.tabindex)).toEqual(['0', '-1', '-1'])
  })

  it('names only the context for a cluster-scoped object', () => {
    const html = render({ context: 'kind-dev', namespace: null, resource: 'nodes', kind: 'Node', name: 'n1' })
    expect(html).toContain('>kind-dev<')
    expect(html).not.toContain('kind-dev / ')
  })

  it('says kubectl is missing in the catalog words', () => {
    expect(liveErrorText(KUBECTL_MISSING, (k) => `t:${k}`)).toBe('t:kube.cluster.kubectlMissing')
    expect(liveErrorText('Unable to connect to the server', (k) => `t:${k}`)).toBe('Unable to connect to the server')
  })

  it('offers no control that would change the object', () => {
    const labels = [...render(pod).matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1])
    expect(labels).toEqual(['kube.cluster.refresh'])
  })
})
