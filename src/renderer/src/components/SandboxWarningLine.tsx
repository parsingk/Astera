// What a sandboxed start warned about (Task E fix rounds 2 and 3: the work folder holds the home folder, or Claude's
// shell cannot run under Ubuntu's AppArmor profile for bubblewrap), said in one quiet line above the session's terminal
// or chat thread. It reads the session's info (SessionInfo.sandboxWarnings, which a Host worker's info and a session taken
// back after a restart carry too, from the note), not the terminal: Codex and Claude Code's fullscreen draw on the
// alternate screen, which hid a line written into the pty at the start until the CLI exited. Drawn in the sandbox
// marker's manner (SandboxMarker.tsx): a small shield, dim, the whole sentence in its title. The person can close it,
// and it stays closed for that session (sandboxWarningClosed.ts).
import { useSyncExternalStore } from 'react'
import { ShieldAlert, X } from 'lucide-react'
import type { SandboxStartWarning } from '../../../core/types'
import { sandboxWarningMessage } from '../../../core/sandbox/warningKeys'
import { close, isClosed, subscribe } from '../lib/sandboxWarningClosed'
import { useI18n } from '../i18n/I18nProvider'

export function SandboxWarningLine({
  sessionId,
  warnings
}: {
  sessionId: string
  /** The session's start warnings, absent for a session outside the sandbox or with nothing to say. */
  warnings: readonly SandboxStartWarning[] | undefined
}): React.JSX.Element | null {
  const { t } = useI18n()
  const closedNow = (): boolean => isClosed(sessionId)
  // The server snapshot too, the same answer: the renderer tests draw it with renderToStaticMarkup
  const closed = useSyncExternalStore(subscribe, closedNow, closedNow)
  const message = warnings ? sandboxWarningMessage(warnings) : null
  if (message === null || closed) return null
  const text = t(message.key)
  return (
    <div className="sandbox-warning-line" role="note">
      <span className="sandbox-warning-icon" aria-hidden="true">
        <ShieldAlert size={11} />
      </span>
      <span className="sandbox-warning-text" title={text}>
        {text}
      </span>
      <button type="button" className="sandbox-warning-close" aria-label={t('common.close')} title={t('common.close')} onClick={() => close(sessionId)}>
        <X size={11} />
      </button>
    </div>
  )
}
