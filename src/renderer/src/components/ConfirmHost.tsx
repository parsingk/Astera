import { useEffect, useState } from 'react'
import { settle, subscribe, type PendingConfirm } from '../lib/confirm'
import { useI18n } from '../i18n/I18nProvider'

/** Where confirmation modals are displayed — mounted exactly once, at App's root. It only subscribes to
 *  the store (lib/confirm), so the asking side does nothing but await confirmModal(...). The cancel paths
 *  match window.confirm: ESC and a backdrop click = cancel, and since the confirm button has focus,
 *  Enter = confirm. */
export function ConfirmHost(): React.JSX.Element | null {
  const { t } = useI18n()
  const [pending, setPending] = useState<PendingConfirm | null>(null)

  useEffect(() => subscribe(setPending), [])

  useEffect(() => {
    if (!pending) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation() // keeps it from leaking to the terminal and explorer ESC handlers
      settle(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [pending])

  if (!pending) return null

  return (
    <div className="modal-backdrop" onClick={() => settle(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{pending.title}</h2>
        <p className="confirm-text confirm-body">{pending.body}</p>
        <div className="row right">
          <button type="button" onClick={() => settle(false)}>
            {pending.cancelLabel ?? t('common.cancel')}
          </button>
          <button className="primary" type="button" autoFocus onClick={() => settle(true)}>
            {pending.confirmLabel ?? t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
