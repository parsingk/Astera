// The permission request an external agent working a Task waits on (Phase 5 A1), in the run's detail (RunDetail): the
// agent, what it asks to do, and its options as buttons. A button answers the question with that option (`reply`), and
// the agent is told what the person picked. Nobody else answers it: the loop does not, and an agent session is refused.
import { useState } from 'react'
import type { JobTask } from '../../../core/types'
import { useI18n } from '../i18n/I18nProvider'
import { replyNote, type OrchDoor } from '../lib/orchDoor'
import { externalNameOf } from '../lib/reviewerSettingsView'

export function PermissionAsk({ task, door }: { task: JobTask; door: OrchDoor }): React.JSX.Element | null {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ask = task.permissionAsk
  if (!ask) return null
  const options = ask.options && ask.options.length > 0 ? ask.options : []
  const answer = async (option: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const reply = await door.command('reply', { id: ask.id, body: option })
      if (reply.status >= 400) setError(replyNote(reply, t as never, t('jobs.permissionAsk.failed')))
    } catch {
      setError(t('jobs.permissionAsk.failed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="detail-task-fields" role="group" aria-label={t('jobs.permissionAsk.title')}>
      <div className="detail-filter">
        <b>{t('jobs.permissionAsk.title')}</b>
      </div>
      <p className="modal-hint">
        {t('jobs.permissionAsk.who', { agent: externalNameOf(task) ?? task.externalAgentId ?? '', task: task.title })}
      </p>
      <p className="detail-gate-question">{ask.question}</p>
      <div className="detail-gate-options">
        {options.map((o) => (
          <button key={o} disabled={busy || door.readOnlyReason !== null} onClick={() => void answer(o)}>
            {o}
          </button>
        ))}
      </div>
      {error !== null && <p className="warn-text">{error}</p>}
    </div>
  )
}
