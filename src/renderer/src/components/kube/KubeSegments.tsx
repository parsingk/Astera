import { useI18n } from '../../i18n/I18nProvider'

export type KubeSegment = 'cluster' | 'log'

/** The Kubernetes tab's body (spec 4.1, D4): the Cluster | Operation log switch and the segment it picks. Port
 *  forwarding joins the switch in a later part. The switch is the first item of one row (spec 4.2): the Cluster
 *  segment's body places it at the head of its toolbar, and the log gets a row of its own with the switch in the same
 *  place, so it does not move on a switch. Both segments stay mounted under display:none, as the bottom panel's tabs
 *  do, so the log keeps what is open and the table its scroll across a switch. */
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
  const tab = (s: KubeSegment, label: string, count: number): React.JSX.Element => (
    <button
      type="button"
      role="tab"
      aria-selected={segment === s}
      className={segment === s ? 'kube-segment on' : 'kube-segment'}
      onClick={() => onSegment(s)}
    >
      {label}
      {count > 0 && <span className="kube-segment-count">{count}</span>}
    </button>
  )
  const switcher = (
    <div className="kube-segment-switch" role="tablist">
      {tab('cluster', t('kube.cluster.segment.cluster'), 0)}
      {tab('log', t('kube.cluster.segment.log'), logCount)}
    </div>
  )
  return (
    <div className="kube-segments">
      <div className="kube-segment-body" style={{ display: segment === 'cluster' ? 'flex' : 'none' }}>
        {cluster(switcher)}
      </div>
      <div className="kube-segment-body kube-segment-log" style={{ display: segment === 'log' ? 'flex' : 'none' }}>
        <div className="kube-segment-bar">{switcher}</div>
        {log}
      </div>
    </div>
  )
}
