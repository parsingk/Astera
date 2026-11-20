import { useI18n } from '../../i18n/I18nProvider'

export type KubeSegment = 'cluster' | 'log'

/** The Kubernetes tab's body (spec 4.1, D4): the Cluster | Operation log switch over the segment it picks. Port
 *  forwarding joins the switch in a later part. Both segments stay mounted under display:none, as the bottom panel's
 *  tabs do, so the log keeps what is open and the table its scroll across a switch. */
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
  cluster: React.ReactNode
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
  return (
    <div className="kube-segments">
      <div className="kube-segment-bar" role="tablist">
        {tab('cluster', t('kube.cluster.segment.cluster'), 0)}
        {tab('log', t('kube.cluster.segment.log'), logCount)}
      </div>
      <div className="kube-segment-body" style={{ display: segment === 'cluster' ? 'flex' : 'none' }}>
        {cluster}
      </div>
      <div className="kube-segment-body" style={{ display: segment === 'log' ? 'flex' : 'none' }}>
        {log}
      </div>
    </div>
  )
}
