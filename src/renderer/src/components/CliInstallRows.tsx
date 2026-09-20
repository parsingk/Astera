import type { ReactNode } from 'react'
import { installCommandFor, type InstallableCli } from '../../../core/install/cliInstall'
import { useI18n } from '../i18n/I18nProvider'
import { useCliInstall } from '../hooks/useCliInstall'
import type { CliStatus } from '../../../core/types'

const CLIS: readonly { id: InstallableCli; label: string }[] = [
  { id: 'claude', label: 'Claude CLI' },
  { id: 'codex', label: 'Codex CLI' }
]

/**
 * The two CLI rows in Settings → Info: which version the machine has, and a button to install or
 * reinstall it.
 *
 * The button is the point. Until now the only way to install from inside the app was the full-screen
 * CliMissingScreen, and that screen is only reachable when **neither** CLI is on the machine. A CLI
 * that is installed but broken — a half-finished upgrade, a wrapper whose target is gone — never
 * reached it, and once the app entry gate was corrected to ask about installation rather than
 * runnability (design §7 F6) it never can. That person could see "감지 안 됨" on this very row and
 * had nothing in the app to press. This is that door.
 *
 * It is offered for a CLI that is working too, labelled as a reinstall, because the vendors' own
 * install commands are also their upgrade commands — the same button, honestly named for what it
 * does to something already there.
 *
 * Rows rather than a panel: they replace two `.settings-row`s that already said the same thing with
 * no button, so the section keeps its shape and nothing moves for someone who never needs this.
 */
export function CliInstallRows({
  cli,
  onInstalled
}: {
  /** The runnability check App already holds — `version` is what this row has always shown, and it
   *  is present only when `--version` actually ran. A CLI that is installed but refuses to run in
   *  the app's working directory shows as not detected here, which is the honest answer to "what
   *  does this machine have" and exactly the case the button exists for. */
  cli: { claude: CliStatus; codex: CliStatus } | null
  /** A fresh existence check after a successful install. App refreshes both of its CLI answers from
   *  it — the entry gate reads existence, these rows read the version. */
  onInstalled: (installed: { claude: boolean; codex: boolean }) => void
}): ReactNode {
  const { t } = useI18n()
  const { phase, log, logOpen, setLogOpen, logRef, install } = useCliInstall(onInstalled)
  const running = phase.state === 'running'

  return (
    <>
      {CLIS.map(({ id, label }) => {
        const version = cli?.[id].version
        const plan = installCommandFor(id, window.api.platform)
        const busy = running && phase.cli === id
        return (
          <div className="settings-row" key={id}>
            <span>{label}</span>
            <span className="settings-cli-value">
              <span>{version ?? t('settings.info.cliNotDetected')}</span>
              {/* No command for this platform means no button. The full-screen version spells that
                  out in a sentence; a settings row is the wrong place for one, and a row that looks
                  exactly as it did before this existed is the right answer for someone it cannot
                  help anyway. */}
              {plan && (
                <button type="button" disabled={running} onClick={() => install(id)}>
                  {busy
                    ? t('setup.installing')
                    : version !== undefined
                      ? t('settings.info.cliReinstall')
                      : t('setup.install')}
                </button>
              )}
            </span>
          </div>
        )
      })}

      {/* Success needs saying out loud here, unlike on the full-screen version where the screen
          disappearing is the answer. A reinstall of a working CLI can finish with the same version
          string it started with, and a row that does not change reads as a button that did nothing. */}
      {phase.state === 'done' && phase.ok && (
        <div className="settings-row settings-cli-note">
          <span />
          <span>{t('settings.info.cliInstallDone')}</span>
        </div>
      )}

      {phase.state === 'done' && !phase.ok && (
        <div className="settings-row settings-cli-note">
          <span />
          <span className="settings-cli-failed">
            {t('setup.failed')} {t('setup.failedHelp')}
          </span>
        </div>
      )}

      {phase.state === 'unseen' && (
        <div className="settings-row settings-cli-note">
          <span />
          <span className="settings-cli-value">
            <span>{t('setup.notFoundYet', { name: phase.cli === 'claude' ? 'Claude Code' : 'Codex' })}</span>
            <button type="button" onClick={() => void window.api.system.relaunch()}>
              {t('setup.restart')}
            </button>
          </span>
        </div>
      )}

      {log !== '' && (
        <div className="settings-row settings-cli-note">
          <span />
          <span className="settings-cli-value">
            <button type="button" onClick={() => setLogOpen((prev) => !prev)}>
              {logOpen ? t('setup.hideLog') : t('setup.showLog')}
            </button>
          </span>
        </div>
      )}
      {log !== '' && logOpen && (
        <pre ref={logRef} className="settings-cli-log">
          {log}
        </pre>
      )}
    </>
  )
}
