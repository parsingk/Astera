import { useEffect, useState } from 'react'
import type { GhProbe } from '../../../core/github/types'
import { useI18n } from '../i18n/I18nProvider'
import { toast } from '../lib/toast'

/** The GitHub pane of the settings modal (design doc §5). Reads state and instructs — there is
 *  deliberately no login button: auth belongs to `gh auth login` in a terminal. */
export function GithubSettings(): React.JSX.Element {
  const { t } = useI18n()
  const [probe, setProbe] = useState<GhProbe | null>(null) // null = first read in flight
  const [polling, setPolling] = useState(true)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    void window.api.github.status().then(setProbe)
    void window.api.settings.getGithubPolling().then(setPolling)
  }, [])

  const recheck = async (): Promise<void> => {
    setChecking(true)
    try {
      setProbe(await window.api.github.recheck())
    } finally {
      setChecking(false)
    }
  }

  return (
    <>
      <div className="settings-row">
        <span>{t('github.settings.status')}</span>
        <span>
          {probe === null || checking
            ? '…'
            : probe.kind === 'connected'
              ? probe.account
                ? t('github.settings.connected', { account: probe.account })
                : t('github.settings.connectedNoAccount')
              : probe.kind === 'not-installed'
                ? t('github.settings.notInstalled')
                : probe.kind === 'not-authenticated'
                  ? t('github.settings.notAuthenticated')
                  : t('github.settings.error')}
        </span>
      </div>
      {probe?.kind === 'not-installed' && (
        <div className="settings-row">
          <span />
          <button onClick={() => void window.api.system.openExternal('https://cli.github.com')}>
            {t('github.settings.installLink')}
          </button>
        </div>
      )}
      {probe?.kind === 'not-authenticated' && (
        <div className="settings-row">
          <code>gh auth login</code>
          <button
            onClick={() => {
              window.api.clipboard.writeText('gh auth login')
              toast.success(t('github.settings.commandCopied'))
            }}
          >
            {t('github.settings.copyCommand')}
          </button>
        </div>
      )}
      <div className="settings-row">
        <span />
        <button disabled={checking} onClick={() => void recheck()}>
          {t('github.settings.recheck')}
        </button>
      </div>
      {/* A label so pressing the text toggles too — the same wrapping the orchestration row uses */}
      <label className="settings-row">
        <span>{t('github.settings.polling')}</span>
        <input
          type="checkbox"
          checked={polling}
          onChange={(e) => {
            const next = e.target.checked
            setPolling(next) // optimistic — reverted below on failure
            void window.api.settings.setGithubPolling(next).catch((err) => {
              setPolling(!next)
              toast.error(
                t('github.settings.saveFailed', {
                  detail: err instanceof Error ? err.message : String(err)
                })
              )
            })
          }}
        />
      </label>
      <span className="settings-hint">{t('github.settings.pollingHint')}</span>
    </>
  )
}
