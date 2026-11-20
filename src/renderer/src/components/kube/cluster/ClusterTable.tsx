import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import type { Column, Row } from '../../../../../core/kube/cluster/types'
import type { MessageKey } from '../../../../../core/i18n'
import { useI18n } from '../../../i18n/I18nProvider'

export const ROW_HEIGHT = 26
/** Rows drawn beyond the viewport on each side, so a fast scroll does not show blanks. */
const OVERSCAN = 10
const DEFAULT_VIEWPORT = 400

export interface ClusterTableProps {
  columns: Column[]
  rows: Row[]
  selected: string | null
  sort: { by: number; dir: 'asc' | 'desc' }
  /** The list has not arrived yet: a wait line instead of "empty". */
  loading?: boolean
  /** The cluster cannot be read right now: the last rows stay, greyed. */
  stale?: boolean
  /** The kind may not be listed: kubectl's Forbidden line, shown where the rows would be. */
  forbidden?: string | null
  /** The one-shot read of the list (its watch refused at the limit) failed: its line, shown where the rows would be. */
  failed?: string | null
  /** Fixed values for tests; the live table measures its own scroll container. */
  viewportHeight?: number
  scrollTop?: number
  onSort(column: number): void
  onSelect(uid: string): void
  onRowMenu(uid: string, x: number, y: number): void
  onRowOpen(uid: string): void
}

/** The table of the picked kind (spec 4.4). A real table, but only the rows in view are drawn, with a spacer row for
 *  each side standing in for the rest, since a busy cluster lists thousands. */
export function ClusterTable(p: ClusterTableProps): React.JSX.Element {
  const { t } = useI18n()
  const box = useRef<HTMLDivElement>(null)
  const [measured, setMeasured] = useState({ height: DEFAULT_VIEWPORT, top: 0 })
  const height = p.viewportHeight ?? measured.height
  const top = p.scrollTop ?? measured.top

  useEffect(() => {
    const el = box.current
    if (el === null || p.viewportHeight !== undefined) return
    const measure = (): void => setMeasured((m) => (m.height === el.clientHeight ? m : { ...m, height: el.clientHeight }))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [p.viewportHeight])

  const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(p.rows.length, Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN)
  const visible = p.rows.slice(first, last)
  const spacer = (rows: number): React.ReactNode =>
    rows > 0 ? (
      <tr className="kube-cluster-spacer" aria-hidden="true" style={{ height: rows * ROW_HEIGHT }}>
        <td colSpan={Math.max(1, p.columns.length)} />
      </tr>
    ) : null

  return (
    <div
      ref={box}
      className={'kube-cluster-table' + (p.stale ? ' stale' : '')}
      onScroll={(e) => {
        const next = e.currentTarget.scrollTop
        setMeasured((m) => (m.top === next ? m : { ...m, top: next }))
      }}
    >
      <table>
        <thead>
          <tr>
            {p.columns.map((c, i) => {
              const label = c.i18n ? t(`kube.cluster.col.${c.key}` as MessageKey) : c.label
              const sorted = p.sort.by === i
              return (
                <th key={c.key + i} aria-sort={sorted ? (p.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" className="kube-cluster-th" onClick={() => p.onSort(i)}>
                    {label}
                    {sorted && (p.sort.dir === 'asc' ? <ArrowUp size={11} aria-hidden="true" /> : <ArrowDown size={11} aria-hidden="true" />)}
                  </button>
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {spacer(first)}
          {visible.map((r) => (
            <tr
              key={r.uid}
              className={'kube-cluster-row' + (r.uid === p.selected ? ' selected' : '')}
              style={{ height: ROW_HEIGHT }}
              tabIndex={0}
              aria-selected={r.uid === p.selected}
              onClick={() => p.onSelect(r.uid)}
              onDoubleClick={() => p.onRowOpen(r.uid)}
              onContextMenu={(e) => {
                e.preventDefault()
                p.onRowMenu(r.uid, e.clientX, e.clientY)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') p.onRowOpen(r.uid)
                else if (e.key === ' ') {
                  e.preventDefault()
                  p.onSelect(r.uid)
                }
              }}
            >
              {r.cells.map((c, i) => (
                <td key={i} title={c.text}>
                  {c.tone ? (
                    <>
                      <span className={`kube-cluster-dot ${c.tone}`} aria-hidden="true" />
                      {c.text}
                    </>
                  ) : (
                    c.text
                  )}
                </td>
              ))}
            </tr>
          ))}
          {spacer(p.rows.length - last)}
        </tbody>
      </table>
      {p.rows.length === 0 &&
        (p.forbidden ? (
          <div className="kube-cluster-empty kube-cluster-forbidden">{p.forbidden}</div>
        ) : p.failed ? (
          <div className="kube-cluster-empty kube-cluster-failed">{p.failed}</div>
        ) : (
          <div className="kube-cluster-empty">{p.loading ? t('kube.cluster.loading') : t('kube.cluster.empty')}</div>
        ))}
    </div>
  )
}
