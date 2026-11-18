import type { ReactNode } from 'react'
import { CloudUpload, Eye, GitCompare, Lock, RefreshCw, Trash2 } from 'lucide-react'
import { displayContextName } from '../../../../core/kube/contextName'
import type { KubeFileKind, KubeStatus, TargetState } from '../../../../core/kube/types'
import { useI18n } from '../../i18n/I18nProvider'
import { shellQuote } from '../../lib/shellQuote'
import { FileIcon } from '../FileIcon'
import { fileNamespacePill } from './fileNamespacePill'

export interface KubeToolbarProps {
  kind: KubeFileKind
  target: TargetState
  /** The overlays that reach this file; any here (or a `kustomization` kind) makes the strip a Kustomize one. */
  overlays: string[]
  overlay: string | null
  /** The namespace pill's value: the namespace applied for resources that name none. */
  pill: string | null
  /** The overlay's own `namespace:`, which the pill cannot override. */
  nsLocked: string | null
  /** Every resource names its namespace, so no `-n` is sent. */
  nsFromFile: boolean
  fileNamespaces: string[]
  status: KubeStatus | null
  statusLoading: boolean
  /** "Kind · name" of the file's one resource, or null. */
  resourceLabel: string | null
  /** An operation is running. */
  busy: boolean
  kubectlMissing: boolean
  /** Why reload cannot run on this file: a Secret or a file of several resources. */
  reloadBlocked: 'secret' | 'multi' | null
  /** The folder of a kustomization over this file that does not parse: every action waits until it is fixed. */
  brokenKustomization: string | null
  /** No kustomization beside or above this file lists it, so it is never applied: every action is off. */
  unlisted: boolean
  renderOpen: boolean
  /** Open the cluster picker / the namespace picker; the caller places them (pass them as children). */
  onPickContext(): void
  onPickNamespace(): void
  onPickOverlay(overlayDir: string): void
  onCompare(): void
  onApply(): void
  onReload(): void
  onDelete(): void
  onToggleRender(): void
  onOpenSettings(): void
  /** Popovers anchored to the strip. */
  children?: ReactNode
}

const platform = (): string => (typeof window === 'undefined' ? 'linux' : window.api.platform)

/** The last two segments of a path: enough to tell overlays apart (`envs/dev`). */
function tail(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).slice(-2).join('/')
}

/** The strip above a Kubernetes file in the editor (spec 4.5): where it goes, what it does, how it compares.
 *  Every action is an icon with a tooltip; state and IPC live with the caller. */
