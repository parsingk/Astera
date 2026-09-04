import { useEffect, useRef, useState } from 'react'
import type { RunConfig } from '../../../core/run/types'
import { addableTargets, type RefField } from '../../../core/run/launch'
import { runTypeIcon } from '../../../core/run/typeIcon'
import { useI18n } from '../i18n/I18nProvider'
import { FileIcon } from './FileIcon'
import { Plus, X } from 'lucide-react'

/** A list of other run configurations, as chips. Used twice with the same meaning — "these
 *  configurations, named by id" — and two different readings of the order:
 *
 *  - the form's **Before launch** section, where the order is the order they run in;
 *  - a **compound's members**, where it is display only, because members start together.
 *
 *  The add picker offers `addableTargets`' answer, so a configuration that would create a cycle is
 *  never offered rather than offered and then refused at ▶. A chip whose id resolves to nothing is
 *  still drawn, showing the id — the tree marks that configuration ⚠, and hiding the chip would leave
 *  the user nothing to remove. */
export function ConfigRefList({
  ids,
  all,
  hostId,
  field,
  onChange
}: {
  ids: readonly string[]
  /** The dialog's whole draft list — a configuration added with ＋ a moment ago is a valid target */
  all: readonly RunConfig[]
  hostId: string
  /** Which of the host's own reference fields `ids` is — a compound has both, so addableTargets has to
   *  be told which one it is probing rather than guessing it from the host's kind. */
  field: RefField
  onChange: (ids: string[]) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDocDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const targets = addableTargets(all, hostId, field, ids)

  return (
    <div className="ref-list" ref={rootRef}>
      {ids.map((id) => {
        const c = all.find((x) => x.id === id)
        return (
          <span className={`ref-chip${c ? '' : ' broken'}`} key={id}>
            {c ? <FileIcon {...runTypeIcon(c.type)} /> : null}
            <span className="ref-chip-name">{c ? c.name : id}</span>
            <button
              type="button"
              className="ref-chip-x"
              title={t('run.ref.remove')}
              onClick={() => onChange(ids.filter((x) => x !== id))}
            >
              <X size={11} />
            </button>
          </span>
        )
      })}
      <span className="ref-add">
        <button type="button" className="ref-chip add" onClick={() => setOpen((v) => !v)}>
          <Plus size={11} />
          {t('run.ref.add')}
        </button>
        {open && (
          <div className="rtp-menu" role="menu">
            {targets.length === 0 ? (
              <div className="rtp-group">{t('run.ref.none')}</div>
            ) : (
              targets.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="rtp-item"
                  onClick={() => {
                    setOpen(false)
                    onChange([...ids, c.id])
                  }}
                >
                  <FileIcon {...runTypeIcon(c.type)} />
                  {c.name}
                </button>
              ))
            )}
          </div>
        )}
      </span>
    </div>
  )
}
