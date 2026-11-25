import { useEffect, useState } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import { backdropProps } from '../lib/backdrop'
import { Select } from './Select'

/** What attaching did: put in the session's input, refused because the session is holding a dialog, refused because
 *  it cannot take this paste now (or no longer fits), or refused because the file changed since the piece was taken. */
export type AttachOutcome = 'sent' | 'waiting' | 'notReady' | 'changed'

/**
 * The step between a piece of the workbench and an agent (spec W4: the person sees the scope before it is sent). It
 * shows the exact text that will be pasted, cleaned, masked and cut as `core/context/contextRef.ts` made it, says what
 * was taken out, masked or cut and whether the editor holds unsaved edits, and lets the person pick which fitting session
 * gets it.
 *
 * Attaching puts the text in that session's input and nothing more; the person sends it there. It reads the file again
 * first, so it waits, and the button with it. A refusal keeps the dialog open and says why, and a file that changed
 * meanwhile can no longer be attached from here: it is selected again.
 */
export function ContextPreview({
  label,
  text,
  masked,
  cut,
  stripped,
  dirty,
  mainOnly,
  sessions,
  onAttach,
  onClose
}: {
  /** Where the piece is from, as the person reads it (`src/a.ts:3-5`, a run's name). */
  label: string
  /** The text that will be pasted (contextText). */
  text: string
  masked: number
  /** Which part was kept when the excerpt had to be cut: its start (a selection) or its end (a log's tail). */
  cut: 'start' | 'end' | null
  /** Control characters taken out (contextText). */
  stripped: number
  /** The editor holds edits the file on disk does not: the agent will read the saved file. */
  dirty: boolean
  /** Several ranges were selected; only the main one goes. */
  mainOnly: boolean
  /** The sessions that may receive it (sessionFits), the first chosen, each named with its account (sessions in one
   *  folder are all named after it), marked when it is a chat session and when an agent or Astera started it. Never
   *  empty. */
  sessions: ReadonlyArray<{ id: string; title: string; account: string; chat: boolean; agent: boolean }>
  onAttach: (sessionId: string) => Promise<AttachOutcome>
  onClose: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [target, setTarget] = useState(sessions[0]?.id ?? '')
  const [problem, setProblem] = useState<string | null>(null)
  const [changed, setChanged] = useState(false)
  const [busy, setBusy] = useState(false)
  const title = t('context.preview.title')

  // In the bubble phase, after the session list: an open list takes Escape for itself (Select prevents its default),
  // and the preview closes only on an Escape nothing else took
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const attach = async (): Promise<void> => {
    setBusy(true)
    const outcome = await onAttach(target)
    setBusy(false)
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
            // The account in the label itself: the closed picker shows the label only, and that is the choice that counts
            items={sessions.map((s) => ({ value: s.id, label: `${s.title} · ${s.account}${s.chat ? ` · ${t('context.preview.chatSession')}` : ''}${s.agent ? ` · ${t('context.preview.agentSession')}` : ''}` }))}
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
        {stripped > 0 && <span className="modal-hint">{t('context.preview.stripped', { count: stripped })}</span>}
        {cut === 'start' && <span className="modal-hint">{t('context.preview.cut')}</span>}
        {cut === 'end' && <span className="modal-hint">{t('context.preview.cutEnd')}</span>}
        {mainOnly && <span className="modal-hint">{t('context.preview.mainOnly')}</span>}
        {dirty && <span className="modal-hint warn">{t('context.preview.dirty')}</span>}
        {changed && <span className="modal-hint warn">{t('context.preview.changed')}</span>}
        {problem && <span className="modal-hint warn">{problem}</span>}
        <span className="modal-hint">{t('context.preview.hint')}</span>
        <div className="row right">
          <button onClick={onClose}>{t('common.cancel')}</button>
          <button className="primary" autoFocus onClick={() => void attach()} disabled={target === '' || changed || busy}>
            {t('context.preview.attach')}
          </button>
        </div>
      </div>
    </div>
  )
}
