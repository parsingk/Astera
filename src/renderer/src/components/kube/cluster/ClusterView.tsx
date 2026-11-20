import { useEffect, useState } from 'react'
import { RefreshCw, RotateCcw, Search } from 'lucide-react'
import { displayContextName } from '../../../../../core/kube/contextName'
import { useI18n } from '../../../i18n/I18nProvider'
import type { ClusterViewModel } from '../../../hooks/useClusterView'
import { KUBECTL_MISSING, type ObjectRef } from '../../../../../core/kube/cluster/types'
import { ContextMenu } from '../../ContextMenu'
import { ClusterTable } from './ClusterTable'
import { ClusterTree } from './ClusterTree'
import { clusterMenuItems } from './clusterMenu'

/** A watch's error line as shown: kubectl's own words, except a missing binary, which main names in English. */
export function liveErrorText(message: string, t: (key: 'kube.cluster.kubectlMissing') => string): string {
  return message === KUBECTL_MISSING ? t('kube.cluster.kubectlMissing') : message
}

/** A namespace typed by hand, where the cluster does not let us list them: applied on Enter or when the field is left. */
function NamespaceField({ value, onCommit }: { value: string | null; onCommit(ns: string | null): void }): React.JSX.Element {
  const { t } = useI18n()
  const [text, setText] = useState(value ?? '')
  useEffect(() => setText(value ?? ''), [value])
  const commit = (): void => {
    const next = text.trim()
    onCommit(next === '' ? null : next)
  }
  return (
    <input
      className="kube-pill kube-cluster-ns-input"
      value={text}
      placeholder={t('kube.cluster.allNamespaces')}
      title={t('kube.cluster.namespace')}
      aria-label={t('kube.cluster.namespace')}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
    />
  )
}

/** The Kubernetes tab's cluster view: toolbar, then the kind tree, the table and the detail column (spec 4.2). The
 *  Cluster | Operation log switch is drawn by the bottom panel, which hands it in as `toolbarStart`. */
