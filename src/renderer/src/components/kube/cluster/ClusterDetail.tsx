import { Fragment, useEffect, useId, useState } from 'react'
import { Ellipsis, ExternalLink, RotateCcw, ScrollText, SquareTerminal } from 'lucide-react'
import type { MessageKey } from '../../../../../core/i18n'
import type { K8sObject } from '../../../../../core/kube/objects'
import { podSelectorOf, summaryOf } from '../../../../../core/kube/cluster/summary'
import type { Column, ObjectRef, Row } from '../../../../../core/kube/cluster/types'
import type { DetailTab } from '../../../../../core/kube/cluster/viewState'
import { ageText } from '../../../../../core/kube/cluster/status'
import type { ClusterViewModel } from '../../../hooks/useClusterView'
import { useI18n } from '../../../i18n/I18nProvider'
import { arrowStep } from '../../../lib/arrowStep'
import { ContextMenu } from '../../ContextMenu'
import { clusterMenuItems, shellChoice, shellItems, writeMenuHandlers, type WriteAsk } from './clusterMenu'
import { liveErrorText } from './ClusterView'
import { KubeYamlView } from './KubeYamlView'
import { useSecretReveal } from './useSecretReveal'

const TABS: DetailTab[] = ['summary', 'yaml', 'events', 'describe', 'pods']
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

type ReadOf<T> = ({ ok: true } & T) | { ok: false; message: string } | null

/** A one-shot read: a wait line until it arrives, its first line of stderr when it failed. */
export function ReadView<T>({ read, render }: { read: ReadOf<T>; render(r: { ok: true } & T): React.ReactNode }): React.JSX.Element {
  const { t } = useI18n()
  if (read === null) return <div className="kube-cluster-empty">{t('kube.cluster.loading')}</div>
  if (!read.ok) return <div className="kube-cluster-empty kube-detail-error">{read.message}</div>
  return <>{render(read)}</>
}

export function EventsList({ events }: { events: K8sObject[] }): React.JSX.Element {
  const { t } = useI18n()
  if (events.length === 0) return <div className="kube-cluster-empty">{t('kube.cluster.empty')}</div>
  const now = Date.now()
  return (
    <ul className="kube-detail-events">
      {events.map((e, i) => (
        <li key={i} className={e.type === 'Warning' ? 'warning' : ''}>
          <span className="kube-detail-event-head">
            {str(e.reason)}{' '}
            <span className="kube-detail-event-age">{ageText(str(e.lastTimestamp) || str(e.eventTime) || str(e.metadata.creationTimestamp), now)}</span>
          </span>
          <span className="kube-detail-event-msg">{str(e.message)}</span>
        </li>
      ))}
    </ul>
  )
}

