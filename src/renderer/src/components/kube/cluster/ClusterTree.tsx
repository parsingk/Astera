import { ChevronDown, ChevronRight } from 'lucide-react'
import type { CountInfo, GroupId, KindDef, KindGroup } from '../../../../../core/kube/cluster/types'
import type { MessageKey } from '../../../../../core/i18n'
import { useI18n } from '../../../i18n/I18nProvider'

export interface ClusterTreeProps {
  groups: KindGroup[]
  /** The cluster's custom resource kinds, listed under the custom group. */
  custom: KindDef[]
  counts: Record<string, CountInfo>
  /** The picked kind's resource. */
  resource: string
  expanded: GroupId[]
  /** The cluster cannot be read right now: the last content stays, greyed. */
  stale?: boolean
  onSelect(resource: string): void
  onToggle(id: GroupId): void
}

const CUSTOM_GROUP: KindGroup = { id: 'custom', kinds: [] }

/** The kind's plural as the tree writes it (Pod, Pods; NetworkPolicy, NetworkPolicies; Ingress, Ingresses). */
function plural(kind: string): string {
  if (/[^aeiou]y$/i.test(kind)) return `${kind.slice(0, -1)}ies`
  return /(s|x|ch|sh)$/i.test(kind) ? `${kind}es` : `${kind}s`
}

/** The tree on the cluster view's left: the kind groups with their counts (spec 4.3). */
export function ClusterTree(p: ClusterTreeProps): React.JSX.Element {
  const { t } = useI18n()
  const groups = p.groups.some((g) => g.id === 'custom') ? p.groups : [...p.groups, CUSTOM_GROUP]

  const kindRow = (k: KindDef): React.JSX.Element => {
    const info = p.counts[k.resource]
    const forbidden = info?.forbidden
    const cls = 'kube-cluster-kind' + (k.resource === p.resource ? ' selected' : '') + (forbidden ? ' forbidden' : '')
    return (
      <button
        key={k.resource}
        type="button"
        className={cls}
        title={forbidden ?? k.resource}
        aria-current={k.resource === p.resource ? 'true' : undefined}
        onClick={() => p.onSelect(k.resource)}
      >
        <span className="kube-cluster-kind-name">{plural(k.kind)}</span>
        {info?.attention && !forbidden && (
          <span className="kube-cluster-attn" role="img" title={t('kube.cluster.attention')} aria-label={t('kube.cluster.attention')} />
        )}
        <span className="kube-cluster-count">{info === undefined || forbidden ? '' : info.count}</span>
      </button>
    )
  }

  return (
    <nav className={'kube-cluster-tree' + (p.stale ? ' stale' : '')} aria-label={t('kube.cluster.tree')}>
      {groups.map((g) => {
        const open = p.expanded.includes(g.id)
        const kinds = g.id === 'custom' ? p.custom : g.kinds
        const label = t(`kube.cluster.group.${g.id}` as MessageKey)
        return (
          <div key={g.id} className="kube-cluster-group">
            <button
              type="button"
              className="kube-cluster-group-head"
              aria-expanded={open}
              title={label}
              onClick={() => p.onToggle(g.id)}
            >
              {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
              <span>{label}</span>
            </button>
            {open && kinds.map(kindRow)}
          </div>
        )
      })}
    </nav>
  )
}
