import { useEffect, useRef, useState } from 'react'
import { RefreshCw, RotateCcw, Search } from 'lucide-react'
import { displayContextName } from '../../../../../core/kube/contextName'
import { useI18n } from '../../../i18n/I18nProvider'
import type { ClusterViewModel } from '../../../hooks/useClusterView'
import { KUBECTL_MISSING, type KindDef, type ObjectRef, type Row } from '../../../../../core/kube/cluster/types'
import { ContextMenu } from '../../ContextMenu'
import { ClusterTable } from './ClusterTable'
import { ClusterTree } from './ClusterTree'
import { clusterMenuItems } from './clusterMenu'

/** A watch's error line as shown: kubectl's own words, except a missing binary, which main names in English. */
export function liveErrorText(message: string, t: (key: 'kube.cluster.kubectlMissing') => string): string {
  return message === KUBECTL_MISSING ? t('kube.cluster.kubectlMissing') : message
}

/** Where a row of the table lives: what opening the row and its menu act on, whatever is selected by then. */
export function rowRefOf(context: string, kind: KindDef, row: Row): ObjectRef {
  return { context, namespace: kind.namespaced ? row.namespace : null, resource: kind.resource, kind: kind.kind, name: row.name }
}

/** What the typed namespace field commits for `text`: the namespace, trimmed (null: emptied, All namespaces), or
 *  undefined when that is the namespace last committed, unchanged or already committed by the Enter before a blur. */
export function namespaceCommit(text: string, last: string | null): string | null | undefined {
  const next = text.trim() === '' ? null : text.trim()
  return next === last ? undefined : next
}

/** A namespace typed by hand, where the cluster does not let us list them: applied on Enter or when the field is left,
 *  only when it changed. */
function NamespaceField({ value, onCommit }: { value: string | null; onCommit(ns: string | null): void }): React.JSX.Element {
  const { t } = useI18n()
  const [text, setText] = useState(value ?? '')
  /** What was committed last (or picked elsewhere): the blur that follows an Enter must not commit it again. */
  const committed = useRef(value)
  useEffect(() => {
    setText(value ?? '')
    committed.current = value
  }, [value])
  const commit = (): void => {
    const next = namespaceCommit(text, committed.current)
    if (next === undefined) return
    committed.current = next
    onCommit(next)
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
  /** The open row menu, with the right-clicked row's object, which its actions act on. */
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; ref: ObjectRef } | null>(null)
  const { view, live } = model
  const refOfRow = (uid: string): ObjectRef | null => {
    const row = model.rows.find((r) => r.uid === uid)
    return row && model.kind && view.context !== null ? rowRefOf(view.context, model.kind, row) : null
  }
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
            const ref = refOfRow(uid)
            if (ref !== null) setRowMenu({ x, y, ref })
          }}
          // A double-click or Enter opens the row in the editor (spec 4.4); without one it selects, as a click does.
          onRowOpen={(uid) => {
            if (!onOpenInEditor) return model.select(uid)
            const ref = refOfRow(uid)
            if (ref !== null) onOpenInEditor(ref)
          }}
        />
        {detail}
      </div>
      {rowMenu !== null && (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          // The right-clicked row's own object: an item picked before its selection comes through still acts on it. Describe
          // shows in the detail, which the right-click selected.
          items={clusterMenuItems(
            {
              kind: rowMenu.ref.kind,
              onOpenInEditor: onOpenInEditor ? () => onOpenInEditor(rowMenu.ref) : undefined,
              onDescribe: () => model.setDetailTab('describe'),
              onCopyName: () => void window.api.clipboard.writeText(rowMenu.ref.name)
            },
            t
          )}
          onClose={() => setRowMenu(null)}
        />
      )}
    </div>
  )
}
