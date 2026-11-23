import { useEffect, useRef, useState } from 'react'
import { RefreshCw, RotateCcw, Search } from 'lucide-react'
import { displayContextName } from '../../../../../core/kube/contextName'
import type { K8sObject } from '../../../../../core/kube/objects'
import { useI18n } from '../../../i18n/I18nProvider'
import type { ClusterViewModel } from '../../../hooks/useClusterView'
import { KUBECTL_MISSING, LIST_PAGE_TOO_LARGE, type KindDef, type ObjectRef, type Row } from '../../../../../core/kube/cluster/types'
import { ContextMenu } from '../../ContextMenu'
import { Select } from '../../Select'
import { ClusterTable } from './ClusterTable'
import { ClusterTree } from './ClusterTree'
import { clusterMenuItems, shellChoice, writeMenuHandlers, type WriteAsk } from './clusterMenu'

/** A watch's error line as shown: kubectl's own words, except a missing binary and a list page over the cap, which main
 *  names in English. */
export function liveErrorText(message: string, t: (key: 'kube.cluster.kubectlMissing' | 'kube.cluster.pageTooLarge') => string): string {
  if (message === KUBECTL_MISSING) return t('kube.cluster.kubectlMissing')
  return message === LIST_PAGE_TOO_LARGE ? t('kube.cluster.pageTooLarge') : message
}

/** Where a row of the table lives: what opening the row and its menu act on, whatever is selected by then. */
export function rowRefOf(context: string, kind: KindDef, row: Row): ObjectRef {
  return { context, namespace: kind.namespaced ? row.namespace : null, resource: kind.resource, kind: kind.kind, name: row.name }
}

/** The right-clicked row's object, which the right-click selected: the selected object when it is the row's, else null
 *  (the selection did not come through, as when the row went meanwhile). */
export function rowObjectOf(selected: K8sObject | null, selectedRef: ObjectRef | null, row: ObjectRef): K8sObject | null {
  if (selected === null || selectedRef === null) return null
  const same =
    selectedRef.context === row.context && selectedRef.namespace === row.namespace && selectedRef.resource === row.resource && selectedRef.name === row.name
  return same ? selected : null
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
 *  Cluster | Port forwarding | Operation log switch is drawn by the bottom panel, which hands it in as `toolbarStart`. */
export function ClusterView({
  model,
  detail,
  onOpenInEditor,
  onOpenLogs,
  onOpenShell,
  onForward,
  onWrite,
  toolbarStart
}: {
  model: ClusterViewModel
  detail: React.ReactNode
  /** The editor tab; without it the row menu has no such item and a double-click only selects. */
  onOpenInEditor?: (ref: ObjectRef) => void
  /** A Pod's logs tab (spec 4.8), `previous` true for previous logs; without it the row menu has no logs items. */
  onOpenLogs?: (ref: ObjectRef, pod: K8sObject, previous: boolean) => void
  /** A shell in a running Pod's container; without it the row menu has no shell item. */
  onOpenShell?: (ref: ObjectRef, container: string) => void
  /** A port forward for a running Pod, a Service or a Deployment; without it the row menu has no such item. */
  onForward?: (ref: ObjectRef, object: K8sObject) => void
  /** The row menu's edit, delete, restart and scale items act on the right-clicked row's object; without it the menu has none. */
  onWrite?: (ask: WriteAsk) => void
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
  // Logs open on the Pod's default container, and a port forward is judged on the object: only the object says.
  const rowPod = rowMenu !== null ? rowObjectOf(model.selected, model.selectedRef, rowMenu.ref) : null

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
        {/* Select has no title prop; the full context name is what the short label hides. */}
        <span className="kube-sel-tip" title={contextName ?? t('kube.cluster.context')}>
          <Select
            className="dense kube-sel kube-sel-ctx"
            ariaLabel={t('kube.cluster.context')}
            placeholder={t('kube.cluster.context')}
            items={contextOptions.map((n) => ({ value: n, label: displayContextName(n).short }))}
            value={contextName ?? ''}
            onChange={model.setContext}
            noCheck
          />
        </span>

        {model.namespacesForbidden ? (
          <NamespaceField value={view.namespace} onCommit={model.setNamespace} />
        ) : (
          <span className="kube-sel-tip" title={t('kube.cluster.namespace')}>
            <Select
              className="dense kube-sel kube-sel-ns"
              ariaLabel={t('kube.cluster.namespace')}
              items={[
                { value: '', label: t('kube.cluster.allNamespaces') },
                ...nsOptions.map((n) => ({ value: n, label: t('kube.toolbar.ns', { ns: n }) }))
              ]}
              value={view.namespace ?? ''}
              onChange={(v) => model.setNamespace(v === '' ? null : v)}
              noCheck
            />
          </span>
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
              onCopyName: () => void window.api.clipboard.writeText(rowMenu.ref.name),
              onLogs: onOpenLogs && rowPod !== null ? (previous) => onOpenLogs(rowMenu.ref, rowPod, previous) : undefined,
              shell: shellChoice(onOpenShell, rowMenu.ref, rowPod),
              onForward: onForward && rowPod !== null ? () => onForward(rowMenu.ref, rowPod) : undefined,
              object: rowPod,
              ...writeMenuHandlers(onWrite, rowMenu.ref, rowPod)
            },
            t
          )}
          onClose={() => setRowMenu(null)}
        />
      )}
    </div>
  )
}
