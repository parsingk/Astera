import { useEffect } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import type { DependentGroup, Dependents, LiveOp, LivePreview, Read } from '../../../../core/kube/cluster/types'
import { liveRef, needsTypedName } from '../../../../core/kube/cluster/write'
import { useI18n } from '../../i18n/I18nProvider'
import { backdropProps } from '../../lib/backdrop'
import { FileIcon } from '../FileIcon'
import { KubeCommands } from './KubeCommands'
import { SideBySideDiff } from './SideBySideDiff'

type DependentsRead = Read<{ dependents: Dependents }> | null

/** Whether the one button may run the write: a good preview that is not stale, nothing running, for a delete the
 *  dependents answered (a failed read still lets the person decide), and for a Namespace or CRD its typed name. */
export const writeConfirmable = (p: {
  op: LiveOp
  preview: LivePreview | null
  dependents: DependentsRead
  typed: string
  stale: boolean
  running: boolean
}): boolean =>
  p.preview?.ok === true &&
  !p.stale &&
  !p.running &&
  (p.op.verb !== 'delete' || p.dependents !== null) &&
  (p.op.verb !== 'delete' || !needsTypedName(p.op.ref.kind) || p.typed === p.op.ref.name)

function Group({ g }: { g: DependentGroup }): React.JSX.Element {
  return (
    <li>
      <span className="mono">{g.kind}</span> {g.count}
      {g.names.length > 0 && (
        <span className="kube-leftout-reason mono">
          {' '}
          {g.names.join(', ')}
          {g.count > g.names.length ? ', …' : ''}
        </span>
      )}
    </li>
  )
}

/** The confirmation of one live write (cluster view, board D): what changes, the exact commands, one button. Like the
 *  file confirmation it stays up with a stop button while `running`, and Escape and the backdrop do nothing then.
 *  State and IPC live with the caller. */
