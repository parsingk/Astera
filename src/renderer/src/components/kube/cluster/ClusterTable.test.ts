import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ClusterTable } from './ClusterTable'

vi.mock('../../../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'ko',
    t: (key: string, p?: Record<string, unknown>) => (p ? `${key}${JSON.stringify(p)}` : key),
    tm: (m: unknown) => String(m)
  })
}))

const noop = (): void => {}
const columns = [{ key: 'name', label: 'kube.cluster.col.name', i18n: true }]
const props = {
  columns,
  selected: null,
  sort: { by: 0, dir: 'asc' as const },
  viewportHeight: 260,
  scrollTop: 0,
  onSort: noop,
  onSelect: noop,
  onRowMenu: noop,
  onRowOpen: noop
}

describe('ClusterTable', () => {
  it('renders only the rows in view', () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({
      uid: String(i),
      name: `p-${i}`,
      namespace: null,
      cells: [{ text: `p-${i}` }],
      attention: false
    }))
    const html = renderToStaticMarkup(React.createElement(ClusterTable, { ...props, rows }))
    expect((html.match(/<tr /g) ?? []).length).toBeLessThan(40)
    expect(html).toContain('p-0')
    expect(html).not.toContain('p-1999')
  })

  it('renders the rows around the scroll position, with spacers for the rest', () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({
      uid: String(i),
      name: `p-${i}`,
      namespace: null,
      cells: [{ text: `p-${i}` }],
      attention: false
    }))
    const html = renderToStaticMarkup(React.createElement(ClusterTable, { ...props, rows, scrollTop: 26 * 1000 }))
    expect(html).toContain('>p-1000<')
    expect(html).not.toContain('>p-0<')
    expect(html).toContain('kube-cluster-spacer')
  })

  it('shows the status word beside its dot', () => {
    const rows = [{ uid: 'a', name: 'a', namespace: null, cells: [{ text: 'CrashLoopBackOff', tone: 'bad' as const }], attention: true }]
    const html = renderToStaticMarkup(React.createElement(ClusterTable, { ...props, rows }))
    expect(html).toContain('CrashLoopBackOff')
    expect(html).toContain('kube-cluster-dot bad')
  })

  it('says when a list is empty', () => {
    const html = renderToStaticMarkup(React.createElement(ClusterTable, { ...props, rows: [] }))
    expect(html).toContain('kube.cluster.empty')
  })
})