export function KubeToolbar(p: KubeToolbarProps): React.JSX.Element {
  const { t } = useI18n()

  if (p.kind === 'helm-template') {
    return (
      <div className="kube-strip">
        <div className="kube-bar">
          <span className="kube-notice">{t('kube.toolbar.helm')}</span>
        </div>
      </div>
    )
  }
  if (p.kubectlMissing) {
    return (
      <div className="kube-strip">
        <div className="kube-bar">
          <span className="kube-notice">{t('kube.toolbar.kubectlMissing')}</span>
          <button type="button" className="kube-link" onClick={p.onOpenSettings}>
            {t('kube.toolbar.openSettings')}
          </button>
        </div>
      </div>
    )
  }

  const isKustomize = p.kind === 'kustomization' || p.overlays.length > 0
  const off =
    p.busy ||
    p.target.state === 'missing' ||
    p.target.state === 'none' ||
    (isKustomize && p.overlay === null) ||
    p.brokenKustomization !== null ||
    p.unlisted

  const contextName = p.target.state === 'none' ? null : p.target.context
  const short = contextName === null ? '' : displayContextName(contextName).short
  const contextLabel =
    p.target.state === 'none'
      ? t('kube.toolbar.chooseCluster')
      : p.target.state === 'missing'
        ? t('kube.toolbar.missing', { name: short })
        : p.target.state === 'current'
          ? t('kube.toolbar.currentFallback', { name: short })
          : short
  const contextClass =
    'kube-pill kube-pill-ctx' +
    (p.target.state === 'current' ? ' kube-pill-warn' : '') +
    (p.target.state === 'missing' ? ' kube-pill-bad' : '')

  const fromFile = p.nsFromFile ? fileNamespacePill(p.fileNamespaces, t) : null
  const nsText = p.nsFromFile
    ? (fromFile?.text ?? null)
    : p.nsLocked !== null
      ? t('kube.toolbar.ns', { ns: p.nsLocked })
      : p.pill !== null
        ? t('kube.toolbar.ns', { ns: p.pill })
        : null

  const reloadTitle =
    p.reloadBlocked === 'secret'
      ? t('kube.toolbar.reloadSecret')
      : p.reloadBlocked === 'multi'
        ? t('kube.toolbar.reloadMulti')
        : t('kube.toolbar.reload')

  const action = (label: string, icon: ReactNode, onClick: () => void, disabled: boolean, extra = ''): ReactNode => (
    <button
      type="button"
      className={`kube-btn${extra}`}
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
    </button>
  )

  return (
    <div className="kube-strip">
      <div className="kube-bar">
        <div className="kube-actions">
          {action(t('kube.toolbar.compare'), <GitCompare size={15} />, p.onCompare, off)}
          {action(t('kube.toolbar.apply'), <CloudUpload size={15} />, p.onApply, off, ' kube-primary')}
          {!isKustomize &&
            action(reloadTitle, <RefreshCw size={15} />, p.onReload, off || p.reloadBlocked !== null)}
          {action(t('kube.toolbar.delete'), <Trash2 size={15} />, p.onDelete, off)}
          {isKustomize && (
            <button
              type="button"
              className={`kube-btn${p.renderOpen ? ' on' : ''}`}
              title={t('kube.toolbar.renderedView')}
              aria-label={t('kube.toolbar.renderedView')}
              aria-pressed={p.renderOpen}
              onClick={p.onToggleRender}
            >
              <Eye size={15} />
            </button>
          )}
        </div>

        {isKustomize &&
          (p.overlays.length > 1 ? (
            <select
              className="kube-pill kube-pill-overlay"
              title={t('kube.toolbar.overlayTitle')}
              aria-label={t('kube.toolbar.overlayTitle')}
              value={p.overlay ?? ''}
              onChange={(e) => p.onPickOverlay(e.target.value)}
            >
              {p.overlay === null && (
                <option value="" disabled>
                  {t('kube.toolbar.chooseOverlay')}
                </option>
              )}
              {p.overlays.map((o) => (
                <option key={o} value={o}>
                  {tail(o)}
                </option>
              ))}
            </select>
          ) : (
            <span className="kube-pill kube-pill-overlay" title={p.overlay ?? undefined}>
              <FileIcon id="layers" tone="blue" />
              <span className="kube-pill-text">{p.overlay === null ? t('kube.toolbar.chooseOverlay') : tail(p.overlay)}</span>
            </span>
          ))}

        <button
          type="button"
          className={contextClass}
          title={contextName ?? t('kube.toolbar.contextTitle')}
          onClick={p.onPickContext}
        >
          <FileIcon id="kubernetes" tone="blue" />
          <span className="kube-pill-text">{contextLabel}</span>
        </button>

        {nsText !== null &&
          (p.nsLocked !== null ? (
            <span className="kube-pill kube-pill-locked" title={t('kube.toolbar.nsLocked')}>
              <Lock size={11} aria-hidden="true" />
              <span className="kube-pill-text">{nsText}</span>
            </span>
          ) : p.nsFromFile ? (
            <span className="kube-pill kube-pill-locked" title={fromFile?.title}>
              <Lock size={11} aria-hidden="true" />
              <span className="kube-pill-text">{nsText}</span>
            </span>
          ) : (
            <button type="button" className="kube-pill kube-pill-ns" title={t('kube.toolbar.nsTitle')} onClick={p.onPickNamespace}>
              <span className="kube-pill-text">{nsText}</span>
            </button>
          ))}

        <div className="kube-chips">
          <StatusChip status={p.status} loading={p.statusLoading} onCompare={p.onCompare} disabled={off} />
          {p.resourceLabel !== null && <span className="kube-chip kube-chip-kind">{p.resourceLabel}</span>}
        </div>
      </div>

      {isKustomize && (
        <div className="kube-info">
          <span>{t('kube.toolbar.kustomizeNote')}</span>
          {p.overlay !== null && <code>{`kubectl apply -k ${shellQuote(p.overlay, platform())}`}</code>}
        </div>
      )}
      {p.brokenKustomization !== null && (
        <div className="kube-info">
          <span>{t('kube.toolbar.brokenKustomization')}</span>
          <code>{p.brokenKustomization}</code>
        </div>
      )}
      {p.unlisted && (
        <div className="kube-info">
          <span>{t('kube.toolbar.unlisted')}</span>
        </div>
      )}
      {p.children}
    </div>
  )
}

/** The same/different chip (spec 4.9). "different" and "not in cluster" open the comparison when clicked; `disabled`
 *  follows the compare action. */
export function StatusChip({
  status,
  loading,
  onCompare,
  disabled
}: {
  status: KubeStatus | null
  loading: boolean
  onCompare: () => void
  disabled: boolean
}): React.JSX.Element | null {
  const { t } = useI18n()
  if (loading) {
    return (
      <span className="kube-chip">
        <span className="loading-spinner" aria-hidden="true" />
        {t('kube.chip.loading')}
      </span>
    )
  }
  if (!status) return null
  const text =
    status.kind === 'same'
      ? t('kube.chip.same')
      : status.kind === 'different'
        ? status.resources !== undefined
          ? t('kube.chip.differentResources', { resources: status.resources })
          : t('kube.chip.differentLines', { lines: status.lines ?? 0 })
        : status.kind === 'absent'
          ? t('kube.chip.absent')
          : t('kube.chip.unknown')
  if (status.kind === 'different' || status.kind === 'absent') {
    const label = t('kube.chip.openCompare', { status: text })
    return (
      <button
        type="button"
        className="kube-chip kube-chip-btn"
        title={label}
        aria-label={label}
        disabled={disabled}
        onClick={onCompare}
      >
        <span className={`kube-dot ${status.kind}`} aria-hidden="true" />
        {text}
      </button>
    )
  }
  return (
    <span className="kube-chip" title={status.kind === 'unknown' ? status.reason : undefined}>
      <span className={`kube-dot ${status.kind}`} aria-hidden="true" />
      {text}
    </span>
  )
}
