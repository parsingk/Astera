// The marker of a session that runs in its CLI's sandbox (sandbox design §6), titled so a hover says what it means: a
// session tab's (WorkbenchTabs.tsx) and each row of the remote sessions dialog (sandbox follow-ups, item 2), so both say
// it with the same icon and the same words in every language. Nothing for a session outside the sandbox.
import type { SandboxKind } from '../../../core/types'
import { useI18n } from '../i18n/I18nProvider'
import { Shield, ShieldOff } from 'lucide-react'

export function SandboxMarker({ kind }: { kind: SandboxKind | undefined }): React.JSX.Element | null {
  const { t } = useI18n()
  if (kind === 'sandbox')
    return (
      <span className="tab-sandbox" title={t('session.tab.sandboxed')}>
        <Shield size={11} />
      </span>
    )
  // Claude Code on Windows: deny rules for its file tools only, and the marker says so rather than "in the sandbox"
  if (kind === 'deny-only')
    return (
      <span className="tab-sandbox is-deny-only" title={t('session.tab.denyOnly')}>
        <ShieldOff size={11} />
      </span>
    )
  return null
}
