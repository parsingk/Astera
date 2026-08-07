import { useI18n } from '../i18n/I18nProvider'
import type { UpdateStatus } from '../../../core/types'

/**
 * Blocking-mode campaign screen (later switched over to being campaign-based). It only appears when the
 * policy has put this app in scope with `mode: "block"`, and there is no way out other than updating —
 * download, install, retry and quit are all there is.
 *
 * The titlebar is not covered, so moving and minimizing the window still work (it has to be possible to
 * get the window out of the way while waiting for the download).
 * autoDownload normally starts the download by itself; the button here covers the case where it has
 * not started yet or has failed.
 */
export function UpdateGate({
  update,
  onDownload,
  onInstall,
  onRetry
}: {
  update: UpdateStatus | null
  onDownload: () => void
  onInstall: () => void
  onRetry: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const ready = update?.state === 'downloaded'
  const downloading = update?.state === 'downloading'
  const available = update?.state === 'available'
  const version = update?.version

  return (
    <div className="update-gate" role="alertdialog" aria-modal="true">
      <div className="update-gate-card">
        <h2>{t('update.gate.title')}</h2>
        <p className="update-gate-body">
          {version
            ? t('update.gate.body', { version })
            : t('update.gate.bodyNoVersion')}
        </p>
        <p className="update-gate-state">
          {downloading
            ? t('update.info.downloading', { percent: update?.percent ?? 0 })
            : ready
              ? t('update.gate.ready', { version: version ?? '' })
              : update?.state === 'error'
                ? t('update.gate.failed')
                : t('update.gate.preparing')}
        </p>
        <div className="update-gate-actions">
          {ready ? (
            <button className="update-gate-primary" onClick={onInstall}>
              {t('update.toast.installNow')}
            </button>
          ) : available ? (
            <button className="update-gate-primary" onClick={onDownload}>
              {t('update.toast.download')}
            </button>
          ) : (
            <button className="update-gate-primary" disabled={downloading} onClick={onRetry}>
              {t('update.gate.retry')}
            </button>
          )}
          <button onClick={() => window.api.app.quit()}>{t('update.gate.quit')}</button>
        </div>
      </div>
    </div>
  )
}
