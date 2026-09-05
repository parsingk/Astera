import { useEffect, useRef, useState } from 'react'
import { INTENTS, PICK_BUDGET, type Annotation, type Intent } from '../../../core/preview/pick/types'
import { annotationLabel } from '../../../core/preview/pick/prompt'
import { useI18n } from '../i18n/I18nProvider'

/** The collected annotations, as a card floating over the page rather than a strip beneath it.
 *
 *  It sits inside the stage on purpose. The strip took a row of its own, so the guest reflowed the
 *  moment the first annotation arrived and every badge already on screen moved with it. A floating
 *  card covers a corner instead and the page never changes size.
 *
 *  A row shows what was picked and what was said about it; the comment opens for editing only when
 *  asked. Owns the collapsed flag and which row is being edited — the list itself belongs to
 *  BrowserPane. */
export function AnnotationTray({
  annotations,
  canSend,
  onChange,
  onDelete,
  onClear,
  onCopy,
  copied,
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
  copied: boolean
  onSend: (anchor: DOMRect) => void
  onFocusAnnotation: (id: string) => void
  focusId: string | null
}): React.JSX.Element {
  const { t } = useI18n()
  const [collapsed, setCollapsed] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [draftIntent, setDraftIntent] = useState<Intent>('fix')
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const editRef = useRef<HTMLTextAreaElement | null>(null)

  // A delete or a clear while a row is open must not leave the editor pointing at nothing
  useEffect(() => {
    if (editingId && !annotations.some((a) => a.id === editingId)) setEditingId(null)
  }, [annotations, editingId])

  // The newest row scrolls itself into view. The card is short, and without this the annotation just
  // made is the one you cannot see.
  useEffect(() => {
    if (!focusId) return
    rowRefs.current.get(focusId)?.scrollIntoView({ block: 'nearest' })
  }, [focusId])

  useEffect(() => {
    if (editingId) editRef.current?.focus()
  }, [editingId])

  const startEdit = (a: Annotation): void => {
    setEditingId(a.id)
    setDraft(a.comment)
    setDraftIntent(a.intent)
  }

  const saveEdit = (): void => {
    if (!editingId) return
    onChange(editingId, { comment: draft.trim(), intent: draftIntent })
    setEditingId(null)
  }

  return (
    <div className={`dm-tray${collapsed ? ' collapsed' : ''}`}>
      <div className="dm-head">
        <span className="dm-title">{t('preview.design.tray.title', { count: annotations.length })}</span>
        <button
          type="button"
          className="primary"
          disabled={!canSend}
          title={canSend ? undefined : t('preview.design.noSession')}
          onClick={(e) => onSend(e.currentTarget.getBoundingClientRect())}
        >
          {t('preview.design.send')}
        </button>
        <button type="button" onClick={onCopy}>
          {copied ? t('preview.design.copied') : t('preview.design.copy')}
        </button>
        <button type="button" className="ghost" aria-label={t('preview.design.clear')} title={t('preview.design.clear')} onClick={onClear}>
          🗑
        </button>
        <button type="button" className="ghost" aria-expanded={!collapsed} aria-label={t('preview.design.collapse')} onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? '▴' : '▾'}
        </button>
      </div>
      {!collapsed && (
        <div className="dm-rows">
          {annotations.map((a) => (
            <div
              key={a.id}
              className="dm-row"
              ref={(el) => {
                if (el) rowRefs.current.set(a.id, el)
                else rowRefs.current.delete(a.id)
              }}
              onClick={() => onFocusAnnotation(a.id)}
            >
              <span className="dm-seq" aria-hidden="true">{a.seq}</span>
              {a.id === editingId ? (
                <div
                  className="dm-edit"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    // The picker's own Escape listener is on the window; without this, cancelling an
                    // edit would turn Design Mode off with it
                    e.stopPropagation()
                    if (e.key === 'Escape') { e.preventDefault(); setEditingId(null) }
                  }}
                >
                  <textarea
                    ref={editRef}
                    rows={2}
                    maxLength={PICK_BUDGET.comment}
                    placeholder={t('preview.design.comment')}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                  />
                  <div className="dm-intents" role="group" aria-label={t('preview.design.intent.label')}>
                    {INTENTS.map((i) => (
                      <button
                        key={i}
                        type="button"
                        className={i === draftIntent ? 'on' : undefined}
                        aria-pressed={i === draftIntent}
                        onClick={() => setDraftIntent(i)}
                      >
                        {t(`preview.design.intent.${i}`)}
                      </button>
                    ))}
                  </div>
                  <div className="dm-edit-actions">
                    <button type="button" onClick={() => setEditingId(null)}>{t('preview.design.cancel')}</button>
                    <button type="button" className="primary" onClick={saveEdit}>{t('preview.design.save')}</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="dm-body">
                    <div className="dm-label" title={annotationLabel(a.payload)}>{annotationLabel(a.payload)}</div>
                    {a.comment && <div className="dm-comment">{a.comment}</div>}
                    <div className="dm-intent">{t(`preview.design.intent.${a.intent}`)}</div>
                  </div>
                  <div className="dm-actions" onClick={(e) => e.stopPropagation()}>
                    <button type="button" className="ghost" aria-label={t('preview.design.edit', { seq: a.seq })} title={t('preview.design.edit', { seq: a.seq })} onClick={() => startEdit(a)}>
                      ✎
                    </button>
                    <button type="button" className="ghost danger" aria-label={t('preview.design.delete')} title={t('preview.design.delete')} onClick={() => onDelete(a.id)}>
                      🗑
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