export function KubeWriteDialog({
  op,
  preview,
  dependents,
  keepServerFields,
  onToggleServerFields,
  showValues,
  onToggleValues,
  replicas,
  onReplicas,
  typed,
  onTyped,
  stale,
  running,
  cancelling,
  onConfirm,
  onCancel,
  onAbort
}: {
  op: LiveOp
  /** null while loading. */
  preview: LivePreview | null
  /** Delete only; null while loading. */
  dependents: DependentsRead
  keepServerFields: boolean
  onToggleServerFields: () => void
  /** The control shows for a Secret replace only. */
  showValues: boolean
  onToggleValues: () => void
  /** Scale only: the field's text. */
  replicas: string
  onReplicas: (text: string) => void
  /** Namespace and CRD delete only. */
  typed: string
  onTyped: (text: string) => void
  stale: boolean
  running: boolean
  /** Stop was pressed and the run has not answered yet. */
  cancelling: boolean
  onConfirm: () => void
  onCancel: () => void
  onAbort: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const { ref, verb } = op

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || running) return
      const el = document.activeElement
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return
      onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, running])

  const canConfirm = writeConfirmable({ op, preview, dependents, typed, stale, running })
  const commandLines = preview && (preview.ok || preview.reason === 'kubectl') ? preview.commandLines : []
  const typedNeeded = verb === 'delete' && needsTypedName(ref.kind)
  const secretReplace = verb === 'replace' && ref.kind === 'Secret'

  const refusal = (): React.JSX.Element | null => {
    if (!preview || preview.ok) return null
    switch (preview.reason) {
      case 'gone':
        return <div className="kube-fail"><p>{t('kube.write.gone')}</p></div>
      case 'paused':
        return <div className="kube-fail"><p>{t('kube.write.paused')}</p></div>
      case 'kind':
        return <div className="kube-fail"><p>{t('kube.write.kind', { kind: ref.kind })}</p></div>
      case 'edit': {
        const key = {
          yaml: 'kube.write.edit.yaml',
          'not-one': 'kube.write.edit.notOne',
          identity: 'kube.write.edit.identity',
          base64: 'kube.write.edit.base64'
        }[preview.problem] as 'kube.write.edit.yaml'
        return <div className="kube-fail"><p>{t(key, { detail: preview.detail })}</p></div>
      }
      case 'kubectl':
        return (
          <div className="kube-fail">
            {preview.timedOut && <p>{t('kube.confirm.timedOut')}</p>}
            <pre className="confirm-code">{preview.stderr}</pre>
          </div>
        )
    }
  }

  const dependentsBlock = (): React.JSX.Element | null => {
    if (verb !== 'delete') return null
    if (dependents === null) {
      return (
        <div className="kube-loading">
          <span className="loading-spinner" aria-hidden="true" />
          {t('kube.write.loading')}
        </div>
      )
    }
    if (!dependents.ok) return <div className="kube-fail"><p>{t('kube.write.dependentsFailed', { detail: dependents.message })}</p></div>
    const d = dependents.dependents
    const affectedKey = ref.kind === 'PersistentVolume' ? 'kube.write.boundClaim' : 'kube.write.nodePods'
    const sections: [string, DependentGroup[]][] = [
      ['kube.write.goes', d.goes],
      ['kube.write.kept', d.kept],
      [affectedKey, d.affected]
    ]
    const empty = sections.every(([, g]) => g.length === 0)
    return (
      <div className="kube-dependents">
        {sections.map(
          ([key, groups]) =>
            groups.length > 0 && (
              <div key={key}>
                <div className="kube-list-title">{t(key as 'kube.write.goes')}</div>
                <ul>
                  {groups.map((g) => (
                    <Group key={g.kind} g={g} />
                  ))}
                </ul>
              </div>
            )
        )}
        {d.incomplete && <p className="kube-dependents-note">{t('kube.write.incomplete')}</p>}
        {d.recreatedBy !== null && (
          <p className="kube-dependents-note">{t('kube.write.recreatedBy', d.recreatedBy)}</p>
        )}
        {empty && <p className="kube-dependents-note">{t('kube.write.nothingElse')}</p>}
      </div>
    )
  }

  const button = (): React.JSX.Element => {
    const label =
      verb === 'delete'
        ? t('kube.confirm.delete', { context: ref.context })
        : verb === 'replace'
          ? t('kube.confirm.apply', { context: ref.context })
          : t(verb === 'restart' ? 'kube.write.restartIn' : 'kube.write.scaleIn', { context: ref.context })
    return (
      <button
        type="button"
        className={verb === 'delete' ? 'primary danger' : 'primary'}
        disabled={!canConfirm}
        onClick={onConfirm}
      >
        {running && <span className="loading-spinner" aria-hidden="true" />}
        {label}
      </button>
    )
  }

  return (
    <div className="modal-backdrop" {...backdropProps(running ? () => {} : onCancel)}>
      <div className="modal kube-confirm" onClick={(e) => e.stopPropagation()}>
        <h2>{t(`kube.write.title.${verb}` as 'kube.write.title.replace')}</h2>
        <div className="kube-pills">
          <span className="kube-pill">
            <FileIcon id="kubernetes" tone="blue" />
            <span className="mono">{ref.context}</span>
          </span>
          {ref.namespace !== null && (
            <span className="kube-pill mono">{t('kube.confirm.namespace', { ns: ref.namespace })}</span>
          )}
          <span className="kube-pill mono">{liveRef(ref)}</span>
        </div>

        {preview?.ok && preview.changedSinceEdit && (
          <div className="kube-banner" role="alert">
            {t('kube.write.changedSinceEdit')}
          </div>
        )}
        {preview === null && (
          <div className="kube-loading">
            <span className="loading-spinner" aria-hidden="true" />
            {t('kube.write.loading')}
          </div>
        )}
        {refusal()}
        {dependentsBlock()}

        {verb === 'scale' && (
          <label className="kube-field">
            <span>{t('kube.write.replicas')}</span>
            <input
              type="number"
              min={0}
              step={1}
              value={replicas}
              disabled={running}
              onChange={(e) => onReplicas(e.target.value)}
            />
          </label>
        )}

        {preview?.ok && (
          <div className="kube-diff-pane">
            <div className="kube-diff-title">
              <span className="mono">{preview.diff.ref}</span>
              {secretReplace && (
                <button
                  type="button"
                  className="kube-btn"
                  title={t(showValues ? 'kube.cluster.hideValues' : 'kube.cluster.showValues')}
                  aria-label={t(showValues ? 'kube.cluster.hideValues' : 'kube.cluster.showValues')}
                  onClick={onToggleValues}
                >
                  {showValues ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                </button>
              )}
              <label className="check-small">
                <input type="checkbox" checked={keepServerFields} onChange={onToggleServerFields} />
                <span>{t('kube.confirm.serverFields')}</span>
              </label>
            </div>
            <SideBySideDiff
              rows={preview.diff.rows}
              afterLabel={t(verb === 'delete' ? 'kube.confirm.columnAfterDelete' : 'kube.confirm.columnAfter')}
            />
          </div>
        )}

        <KubeCommands lines={commandLines} title="kube.confirm.commandsToRun" />

        {typedNeeded && (
          <label className="kube-field kube-typed">
            <span>{t('kube.write.typeName', { name: ref.name })}</span>
            <input
              type="text"
              className="mono"
              value={typed}
              disabled={running}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => onTyped(e.target.value)}
            />
          </label>
        )}

        <div className="row right">
          {running ? (
            <button type="button" disabled={cancelling} onClick={onAbort}>
              {t('kube.confirm.abort')}
            </button>
          ) : (
            <button type="button" onClick={onCancel}>
              {t('common.cancel')}
            </button>
          )}
          {button()}
        </div>
      </div>
    </div>
  )
}
