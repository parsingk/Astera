import { useEffect, useRef, useState } from 'react'
import { INTENTS, type Annotation, type Intent } from '../../../core/preview/pick/types'
import { annotationLabel } from '../../../core/preview/pick/prompt'
import { useI18n } from '../i18n/I18nProvider'
import { Select } from './Select'

/** The collected annotations under a preview page — one card each, the Send/Copy/Clear head. Owns
 *  nothing but its collapsed flag; the list and every edit belong to BrowserPane. */
export function AnnotationTray({
  annotations,
  canSend,
  onChange,
  onDelete,
  onClear,
  onCopy,
  onSend,
  onFocusAnnotation,
  focusId
}: {
  annotations: readonly Annotation[]
  canSend: boolean
  onChange: (id: string, patch: { comment?: string; intent?: Intent }) => void
  onDelete: (id: string) => void
  onClear: () => void
  onCopy: () => void
  onSend: (anchor: DOMRect) => void
  onFocusAnnotation: (id: string) => void
  focusId: string | null
}): React.JSX.Element {
  const { t } = useI18n()
  const [collapsed, setCollapsed] = useState(false)
  const commentRefs = useRef(new Map<string, HTMLTextAreaElement>())

  // A new annotation's comment takes the caret — the user has just clicked, and typing is the next thing
  useEffect(() => {
    if (!focusId) return
    const el = commentRefs.current.get(focusId)
    if (el) el.focus()
  }, [focusId])

  const intentItems = INTENTS.map((i) => ({ value: i, label: t(`preview.design.intent.${i}`) }))

  return (
    <div className={`dm-tray${collapsed ? ' collapsed' : ''}`}>
      <div className="dm-head">
        <span className="dm-title">{t('preview.design.tray.title', { count: annotations.length })}</span>
        <button type="button" className="primary" disabled={!canSend} title={canSend ? undefined : t('preview.design.noSession')} onClick={(e) => onSend(e.currentTarget.getBoundingClientRect())}>
          {t('preview.design.send')}
        </button>
        <button type="button" onClick={onCopy}>{t('preview.design.copy')}</button>
        <button type="button" onClick={onClear}>{t('preview.design.clear')}</button>
        <button type="button" aria-expanded={!collapsed} onClick={() => setCollapsed((c) => !c)}>{collapsed ? '▴' : '▾'}</button>
      </div>
      {!collapsed && (
        <div className="dm-cards">
          {annotations.map((a) => (
            <div key={a.id} className="dm-card" onClick={() => onFocusAnnotation(a.id)}>
              <span className="dm-seq" aria-hidden="true">{a.seq}</span>
              {a.shotThumb ? (
                // The data URL, not the saved file. Chromium refuses a `file:` URL from an `http:`
                // document, and this renderer is served over http in development — pointing the card at
                // the path gave a broken image for the whole working session and only came right in a
                // packaged build. The path still goes to the agent, which reads files.
                <img className="dm-shot" src={a.shotThumb} alt="" />
              ) : (
                <span className="dm-shot empty">—</span>
              )}
              <span className="dm-label" title={annotationLabel(a.payload)}>{annotationLabel(a.payload)}</span>
              <textarea
                className="dm-comment"
                ref={(el) => {
                  if (el) commentRefs.current.set(a.id, el)
                  else commentRefs.current.delete(a.id)
                }}
                rows={1}
                placeholder={t('preview.design.comment')}
                value={a.comment}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => onChange(a.id, { comment: e.target.value })}
                onKeyDown={(e) => e.stopPropagation()}
              />
              <div className="dm-side" onClick={(e) => e.stopPropagation()}>
                <Select items={intentItems} value={a.intent} onChange={(v) => onChange(a.id, { intent: v as Intent })} ariaLabel={t('preview.design.intent.label')} noCheck />
                <button type="button" className="ghost danger" aria-label={t('preview.design.delete')} title={t('preview.design.delete')} onClick={() => onDelete(a.id)}>×</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
