import { useEffect, useRef } from 'react'
import { useI18n } from '../../i18n/I18nProvider'
import { arrowStep } from '../../lib/arrowStep'

export type KubeSegment = 'cluster' | 'log'
const SEGMENTS: KubeSegment[] = ['cluster', 'log']

/** The Kubernetes tab's body (spec 4.1, D4): the Cluster | Operation log switch and the segment it picks. Port
 *  forwarding joins the switch in a later part. The switch is the first item of one row (spec 4.2): the Cluster
 *  segment's body places it at the head of its toolbar, and the log gets a row of its own with the switch in the same
 *  place, so it does not move on a switch. Both segments stay mounted under display:none, as the bottom panel's tabs
 *  do, so the log keeps what is open and the table its scroll across a switch. The switch is a radio group, not a
 *  tablist, since it sits inside the bottom panel's own tabs. */
export function KubeSegments({
  segment,
  onSegment,
  logCount,
  cluster,
  log
}: {
  segment: KubeSegment
  onSegment(s: KubeSegment): void
  /** Entries in the operation log; shown beside its label only when non-zero. */
  logCount: number
  /** The Cluster segment's body, given the switch to put first in its toolbar row. */
  cluster: (switcher: React.ReactNode) => React.ReactNode
  log: React.ReactNode
}): React.JSX.Element {
  const { t } = useI18n()
  const bodies = { cluster: useRef<HTMLDivElement>(null), log: useRef<HTMLDivElement>(null) }
  /** The switch had the focus when the segment changed: each segment's body draws its own copy, and the one used is about
   *  to hide, so the focus moves to the shown copy. */
  const refocus = useRef(false)
  const pick = (s: KubeSegment, from: HTMLElement): void => {
    // The shown segment again changes nothing, and must not leave a refocus waiting for a later change from elsewhere.
    if (s === segment) return
    refocus.current = from.contains(document.activeElement)
    onSegment(s)
  }
  useEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    bodies[segment].current?.querySelector<HTMLElement>('.kube-segment-switch [role="radio"][aria-checked="true"]')?.focus()
    // `bodies` holds refs, the same at every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segment])

  const radio = (s: KubeSegment, label: string, count: number): React.JSX.Element => (
    <button
      type="button"
      role="radio"
      aria-checked={segment === s}
      // One tab stop, the checked segment; the arrows move the check (ARIA's radio group pattern).
      tabIndex={segment === s ? 0 : -1}
      data-segment={s}
      className={segment === s ? 'kube-segment on' : 'kube-segment'}
      onClick={(e) => pick(s, e.currentTarget)}
      onKeyDown={(e) => {
        const to = arrowStep(SEGMENTS, segment, e.key, true)
        if (to === null) return
        e.preventDefault()
        pick(to, e.currentTarget)
      }}
    >
      {label}
      {count > 0 && <span className="kube-segment-count">{count}</span>}
    </button>
  )
  const switcher = (
    <div className="kube-segment-switch" role="radiogroup" aria-label={t('kube.log.tab')}>
      {radio('cluster', t('kube.cluster.segment.cluster'), 0)}
      {radio('log', t('kube.cluster.segment.log'), logCount)}
    </div>
  )
  return (
    <div className="kube-segments">
      <div ref={bodies.cluster} className="kube-segment-body" style={{ display: segment === 'cluster' ? 'flex' : 'none' }}>
        {cluster(switcher)}
      </div>
      <div ref={bodies.log} className="kube-segment-body kube-segment-log" style={{ display: segment === 'log' ? 'flex' : 'none' }}>
        <div className="kube-segment-bar">{switcher}</div>
        {log}
      </div>
    </div>
  )
}
