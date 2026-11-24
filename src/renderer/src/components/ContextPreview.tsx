import { useEffect, useState } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import { backdropProps } from '../lib/backdrop'
import { Select } from './Select'

/** What attaching did: put in the session's input, refused because the session is holding a dialog, refused because
 *  it cannot take a paste (or no longer fits), or refused because the file changed since the piece was taken. */
export type AttachOutcome = 'sent' | 'waiting' | 'notReady' | 'changed'

/**
 * The step between a piece of the workbench and an agent (spec W4: the person sees the scope before it is sent). It
 * shows the exact text that will be pasted, masked and cut as `core/context/contextRef.ts` made it, says what was
 * masked or cut and whether the editor holds unsaved edits, and lets the person pick which fitting session gets it.
 *
 * Attaching puts the text in that session's input and nothing more; the person sends it there. A refusal keeps the
 * dialog open and says why, and a file that changed meanwhile can no longer be attached from here: it is selected again.
 */
export function ContextPreview({
  label,
  text,
  masked,
  cut,
  dirty,
  sessions,
  onAttach,
  onClose
}: {
  /** Where the piece is from, as the person reads it (`src/a.ts:3-5`, a run's name). */
  label: string
  /** The text that will be pasted (contextText). */
  text: string
  masked: number
  cut: boolean
  /** The editor holds edits the file on disk does not: the agent will read the saved file. */
  dirty: boolean
  /** The sessions that may receive it (sessionFits), the first chosen. Never empty: App says so instead of opening. */
  sessions: ReadonlyArray<{ id: string; title: string }>
  onAttach: (sessionId: string) => AttachOutcome
  onClose: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [target, setTarget] = useState(sessions[0]?.id ?? '')
  const [problem, setProblem] = useState<string | null>(null)
  const [changed, setChanged] = useState(false)
  const title = t('context.preview.title')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const attach = (): void => {
    const outcome = onAttach(target)
    if (outcome === 'sent') return
    if (outcome === 'changed') {
      setChanged(true)
      setProblem(null)
      return
    }
    const name = sessions.find((s) => s.id === target)?.title ?? ''
    setProblem(outcome === 'waiting' ? t('preview.design.sendWaiting', { name }) : t('context.preview.notReady'))
  }

  return (
    <div className="modal-backdrop" {...backdropProps(onClose)}>
      <div className="modal context-preview" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <div className="context-preview-source mono">{label}</div>
        <div className="field">
          <label>{t('context.preview.session')}</label>
          <Select
            items={sessions.map((s) => ({ value: s.id, label: s.title }))}
            value={target}
            onChange={(v) => {
              setTarget(v)
              setProblem(null)
            }}
            ariaLabel={t('context.preview.session')}
          />
        </div>
        <pre className="context-preview-text">{text}</pre>
        {masked > 0 && <span className="modal-hint">{t('context.preview.masked', { count: masked })}</span>}
        {cut && <span className="modal-hint">{t('context.preview.cut')}</span>}
        {dirty && <span className="modal-hint warn">{t('context.preview.dirty')}</span>}
        {changed && <span className="modal-hint warn">{t('context.preview.changed')}</span>}
        {problem && <span className="modal-hint warn">{problem}</span>}
        <span className="modal-hint">{t('context.preview.hint')}</span>
        <div className="row right">
          <button onClick={onClose}>{t('common.cancel')}</button>
          <button className="primary" autoFocus onClick={attach} disabled={target === '' || changed}>
            {t('context.preview.attach')}
          </button>
        </div>
      </div>
    </div>
  )
}
