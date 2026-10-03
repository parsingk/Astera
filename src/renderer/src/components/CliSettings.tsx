import { useEffect, useState } from 'react'
import type { CliInstallStatus } from '../../../core/types'
import { useI18n } from '../i18n/I18nProvider'
import { toast } from '../lib/toast'

/** 설정 화면의 명령줄 도구 칸 (공개 CLI 설계 §10).
 *
 *  **설치 단계가 아니라 버튼인 이유**는 설계에 있다: 되돌릴 수 있고, 어디에 놓았는지 말할 수 있고,
 *  앱을 까는 모든 사람에게 묻지도 않은 PATH 변경을 물리지 않는다.
 *
 *  **win32 에서는 버튼이 PATH 도 넣는다**(2026-09-30): 손으로 칠 한 줄이 이 칸의 가장 큰 걸림돌이었다.
 *  옆의 체크박스가 그 동의이고 기본으로 켜져 있으며, 끄면 예전처럼 한 줄을 보여 준다. 제거는 그 항목만 뺀다.
 *
 *  같은 settings-row + settings-hint 모양을 쓴다(App.tsx 의 토글들). 상태를 스스로 읽고 쓴다 —
 *  이 값을 읽는 곳이 여기뿐이다.
 *
 *  `onStatus` hands each value it holds (the first read, then each Install and Uninstall reply) to
 *  the MCP lines below it (McpSettings), which need to know whether the command is installed and where. */
export function CliSettings({ onStatus }: { onStatus?: (s: CliInstallStatus) => void } = {}): React.JSX.Element {
  const { t } = useI18n()
  const [status, setStatus] = useState<CliInstallStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [addToPath, setAddToPath] = useState(true)

  useEffect(() => {
    void window.api.cli.status().then(setStatus)
  }, [])

  useEffect(() => {
    if (status) onStatus?.(status)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the value, not the callback's identity
  }, [status])

  const install = async (): Promise<void> => {
    setBusy(true)
    try {
      const next = await window.api.cli.install({ addToPath: status?.canEditUserPath === true && addToPath })
      setStatus(next)
      if (next.userPathError) toast.error(t('settings.cli.pathFailed', { detail: next.userPathError }))
      else if (next.userPathTooLong) toast.error(t('settings.cli.pathTooLong.toast'))
      else toast.success(t(next.userPath === 'added' ? 'settings.cli.installed.pathAdded.toast' : 'settings.cli.installed.toast'))
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
      const next = await window.api.cli.uninstall()
      setStatus(next)
      toast.success(t(next.userPath === 'removed' ? 'settings.cli.uninstalled.pathRemoved.toast' : 'settings.cli.uninstalled.toast'))
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
      <span className="settings-hint">{t(status?.canEditUserPath ? 'settings.cli.hint.win32' : 'settings.cli.hint')}</span>
      {/* win32 only: the person's consent to the one PATH entry Install adds (main/userPath.ts). */}
      {status?.canEditUserPath && !status.onPath && (
        <label className="settings-row cli-add-to-path">
          <span>{t('settings.cli.addToPath')}</span>
          <input type="checkbox" checked={addToPath} disabled={busy} onChange={(e) => setAddToPath(e.target.checked)} />
        </label>
      )}
      {status !== null && (
        <>
          <span className="settings-hint">
            {status.installed ? t('settings.cli.installed') : t('settings.cli.notInstalled')}
            {': '}
            {status.dir}
          </span>
          {/* 설치되기 전에는 PATH 이야기를 하지 않는다 — 아직 넣을 것이 없는 폴더다. */}
          {status.installed && (
            <span className="settings-hint">
              {status.onPath
                ? t('settings.cli.onPath')
                : t(status.userPathTooLong ? 'settings.cli.pathTooLong' : 'settings.cli.pathMissing')}
            </span>
          )}
          {/* 설치 응답에만 온다: 설치 폴더 이름이 ASCII 가 아닌데 정션을 못 만들어 .cmd 에 진짜 경로를 적었다. */}
          {status.installed && status.warnings && status.warnings.length > 0 && (
            <span className="settings-hint">
              {t('settings.cli.cmdRawPath', { detail: status.warnings.map((w) => w.detail).join('; ') })}
            </span>
          )}
          {/* Not when the user Path is too long: the line would add to it and leave it out of new shells. */}
          {status.installed && !status.onPath && !status.userPathTooLong && (
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
