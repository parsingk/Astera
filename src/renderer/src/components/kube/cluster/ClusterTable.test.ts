import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ClusterTable, ROW_HEIGHT, arrowTarget, scrollRowTop, scrollToShow } from './ClusterTable'

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

  // Re-review R1 and spec 4.3: a kind the person may not list says why in the table, in kubectl's words.
  it('shows a Forbidden refusal of the kind in its body instead of "empty"', () => {
    const line = 'Error from server (Forbidden): pods is forbidden: User "u" cannot list resource "pods"'
    const html = renderToStaticMarkup(React.createElement(ClusterTable, { ...props, rows: [], forbidden: line }))
    expect(html).toContain('<div class="kube-cluster-empty kube-cluster-forbidden">Error from server (Forbidden): pods is forbidden')
    expect(html).not.toContain('kube.cluster.empty')
    expect(html).not.toContain('kube-cluster-table stale')
  })

  // Task 10 minor: a one-shot list read at the watch limit that failed was swallowed, leaving "nothing here".
  it('shows a failed one-shot read of the list in its body instead of "empty"', () => {
    const html = renderToStaticMarkup(React.createElement(ClusterTable, { ...props, rows: [], failed: 'Unable to connect to the server' }))
    expect(html).toContain('<div class="kube-cluster-empty kube-cluster-failed">Unable to connect to the server</div>')
    expect(html).not.toContain('kube.cluster.empty')
    expect(renderToStaticMarkup(React.createElement(ClusterTable, { ...props, rows: [], loading: true }))).toContain('kube.cluster.loading')
  })
})

// Task 11 minor: the table drew again at every pixel of a scroll. The position is kept by row, so a scroll inside one
// row changes nothing the table draws from.
describe('scrollRowTop', () => {
  it('gives the same position for every pixel inside one row', () => {
    expect(scrollRowTop(0)).toBe(0)
    expect(scrollRowTop(ROW_HEIGHT - 1)).toBe(0)
    expect(scrollRowTop(ROW_HEIGHT)).toBe(ROW_HEIGHT)
    expect(scrollRowTop(ROW_HEIGHT * 2 - 1)).toBe(ROW_HEIGHT)
    expect(scrollRowTop(ROW_HEIGHT * 1000 + 13)).toBe(ROW_HEIGHT * 1000)
  })
})

// Task 11 minor: every drawn row was a tab stop. One row is (the selected one, else the first drawn), and the arrow keys
// move the selection, keeping the row it moves to in view.
describe('ClusterTable keyboard', () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ uid: `u${i}`, name: `p-${i}`, namespace: null, cells: [{ text: `p-${i}` }], attention: false }))
  const stops = (html: string): string[] => [...html.matchAll(/<tr class="kube-cluster-row[^"]*"[^>]*data-uid="([^"]+)"[^>]*tabindex="0"/g)].map((m) => m[1])
  const render = (extra: Record<string, unknown>): string => renderToStaticMarkup(React.createElement(ClusterTable, { ...props, rows, ...extra }))

  it('makes the selected row the one tab stop, else the first drawn row', () => {
    expect(stops(render({ selected: 'u3' }))).toEqual(['u3'])
    expect(stops(render({ selected: null }))).toEqual(['u0'])
    expect((render({ selected: 'u3' }).match(/tabindex="-1"/g) ?? []).length).toBeGreaterThan(5)
    // The selected row scrolled out of the drawn window: the first drawn row stands in, so the table stays reachable.
    expect(stops(render({ selected: 'u0', scrollTop: ROW_HEIGHT * 30, viewportHeight: ROW_HEIGHT * 5 }))).toEqual(['u20'])
  })

  it('moves one row with the arrow keys, and not past either end', () => {
    expect(arrowTarget(3, 'ArrowDown', 50)).toBe(4)
    expect(arrowTarget(3, 'ArrowUp', 50)).toBe(2)
    expect(arrowTarget(0, 'ArrowUp', 50)).toBeNull()
    expect(arrowTarget(49, 'ArrowDown', 50)).toBeNull()
    expect(arrowTarget(3, 'Enter', 50)).toBeNull()
  })

  it('scrolls only as far as needed to show the row moved to, below the sticky header', () => {
    const viewport = ROW_HEIGHT * 10
    expect(scrollToShow(5, 0, viewport)).toBe(0)
    expect(scrollToShow(8, 0, viewport)).toBe(0)
    // Row 9 would end under the bottom edge once the header's row is counted: scroll one row.
    expect(scrollToShow(9, 0, viewport)).toBe(ROW_HEIGHT)
    expect(scrollToShow(4, ROW_HEIGHT * 10, viewport)).toBe(ROW_HEIGHT * 4)
    expect(scrollToShow(12, ROW_HEIGHT * 10, viewport)).toBe(ROW_HEIGHT * 10)
  })
})
