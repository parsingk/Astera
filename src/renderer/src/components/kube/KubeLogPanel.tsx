import { useState } from 'react'
import { ChevronDown, ChevronRight, Copy, Eraser, RotateCw, Square } from 'lucide-react'
import type { KubePreview, KubeRunResult, ResourceOutcome } from '../../../../core/kube/types'
import { useI18n } from '../../i18n/I18nProvider'
import type { KubeLogEntry } from '../../hooks/useKubeOps'
import { defaultExpandedId, clockText, kubeBadge, kubeCommandText, kubeRerunnable } from './kubeLogView'

const platform = (): string => (typeof window === 'undefined' ? 'linux' : window.api.platform)

type T = ReturnType<typeof useI18n>['t']

const BADGE_KEY = {
  running: 'kube.log.running',
  done: 'kube.log.done',
  cancelled: 'kube.log.cancelled',
  timedOut: 'kube.log.timedOut',
  refused: 'kube.log.refused'
} as const

/** Why a refused run wrote nothing, in words. */
function refusalText(refused: NonNullable<KubeRunResult['refused']>, t: T): string {
  switch (refused.reason) {
    case 'changed':
      return t('kube.log.refusedChanged')
    case 'mixed-contexts':
      return t('kube.confirm.mixedContexts')
    case 'namespace':
      return t('kube.confirm.namespaceMismatch')
    case 'mixed-namespaces':
      return `${t('kube.confirm.mixedNamespaces', { ns: refused.namespace })}: ${refused.folders.map((f) => `${f.folder} (${f.namespace})`).join(', ')}`
    case 'refused': {
      const plan = (refused as Extract<KubePreview, { reason: 'refused' }>).plan
      const text = t(`kube.confirm.refused.${plan.ok ? 'nothing' : plan.reason}` as 'kube.confirm.refused.nothing')
      if (plan.ok || plan.reason !== 'nothing' || plan.leftOut.length === 0) return text
      const why = (r: string): string => t(`kube.confirm.leftOutReason.${r}` as 'kube.confirm.leftOutReason.helm')
      return `${text}: ${plan.leftOut.map((l) => `${l.path} (${why(l.reason)})`).join(', ')}`
    }
    case 'kubectl':
      return refused.stderr
  }
}

function OutcomeLine({ o, onOpenFile }: { o: ResourceOutcome; onOpenFile: (path: string) => void }): React.JSX.Element {
  if (o.outcome === 'warning') return <div className="kube-log-line warning">⚠ {o.message}</div>
  if (o.outcome === 'error') {
    return (
      <div className="kube-log-line error">
        ✗{' '}
        {o.file && (
          <button type="button" className="kube-log-file" onClick={() => onOpenFile(o.file as string)}>
            {o.file}
          </button>
        )}{' '}
        {o.message}
      </div>
    )
  }
  return (
    <div className="kube-log-line ok">
      ✓ {o.ref} {o.outcome}
    </div>
  )
}

function EntryBody({ e, onOpenFile }: { e: KubeLogEntry; onOpenFile: (path: string) => void }): React.JSX.Element {
  const { t } = useI18n()
  const r = e.result
  const explained = !!r && r.outcomes.some((o) => o.outcome === 'error')
  return (
    <div className="kube-log-body">
      {e.verb === 'compare' && e.commandLines.length > 0 && (
        <div className="kube-log-line">{t('kube.confirm.commandsToCompare')}</div>
      )}
      {e.commandLines.map((args, i) => (
        <div key={i} className="kube-log-line cmd">
          $ {kubeCommandText(args, platform())}
        </div>
      ))}
      {e.compare && (
        <div className="kube-log-line">{t('kube.log.compareSummary', { ...e.compare })}</div>
      )}
      {r?.outcomes.map((o, i) => <OutcomeLine key={i} o={o} onOpenFile={onOpenFile} />)}
      {r && !r.ok && !r.refused && !explained && r.stderr && <div className="kube-log-line error">{r.stderr}</div>}
      {r?.refused && <div className="kube-log-line error">{refusalText(r.refused, t)}</div>}
    </div>
  )
}

/** The session's Kubernetes operations, newest first (board 5): a header row per entry, the newest finished one open,
 *  and a rail acting on the selected entry. */
export function KubeLogPanel({
  log,
  onRerun,
  onCancel,
  onCopy,
  onClear,
  onOpenFile
}: {
  log: KubeLogEntry[]
  onRerun: (id: string) => void
  onCancel: (id: string) => void
  onCopy: (id: string) => void
  onClear: () => void
  onOpenFile: (path: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  // What the person toggled; an entry not in here follows the default (the newest finished one open).
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  const [picked, setPicked] = useState<string | null>(null)
  const defaultOpen = defaultExpandedId(log)
  const selected = log.find((e) => e.id === picked) ?? log[0]
  const isOpen = (id: string): boolean => toggled[id] ?? id === defaultOpen
  const running = selected?.state === 'running'
  const rail = (key: string, icon: React.ReactNode, onClick: () => void, disabled: boolean): React.JSX.Element => (
    <button type="button" className="run-rail-btn" title={t(key as 'kube.log.rerun')} aria-label={t(key as 'kube.log.rerun')} disabled={disabled} onClick={onClick}>
      {icon}
    </button>
  )
  return (
    <div className="kube-log">
      <div className="run-rail" role="toolbar" aria-orientation="vertical" aria-label={t('kube.log.rail')}>
        {rail('kube.log.rerun', <RotateCw size={14} />, () => selected && onRerun(selected.id), !selected || running || !kubeRerunnable(selected))}
        {running && rail('kube.log.cancel', <Square size={12} fill="currentColor" strokeWidth={0} />, () => onCancel(selected.id), false)}
        {rail('kube.log.copy', <Copy size={14} />, () => selected && onCopy(selected.id), !selected || selected.commandLines.length === 0)}
        <span className="run-rail-sep" />
        {rail('kube.log.clear', <Eraser size={14} />, onClear, log.length === 0)}
      </div>
      <div className="kube-log-list">
        {log.length === 0 && <div className="kube-log-empty">{t('kube.cluster.noOperations')}</div>}
        {log.map((e) => {
          const badge = kubeBadge(e)
          const open = isOpen(e.id)
          return (
            <div key={e.id} className={`kube-log-entry${e.id === selected?.id ? ' selected' : ''}`}>
              <div
                className="kube-log-head"
                role="button"
                tabIndex={0}
                aria-expanded={open}
                onClick={() => {
                  setPicked(e.id)
                  setToggled((p) => ({ ...p, [e.id]: !open }))
                }}
                onKeyDown={(ev) => {
                  if (ev.key !== 'Enter' && ev.key !== ' ') return
                  ev.preventDefault()
                  setPicked(e.id)
                  setToggled((p) => ({ ...p, [e.id]: !open }))
                }}
              >
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span className={`kube-log-badge ${badge.kind}`}>
                  {badge.kind === 'running' && <span className="loading-spinner small" />}
                  {badge.kind === 'failed' ? t('kube.log.failed', { count: badge.count }) : t(BADGE_KEY[badge.kind])}
                </span>
                <span className="kube-log-time">{clockText(e.startedAt)}</span>
                <span className="kube-log-verb">{t(`kube.log.verb.${e.verb}` as 'kube.log.verb.apply')}</span>
                <span className="kube-log-context">{e.context}</span>
                <span className="kube-log-scope">{e.scope}</span>
              </div>
              {open && <EntryBody e={e} onOpenFile={onOpenFile} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}
