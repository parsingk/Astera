import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { KubeForward } from '../../../lib/kubeForwards'
import { LOST_POD } from '../../../../../core/kube/cluster/forward'
import { KubeForwardPanel } from './KubeForwardPanel'

vi.mock('../../../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'ko',
    t: (key: string, p?: Record<string, unknown>) => (p ? `${key}${JSON.stringify(p)}` : key),
    tm: (m: unknown) => String(m)
  })
}))

const noop = (): void => {}
const fwd = (over: Partial<KubeForward> = {}): KubeForward => ({
  id: 'f1',
  spec: {
    ref: { context: 'kind-dev', namespace: 'shop', resource: 'pods', kind: 'Pod', name: 'web-0' },
    local: 8080,
    remote: 80,
    remoteName: 'http'
  },
  state: 'connected',
  reason: null,
  connectedAt: Date.now() - 3000,
  endedAt: null,
  ...over
})
const render = (forwards: KubeForward[]): string =>
  renderToStaticMarkup(
    React.createElement(KubeForwardPanel, {
      switcher: React.createElement('span', null, 'SW'),
      forwards,
      onOpen: noop,
      onStop: noop,
      onStopAll: noop,
      onReconnect: noop,
      onRemove: noop
    })
  )

describe('KubeForwardPanel', () => {
  it('draws a connected row with its address and actions', () => {
    const html = render([fwd()])
    expect(html).toContain('web-0')
    expect(html).toContain('127.0.0.1:8080')
    expect(html).toContain('80 http')
    expect(html).toContain('kind-dev / shop')
    expect(html).toContain('kube.forward.state.connected')
    expect(html).toContain('<button type="button" class="kube-forward-link"')
    expect(html).toContain('kube.forward.openBrowser')
    expect(html).toContain('kube.forward.stop"')
    expect(html).not.toContain('kube.forward.reconnect')
  })
  it('draws a disconnected row with its reason and actions', () => {
    const html = render([fwd({ state: 'disconnected', reason: LOST_POD, endedAt: Date.now() })])
    expect(html).toContain('kube.forward.state.disconnected{&quot;reason&quot;:&quot;kube.forward.lostPod&quot;}')
    expect(html).toContain('kube.forward.reconnect')
    expect(html).toContain('kube.forward.remove')
    expect(html).not.toContain('kube-forward-link')
  })
  it("draws a failed row with kubectl's line", () => {
    const html = render([fwd({ state: 'failed', reason: 'unable to listen on port 8080', connectedAt: null, endedAt: 1 })])
    expect(html).toContain('kube.forward.state.failed{&quot;reason&quot;:&quot;unable to listen on port 8080&quot;}')
  })
  it('says the plain state when there is no reason', () => {
    expect(render([fwd({ state: 'failed', reason: null, connectedAt: null, endedAt: 1 })])).toContain('kube.forward.state.failedPlain')
  })
  it('disables stop all with no live row', () => {
    const html = render([fwd({ state: 'stopped', endedAt: Date.now() })])
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="kube.forward.stopAll"|<button[^>]*aria-label="kube.forward.stopAll"[^>]*disabled=""/)
  })
  it('says so when there is none', () => {
    expect(render([])).toContain('kube.forward.empty')
  })
})
