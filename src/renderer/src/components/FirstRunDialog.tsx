import { useEffect } from 'react'
import type { SessionKind } from '../../../core/types'
import { useI18n } from '../i18n/I18nProvider'

/**
 * The one question a first run asks: what a new session is.
 *
 * Shown only to someone who has never used this app on this machine — an installation that predates
 * the question is left alone (main/appSettingsStore.ts's `firstRunAsked` carries how those two are
 * told apart). It asks once: answering and dismissing settle it the same way, because a question that
 * comes back is worse than a default.
 *
 * There is no wrong answer here and the modal says so in one line: it names both places the choice
 * can be changed afterwards — Settings, and the kind picker at the head of the dialog that starts a
 * session. Said once — a second line underneath repeating it read as a warning about a decision that
 * does not deserve one.
 */
export function FirstRunDialog({
  onPick,
  onDismiss
}: {
  onPick: (kind: SessionKind) => void
  onDismiss: () => void
}): React.JSX.Element {
  const { t } = useI18n()

  // Escape settles it rather than leaving it open, the same as the backdrop — see the note above on
  // asking once. Captured so it does not reach the terminal and explorer handlers underneath.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onDismiss()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onDismiss])

  return (
    <div className="modal-backdrop" onClick={onDismiss}>
      <div className="modal first-run" onClick={(e) => e.stopPropagation()}>
        <h2>{t('firstRun.title')}</h2>
        <p className="confirm-text confirm-body">{t('firstRun.body')}</p>
        <div className="first-run-choices">
          <button type="button" autoFocus onClick={() => onPick('terminal')}>
            <span className="first-run-name">{t('firstRun.terminal')}</span>
            <span className="first-run-what">{t('firstRun.terminalWhat')}</span>
          </button>
          <button type="button" onClick={() => onPick('chat')}>
            <span className="first-run-name">{t('firstRun.chat')}</span>
            <span className="first-run-what">{t('firstRun.chatWhat')}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