export function ClusterView({
  model,
  detail,
  onOpenInEditor,
  toolbarStart
}: {
  model: ClusterViewModel
  detail: React.ReactNode
  /** The editor tab; without it the row menu has no such item and a double-click only selects. */
  onOpenInEditor?: (ref: ObjectRef) => void
  /** The toolbar row's first item, before the context pill: the bottom panel's segmented switch (spec 4.2). */
  toolbarStart?: React.ReactNode
}): React.JSX.Element {
  const { t } = useI18n()
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number } | null>(null)
  const { view, live } = model
  const failed = typeof live === 'object'
  const names = model.contexts?.contexts.map((c) => c.name) ?? []
  const contextName = view.context
  const contextOptions = contextName !== null && !names.includes(contextName) ? [contextName, ...names] : names
  const nsNames = model.namespaces ?? []
  const nsOptions = view.namespace !== null && !nsNames.includes(view.namespace) ? [view.namespace, ...nsNames] : nsNames

  const why = live === 'paused' ? model.pauseReason : null
  const liveText = failed
    ? liveErrorText(live.error, t)
    : live === 'live'
      ? t('kube.cluster.live')
      : live === 'limit'
        ? t('kube.cluster.limit')
        : why === null
          ? t('kube.cluster.paused')
          : t(why === 'ended' ? 'kube.cluster.pausedEnded' : 'kube.cluster.pausedForbidden')
  // Paused says why in a few words; the tooltip has it in full (spec 4.2, "paused" with the reason).
  const liveTitle = why !== null && why !== 'ended' ? why.forbidden : liveText
  const liveTone = failed ? 'bad' : live === 'live' ? 'ok' : 'wait'

  return (
    <div className="kube-cluster">
      <div className="kube-cluster-bar">
        {toolbarStart}
        {model.contextsError !== null && (
          <span className="kube-pill kube-pill-bad" title={model.contextsError}>
            <span className="kube-pill-text">{t('kube.cluster.kubeconfigError', { detail: model.contextsError })}</span>
          </span>
        )}
        {model.contextMissing && contextName !== null && (
          <span className="kube-pill kube-pill-bad" title={contextName}>
            <span className="kube-pill-text">{t('kube.cluster.contextMissing', { name: displayContextName(contextName).short })}</span>
          </span>
        )}
        <select
          className="kube-pill kube-pill-ctx"
          title={contextName ?? t('kube.cluster.context')}
          aria-label={t('kube.cluster.context')}
          value={contextName ?? ''}
          onChange={(e) => model.setContext(e.target.value)}
        >
          {contextName === null && <option value="" disabled />}
          {contextOptions.map((n) => (
            <option key={n} value={n}>
              {displayContextName(n).short}
            </option>
          ))}
        </select>

        {model.namespacesForbidden ? (
          <NamespaceField value={view.namespace} onCommit={model.setNamespace} />
        ) : (
          <select
            className="kube-pill kube-pill-ns"
            title={t('kube.cluster.namespace')}
            aria-label={t('kube.cluster.namespace')}
            value={view.namespace ?? ''}
            onChange={(e) => model.setNamespace(e.target.value === '' ? null : e.target.value)}
          >
            <option value="">{t('kube.cluster.allNamespaces')}</option>
            {nsOptions.map((n) => (
              <option key={n} value={n}>
                {t('kube.toolbar.ns', { ns: n })}
              </option>
            ))}
          </select>
        )}

        <label className="kube-cluster-filter">
          <Search size={12} aria-hidden="true" />
          <input
            value={view.filter}
            placeholder={t('kube.cluster.filter')}
            aria-label={t('kube.cluster.filter')}
            onChange={(e) => model.setFilter(e.target.value)}
          />
        </label>

        <span className="kube-cluster-live" role="status">
          <span className={`kube-cluster-dot ${liveTone}`} aria-hidden="true" />
          <span className="kube-cluster-live-text" title={liveTitle}>
            {liveText}
          </span>
          {failed && (
            <button type="button" className="kube-btn" title={t('kube.cluster.retry')} aria-label={t('kube.cluster.retry')} onClick={model.retry}>
              <RotateCcw size={13} />
            </button>
          )}
        </span>
        <button type="button" className="kube-btn" title={t('kube.cluster.refresh')} aria-label={t('kube.cluster.refresh')} onClick={model.refresh}>
          <RefreshCw size={14} />
        </button>
      </div>

      <div className="kube-cluster-body">
        <ClusterTree
          groups={model.groups}
          custom={model.customKinds}
          counts={model.counts}
          resource={view.resource}
          expanded={view.expanded}
          stale={failed}
          onSelect={model.selectKind}
          onToggle={model.toggleGroup}
        />
        <ClusterTable
          columns={model.columns}
          rows={model.rows}
          selected={view.selected}
          sort={view.sort}
          loading={model.loading}
          stale={failed}
          forbidden={model.listForbidden}
          failed={model.listFailed}
          onSort={model.sortBy}
          onSelect={model.select}
          onRowMenu={(uid, x, y) => {
            model.select(uid)
            setRowMenu({ x, y })
          }}
          // A double-click or Enter opens the row in the editor (spec 4.4); without one it selects, as a click does.
          onRowOpen={(uid) => {
            if (!onOpenInEditor) return model.select(uid)
            const row = model.rows.find((r) => r.uid === uid)
            const k = model.kind
            if (row && k && view.context !== null)
              onOpenInEditor({ context: view.context, namespace: k.namespaced ? row.namespace : null, resource: k.resource, kind: k.kind, name: row.name })
          }}
        />
        {detail}
      </div>
      {rowMenu !== null && model.kind !== null && (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          // Built from the model at each render: the menu opens as the row is selected, and its actions run on what is selected by then.
          items={clusterMenuItems(
            {
              kind: model.kind.kind,
              onOpenInEditor: onOpenInEditor ? () => model.selectedRef && onOpenInEditor(model.selectedRef) : undefined,
              onDescribe: () => model.setDetailTab('describe'),
              onCopyName: () => {
                if (model.selectedRef) void window.api.clipboard.writeText(model.selectedRef.name)
              }
            },
            t
          )}
          onClose={() => setRowMenu(null)}
        />
      )}
    </div>
  )
}
