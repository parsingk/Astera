import { useEffect, useState } from 'react'
import { dismiss, subscribe, type Toast } from '../lib/toast'
import { useI18n } from '../i18n/I18nProvider'

/** Where toasts are displayed — mounted exactly once, at App's root. It only subscribes to the store
 *  (lib/toast), so whoever wants to notify just calls toast.error(...) from anywhere. */
export function ToastHost(): React.JSX.Element | null {
  const { t } = useI18n()
  const [items, setItems] = useState<Toast[]>([])

  useEffect(() => subscribe(setItems), [])

  if (items.length === 0) return null

  return (
    <div className="toast-host" role="status" aria-live="polite">
      {items.map((item) => (
        <div key={item.id} className={`toast ${item.kind}`}>
          <span className="toast-msg">{item.message}</span>
          {/* Only a toast with an action gets the button. An action toast does not auto-dismiss, so the ✕
              stays — there has to be a way to ignore it and close. */}
          {item.action && (
            <button className="toast-action" type="button" onClick={item.action.onClick}>
              {item.action.label}
            </button>
          )}
          <button
            className="icon-btn toast-close"
            type="button"
            aria-label={t('common.toastDismiss')}
            title={t('common.close')}
            onClick={() => dismiss(item.id)}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
              <line x1="2.5" y1="2.5" x2="9.5" y2="9.5" />
              <line x1="9.5" y1="2.5" x2="2.5" y2="9.5" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  )
}