/** The Pods tab's table (spec 4.5): the Pods the object selects, each row selecting its Pod by click, Enter or Space. */
export function PodsTable({ columns, rows, onPick }: { columns: Column[]; rows: Row[]; onPick(row: Row): void }): React.JSX.Element {
  const { t } = useI18n()
  return (
    <table className="kube-detail-pods">
      <thead>
        <tr>
          {columns.map((c, i) => (
            <th key={c.key + i}>{c.i18n ? t(`kube.cluster.col.${c.key}` as MessageKey) : c.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.uid}
            className="kube-detail-pod"
            tabIndex={0}
            onClick={() => onPick(row)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.preventDefault()
              onPick(row)
            }}
          >
            {row.cells.map((c, i) => (
              <td key={i} title={c.text}>
                {c.tone && <span className={`kube-cluster-dot ${c.tone}`} aria-hidden="true" />}
                {c.text}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function SummaryTab({ model, object, kind, context }: { model: ClusterViewModel; object: K8sObject; kind: string; context: string }): React.JSX.Element {
  const { t } = useI18n()
  const events = model.events?.ok === true ? model.events.events : []
  const s = summaryOf(kind, object, events, context, Date.now(), model.owners)
  return (
    <div className="kube-detail-summary">
      {s.warning !== null && (
        <div className="kube-detail-warning">
          <span className="kube-detail-section">{t('kube.cluster.warning')}</span> {s.warning}
        </div>
      )}
      <dl className="kube-detail-facts">
        {s.facts.map((f, i) => (
          <div key={i} className="kube-detail-fact">
            <dt>{t(f.label as MessageKey)}</dt>
            <dd>
              {f.tone && <span className={`kube-cluster-dot ${f.tone}`} aria-hidden="true" />}
              {f.refs
                ? f.refs.map((r, j) => (
                    <Fragment key={j}>
                      {j > 0 && <span aria-hidden="true">{' → '}</span>}
                      <button type="button" className="kube-detail-link" onClick={() => model.selectRef(r)}>
                        {`${r.kind} ${r.name}`}
                      </button>
                    </Fragment>
                  ))
                : f.ago !== undefined
                  ? t('kube.cluster.restartsAgo', { count: f.value, ago: f.ago })
                  : f.value}
            </dd>
          </div>
        ))}
      </dl>
      {s.containers.length > 0 && (
        <>
          <div className="kube-detail-section">{t('kube.cluster.containers')}</div>
          <ul className="kube-detail-containers">
            {s.containers.map((c, i) => (
              <li key={i}>
                <span className={`kube-cluster-dot ${c.tone}`} aria-hidden="true" />
                <span className="kube-detail-container-name">{c.name}</span>
                <span className="kube-detail-container-state">{c.state}</span>
                <span className="kube-detail-container-image" title={c.image}>
                  {c.image}
                </span>
                {(c.requests || c.limits) && (
                  <span className="kube-detail-container-res">
                    {[c.requests && `${t('kube.cluster.requests')} ${c.requests}`, c.limits && `${t('kube.cluster.limits')} ${c.limits}`].filter(Boolean).join('; ')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {s.conditions.length > 0 && (
        <>
          <div className="kube-detail-section">{t('kube.cluster.conditions')}</div>
          <ul className="kube-detail-conditions">
            {s.conditions.map((c, i) => (
              <li key={i}>
                {c.type} {c.status}
                {c.reason ? ` (${c.reason})` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

/** The detail column of the cluster view (spec 4.5): header, then the tab the person picked. */
export function ClusterDetail({
  model,
  onOpenInEditor,
  onOpenLogs,
  onOpenShell,
  onWrite,
  onMenu
}: {
  model: ClusterViewModel
  /** Opens the object in its read-only editor tab (spec 4.6); without it the header button and the menu item are not
   *  drawn. */
  onOpenInEditor?: (ref: ObjectRef) => void
  /** Opens a Pod's logs tab (spec 4.8), `previous` true for previous logs; without it, or for another kind, the header
   *  button and the menu items are not drawn. */
  onOpenLogs?: (ref: ObjectRef, pod: K8sObject, previous: boolean) => void
  /** Opens a shell in a running Pod's container; without it, or when the Pod has none running, the header button and the
   *  menu item are not drawn. */
  onOpenShell?: (ref: ObjectRef, container: string) => void
  /** The menu's edit, delete, restart and scale items; without it the menu has none. */
  onWrite?: (ask: WriteAsk) => void
  /** Where the more button opens the menu; without it the detail opens the menu itself. */
  onMenu?: (x: number, y: number) => void
}): React.JSX.Element | null {
  const { t } = useI18n()
  const { selected, selectedRef, view } = model
  const uid = view.selected
  // Tied to the selection: another selection masks the values again.
  const reveal = useSecretReveal(selectedRef, uid, str(selected?.metadata.resourceVersion))
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [shellMenu, setShellMenu] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    setMenu(null)
    setShellMenu(null)
  }, [uid])
  const ids = useId()
  const tabId = (id: DetailTab): string => `${ids}-tab-${id}`
  const panelId = `${ids}-panel`

  if (selected === null || selectedRef === null || model.kind === null || uid === null) return null
  const kind = model.kind.kind
  const tabs = TABS.filter((id) => id !== 'pods' || podSelectorOf(kind, selected) !== null)
  const tab = tabs.includes(view.detailTab) ? view.detailTab : 'summary'

  const shell = kind === 'Pod' ? shellChoice(onOpenShell, selectedRef, selected) : undefined
  const menuItems = clusterMenuItems(
    {
      kind,
      onOpenInEditor: onOpenInEditor ? () => onOpenInEditor(selectedRef) : undefined,
      onDescribe: () => model.setDetailTab('describe'),
      onCopyName: () => void window.api.clipboard.writeText(selectedRef.name),
      onLogs: onOpenLogs ? (previous) => onOpenLogs(selectedRef, selected, previous) : undefined,
      shell,
      ...writeMenuHandlers(onWrite, selectedRef, selected)
    },
    t
  )

  return (
    <aside className={'kube-detail' + (model.deleted ? ' deleted' : '')}>
      <div className="kube-detail-head">
        <span className="kube-detail-kind">{kind}</span>
        <span className="kube-detail-name" title={selectedRef.name}>
          {selectedRef.name}
        </span>
        {onOpenInEditor && (
          <button
            type="button"
            className="kube-btn"
            title={t('kube.cluster.openInEditor')}
            aria-label={t('kube.cluster.openInEditor')}
            onClick={() => onOpenInEditor(selectedRef)}
          >
            <ExternalLink size={14} />
          </button>
        )}
        {onOpenLogs && kind === 'Pod' && (
          <button
            type="button"
            className="kube-btn"
            title={t('kube.logs.open')}
            aria-label={t('kube.logs.open')}
            onClick={() => onOpenLogs(selectedRef, selected, false)}
          >
            <ScrollText size={14} />
          </button>
        )}
        {shell && (
          <button
            type="button"
            className="kube-btn"
            title={t('kube.shell.open')}
            aria-label={t('kube.shell.open')}
            onClick={(e) => {
              if (shell.containers.length === 1) {
                shell.open(shell.containers[0].name)
                return
              }
              const r = e.currentTarget.getBoundingClientRect()
              setShellMenu({ x: r.left, y: r.bottom })
            }}
          >
            <SquareTerminal size={14} />
          </button>
        )}
        <button
          type="button"
          className="kube-btn"
          title={t('kube.cluster.more')}
          aria-label={t('kube.cluster.more')}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            if (onMenu) onMenu(r.left, r.bottom)
            else setMenu({ x: r.left, y: r.bottom })
          }}
        >
          <Ellipsis size={14} />
        </button>
      </div>
      {shell && shellMenu !== null && (
        <ContextMenu
          x={shellMenu.x}
          y={shellMenu.y}
          items={[{ heading: t('kube.shell.container') }, ...shellItems(shell, t)]}
          onClose={() => setShellMenu(null)}
        />
      )}
      {menu !== null && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
      {model.deleted && <div className="kube-detail-deleted">{t('kube.cluster.deleted')}</div>}
      {model.detailError !== null && (
        <div className="kube-detail-watch-error" role="status">
          <span className="kube-detail-watch-error-text" title={model.detailError}>
            {liveErrorText(model.detailError, t)}
          </span>
          <button type="button" className="kube-btn" title={t('kube.cluster.retry')} aria-label={t('kube.cluster.retry')} onClick={model.retry}>
            <RotateCcw size={13} />
          </button>
        </div>
      )}
      <div className="kube-detail-tabs" role="tablist">
        {tabs.map((id) => (
          <button
            key={id}
            id={tabId(id)}
            type="button"
            role="tab"
            aria-selected={id === tab}
            aria-controls={panelId}
            // One tab stop, the shown tab; the arrows move between them (ARIA's tabs pattern).
            tabIndex={id === tab ? 0 : -1}
            className={'kube-detail-tab' + (id === tab ? ' active' : '')}
            onClick={() => model.setDetailTab(id)}
            onKeyDown={(e) => {
              const to = arrowStep(tabs, tab, e.key)
              if (to === null) return
              e.preventDefault()
              model.setDetailTab(to)
              document.getElementById(tabId(to))?.focus()
            }}
          >
            {t(`kube.cluster.tab.${id}` as MessageKey)}
            {id === 'events' && model.events?.ok === true && <span className="kube-detail-count">{model.events.events.length}</span>}
          </button>
        ))}
      </div>
      <div className="kube-detail-body" role="tabpanel" id={panelId} aria-labelledby={tabId(tab)}>
        {tab === 'summary' && <SummaryTab model={model} object={selected} kind={kind} context={selectedRef.context} />}
        {tab === 'yaml' && <KubeYamlView object={selected} kind={kind} reveal={reveal} />}
        {tab === 'events' && <ReadView read={model.events} render={(r) => <EventsList events={r.events} />} />}
        {tab === 'describe' && <ReadView read={model.describe} render={(r) => <pre className="kube-detail-describe">{r.text}</pre>} />}
        {tab === 'pods' && (
          <ReadView
            read={model.pods}
            render={(r) => (
              <PodsTable
                columns={r.columns}
                rows={r.rows}
                onPick={(row) =>
                  model.selectRef({ context: selectedRef.context, namespace: row.namespace ?? selectedRef.namespace, resource: 'pods', kind: 'Pod', name: row.name })
                }
              />
            )}
          />
        )}
      </div>
    </aside>
  )
}
