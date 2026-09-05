import { useEffect, useRef } from 'react'
import { INTENTS, PICK_BUDGET, type Annotation, type Intent } from '../../../core/preview/pick/types'
import { annotationLabel } from '../../../core/preview/pick/prompt'
import { useI18n } from '../i18n/I18nProvider'

/** The comment box for the element just picked, opened beside the pointer.
 *
 *  The tray lists what has been collected; this is where the remark is actually made. Going to the
 *  corner of the screen and finding the right row to type into breaks the one thing this mode is for
 *  — pointing at something and saying what is wrong with it.
 *
 *  Edits land on the annotation as they are typed, so there is nothing to save: Enter and Escape both
 *  just close it, and the next click opens it again on the next element. */
export function AnnotationPopover({
  annotation,
  at,
  onChange,
  onClose
}: {
  annotation: Annotation
  /** Where to open, in the stage's own pixels. Already clamped to the stage by the caller. */
  at: { x: number; y: number }
  onChange: (id: string, patch: { comment?: string; intent?: Intent }) => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const boxRef = useRef<HTMLTextAreaElement | null>(null)

  // The caret goes here the moment it opens — the click was the aim, typing is the next thing
  useEffect(() => {
    boxRef.current?.focus()
  }, [annotation.id])

  return (
    <div
      className="dm-pop"
      style={{ left: at.x, top: at.y }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // The picker's Escape listener is on the window and turns the whole mode off. Both keys are
        // stopped here so closing a comment box is only ever that.
        e.stopPropagation()
        if (e.key === 'Escape') { e.preventDefault(); onClose() }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onClose() }
      }}
    >
      <div className="dm-pop-head">
        <span className="dm-seq" aria-hidden="true">{annotation.seq}</span>
        <span className="dm-pop-label" title={annotationLabel(annotation.payload)}>{annotationLabel(annotation.payload)}</span>
        <button type="button" className="ghost" aria-label={t('preview.design.close')} onClick={onClose}>×</button>
      </div>
      <textarea
        ref={boxRef}
        rows={2}
        maxLength={PICK_BUDGET.comment}
        placeholder={t('preview.design.comment')}
        value={annotation.comment}
        onChange={(e) => onChange(annotation.id, { comment: e.target.value })}
      />
      <div className="dm-intents" role="group" aria-label={t('preview.design.intent.label')}>
        {INTENTS.map((i) => (
          <button
            key={i}
            type="button"
            className={i === annotation.intent ? 'on' : undefined}
            aria-pressed={i === annotation.intent}
            onClick={() => onChange(annotation.id, { intent: i })}
          >
            {t(`preview.design.intent.${i}`)}
          </button>
        ))}
      </div>
    </div>
  )
}
