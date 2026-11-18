import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import type { KubePreview, KubeVerb, ResourceDiff, ResourceState } from '../../../../core/kube/types'
import { useI18n } from '../../i18n/I18nProvider'
import { backdropProps } from '../../lib/backdrop'
import { FileIcon } from '../FileIcon'
import { SideBySideDiff } from './SideBySideDiff'

const MARK: Record<ResourceState, string> = {
  changed: '~',
  unchanged: '=',
  new: '+',
  delete: '−',
  'not-found': '−'
}

const STATE_KEY = {
  changed: 'kube.confirm.state.changed',
  unchanged: 'kube.confirm.state.unchanged',
  new: 'kube.confirm.state.new',
  delete: 'kube.confirm.state.delete',
  'not-found': 'kube.confirm.state.notFound'
} as const

const quote = (arg: string): string => (/[\s"']/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)
const commandText = (args: string[]): string => `kubectl ${args.map(quote).join(' ')}`

/** The confirmation that starts every cluster write (spec 4.6): what changes, the exact commands, one button.
 *  `compare` is the same view read-only. State and IPC live with the caller. */
export function KubeConfirmDialog({
  verb,
  context,
  namespaceLabel,
  preview,
  keepServerFields,
  onToggleServerFields,
  onConfirm,
  onCancel,
  stale
}: {
  verb: 'compare' | KubeVerb
  context: string
  namespaceLabel: string
  preview: KubePreview | null
  keepServerFields: boolean
  onToggleServerFields: () => void
  onConfirm: () => void
  onCancel: () => void
  stale: boolean
}): React.JSX.Element {
  const { t } = useI18n()
  const entries = preview?.ok ? preview.resources : []
  const firstActive = entries.findIndex((e) => ['changed', 'new', 'delete'].includes(e.diff.state))
  const [picked, setPicked] = useState<number | null>(null)
  const selectedIdx = Math.min(picked ?? Math.max(firstActive, 0), Math.max(entries.length - 1, 0))
  const selected: ResourceDiff | undefined = entries[selectedIdx]?.diff
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const el = document.activeElement
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return
      onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const commandLines = preview && (preview.ok || preview.reason === 'kubectl') ? preview.commandLines : []
  const copyAll = (): void => {
    window.api.clipboard.writeText(commandLines.map(commandText).join('\n'))
    setCopied(true)
  }

  const files = preview?.ok
    ? preview.plan.commands.reduce((n, c) => n + (c.kind === 'files' ? c.files.length : 1), 0)
    : 0
  const canConfirm = preview?.ok === true && !stale && verb !== 'compare'
  const afterLabel = verb === 'delete' ? t('kube.confirm.columnAfterDelete') : t('kube.confirm.columnAfter')

  const failure = (): React.JSX.Element | null => {
    if (!preview || preview.ok) return null
    switch (preview.reason) {
      case 'mixed-contexts':
        return (
          <div className="kube-fail">
            <p>{t('kube.confirm.mixedContexts')}</p>
            <ul>
              {preview.folders.map((f) => (
                <li key={f} className="mono">
                  {f}
                </li>
              ))}
            </ul>
          </div>
        )
      case 'namespace':
        return (
          <div className="kube-fail">
            <p>{t('kube.confirm.namespaceMismatch')}</p>
            <ul>
              {preview.conflicts.map((c) => (
                <li key={c.path} className="mono">
                  {c.path} {'→'} {c.namespace}
                </li>
              ))}
            </ul>
          </div>
        )
      case 'refused':
        return (
          <div className="kube-fail">
            <p>
              {t(
                `kube.confirm.refused.${preview.plan.ok ? 'nothing' : preview.plan.reason}` as 'kube.confirm.refused.nothing'
              )}
            </p>
            {!preview.plan.ok && (
              <ul>
                {preview.plan.paths.map((p) => (
                  <li key={p} className="mono">
                    {p}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      case 'kubectl':
        return (
          <div className="kube-fail">
            {preview.timedOut && <p>{t('kube.confirm.timedOut')}</p>}
            <pre className="confirm-code">{preview.stderr}</pre>
          </div>
        )
    }
  }

  const multi = preview?.ok === true && preview.commandLines.length > 1

  return (
    <div className="modal-backdrop" {...backdropProps(onCancel)}>
      <div className="modal kube-confirm" onClick={(e) => e.stopPropagation()}>
        <h2>{t(`kube.confirm.title.${verb}` as 'kube.confirm.title.apply')}</h2>
        <div className="kube-pills">
          <span className="kube-pill">
            <FileIcon id="kubernetes" tone="blue" />
            <span className="mono">{context}</span>
          </span>
          <span className="kube-pill mono">{t('kube.confirm.namespace', { ns: namespaceLabel })}</span>
          {preview?.ok && (
            <span className="kube-pill">{t('kube.confirm.counts', { files, resources: preview.resources.length })}</span>
          )}
          {preview?.ok && (
            <span className="kube-valid">
              <Check size={13} aria-hidden="true" />
              {t('kube.confirm.validated')}
            </span>
          )}
        </div>

        {preview === null && (
          <div className="kube-loading">
            <span className="loading-spinner" aria-hidden="true" />
            {t('kube.confirm.loading')}
          </div>
        )}
        {failure()}

        {preview?.ok && (
          <>
            <div className="kube-main">
              <div className="kube-list">
                <div className="kube-list-title">{t('kube.confirm.resources')}</div>
                {entries.map((e, i) => (
                  <div key={`${e.command}:${e.diff.ref}`}>
                    {multi && (i === 0 || entries[i - 1].command !== e.command) && (
                      <div className="kube-list-group">{t('kube.confirm.command', { n: e.command + 1 })}</div>
                    )}
                    <button
                      type="button"
                      className={`kube-res${i === selectedIdx ? ' selected' : ''}`}
                      onClick={() => setPicked(i)}
                    >
                      <span className={`kube-mark ${e.diff.state}`}>{MARK[e.diff.state]}</span>
                      <span className="kube-res-name">{e.diff.ref}</span>
                      <span className="kube-res-state">
                        {e.diff.state === 'changed'
                          ? t('kube.confirm.state.changed', { count: e.diff.changedLines })
                          : t(STATE_KEY[e.diff.state])}
                      </span>
                    </button>
                  </div>
                ))}
              </div>
              <div className="kube-diff-pane">
                {selected && (
                  <>
                    <div className="kube-diff-title">
                      <span className="mono">{selected.ref}</span>
                      <label className="check-small">
                        <input type="checkbox" checked={keepServerFields} onChange={onToggleServerFields} />
                        <span>{t('kube.confirm.serverFields')}</span>
                      </label>
                    </div>
                    <SideBySideDiff rows={selected.rows} afterLabel={afterLabel} />
                  </>
                )}
              </div>
            </div>
            {preview.plan.leftOut.length > 0 && (
              <div className="kube-leftout">
                <div className="kube-list-title">{t('kube.confirm.leftOut', { count: preview.plan.leftOut.length })}</div>
                <ul>
                  {preview.plan.leftOut.map((l) => (
                    <li key={l.path}>
                      <span className="mono">{l.path}</span>
                      <span className="kube-leftout-reason">
                        {t(`kube.confirm.leftOutReason.${l.reason}` as 'kube.confirm.leftOutReason.helm')}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}

        {commandLines.length > 0 && (
          <div className="kube-commands">
            <pre className="kube-cmd-text">{commandLines.map((l) => `$ ${commandText(l)}`).join('\n')}</pre>
            <button
              type="button"
              className="icon-btn"
              title={t('kube.confirm.copyCommands')}
              aria-label={t('kube.confirm.copyCommands')}
              onClick={copyAll}
            >
              {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            </button>
          </div>
        )}

        <div className="row right">
          <button type="button" onClick={onCancel}>
            {verb === 'compare' ? t('common.close') : t('common.cancel')}
          </button>
          {verb !== 'compare' && (
            <button
              type="button"
              className={verb === 'delete' ? 'primary danger' : 'primary'}
              disabled={!canConfirm}
              onClick={onConfirm}
            >
              {t(verb === 'delete' ? 'kube.confirm.delete' : 'kube.confirm.apply', { context })}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
