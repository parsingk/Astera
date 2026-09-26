import { useEffect, useState } from 'react'
import type { CliInstallStatus } from '../../../core/types'
import { useI18n } from '../i18n/I18nProvider'
import { toast } from '../lib/toast'

/** 설정 화면의 명령줄 도구 칸 (공개 CLI 설계 §10).
 *
 *  **설치 단계가 아니라 버튼인 이유**는 설계에 있다: 되돌릴 수 있고, 어디에 놓았는지 말할 수 있고,
 *  앱을 까는 모든 사람에게 묻지도 않은 PATH 변경을 물리지 않는다.
 *
 *  같은 settings-row + settings-hint 모양을 쓴다(App.tsx 의 토글들). 상태를 스스로 읽고 쓴다 —
 *  이 값을 읽는 곳이 여기뿐이다. */
export function CliSettings(): React.JSX.Element {
  const { t } = useI18n()
  const [status, setStatus] = useState<CliInstallStatus | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.api.cli.status().then(setStatus)
  }, [])

  const install = async (): Promise<void> => {
    setBusy(true)
    try {
      setStatus(await window.api.cli.install())
      toast.success(t('settings.cli.installed.toast'))
    } catch (err) {
      toast.error(
        t('settings.cli.failed', { detail: err instanceof Error ? err.message : String(err) })
      )
    } finally {
      setBusy(false)
    }
  }

  // 되돌리기(명세 §29). 앱이 쓴 셔틀 파일만 지운다. 폴더도, 그 안의 다른 파일도 남는다.
  const uninstall = async (): Promise<void> => {
    setBusy(true)
    try {
      setStatus(await window.api.cli.uninstall())
      toast.success(t('settings.cli.uninstalled.toast'))
    } catch (err) {
      toast.error(
        t('settings.cli.uninstallFailed', {
          detail: err instanceof Error ? err.message : String(err)
        })
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-group">
      <div className="settings-row">
        <span>{t('settings.cli.label')}</span>
        <div className="cli-actions">
          <button disabled={busy} onClick={() => void install()}>
            {status?.installed ? t('settings.cli.reinstall') : t('settings.cli.install')}
          </button>
          {status?.installed && (
            <button disabled={busy} onClick={() => void uninstall()}>
              {t('settings.cli.uninstall')}
            </button>
          )}
        </div>
      </div>
      <span className="settings-hint">{t('settings.cli.hint')}</span>
      {status !== null && (
        <>
          <span className="settings-hint">
            {status.installed ? t('settings.cli.installed') : t('settings.cli.notInstalled')}
            {' — '}
            {status.dir}
          </span>
          {/* 설치되기 전에는 PATH 이야기를 하지 않는다 — 아직 넣을 것이 없는 폴더다. */}
          {status.installed && (
            <span className="settings-hint">
              {status.onPath ? t('settings.cli.onPath') : t('settings.cli.pathMissing')}
            </span>
          )}
          {/* 설치 응답에만 온다: 설치 폴더 이름이 ASCII 가 아닌데 정션을 못 만들어 .cmd 에 진짜 경로를 적었다. */}
          {status.installed && status.warnings && status.warnings.length > 0 && (
            <span className="settings-hint">
              {t('settings.cli.cmdRawPath', { detail: status.warnings.map((w) => w.detail).join('; ') })}
            </span>
          )}
          {status.installed && !status.onPath && (
            <div className="cli-path-hint">
              <code>{status.hint}</code>
              <button onClick={() => void navigator.clipboard.writeText(status.hint)}>
                {t('settings.cli.copy')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
