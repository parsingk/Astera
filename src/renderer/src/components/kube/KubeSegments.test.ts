import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { KubeSegments } from './KubeSegments'

vi.mock('../../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'ko', t: (key: string) => key, tm: (m: unknown) => String(m) })
}))

const render = (extra: Record<string, unknown>): string =>
  renderToStaticMarkup(
    React.createElement(KubeSegments, {
      segment: 'cluster',
      onSegment: () => {},
      logCount: 0,
      cluster: (sw: React.ReactNode) => React.createElement('div', null, sw),
      log: null,
      ...extra
    })
  )
const forward = (sw: React.ReactNode): React.ReactNode => React.createElement('div', null, sw)

describe('KubeSegments', () => {
  it('shows the forward count on the switch', () => {
    const html = render({ forward, forwardCount: 2 })
    expect(html).toMatch(/data-segment="forward"[^>]*>kube.cluster.segment.forward<span class="kube-segment-count">2<\/span>/)
  })
  it('orders the switch Cluster, Port forwarding, Operation log', () => {
    const html = render({ forward, forwardCount: 0 })
    const at = (s: string): number => html.indexOf(`data-segment="${s}"`)
    expect(at('cluster')).toBeGreaterThan(-1)
    expect(at('cluster')).toBeLessThan(at('forward'))
    expect(at('forward')).toBeLessThan(at('log'))
  })
  it('draws no Port forwarding radio without a forward body', () => {
    expect(render({})).not.toContain('data-segment="forward"')
  })
})
