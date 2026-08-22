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
  /** 켜진 choice 의 id 들. 창이 바뀌면 초기화한다 — 남겨 두면 다음 확인 창이 앞의 선택을 물려받는다 */
  const [checked, setChecked] = useState<string[]>([])

  useEffect(
    () =>
      subscribe((next) => {
        setPending(next)
        setChecked((next?.choices ?? []).filter((c) => c.defaultChecked).map((c) => c.id))
      }),
    []
  )

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
        {/* 곁가지 선택. 되돌릴 수 없는 동작에 딸린 결정을 이 자리에서 받는다 — 확인 창을 닫고 다른
            곳에서 다시 묻게 하면 사람이 무엇을 고른 채로 지웠는지 알 수 없다 */}
        {pending.choices && pending.choices.length > 0 && (
          <div className="confirm-choices">
            {pending.choices.map((c) => (
              <label key={c.id} className="check-small">
                <input
                  type="checkbox"
                  checked={checked.includes(c.id)}
                  onChange={(e) =>
                    setChecked((prev) =>
                      e.target.checked ? [...prev, c.id] : prev.filter((x) => x !== c.id)
                    )
                  }
                />
                <span>
                  {c.label}
                  {c.hint && <span className="confirm-choice-hint">{c.hint}</span>}
                </span>
              </label>
            ))}
          </div>
        )}
        <div className="row right">
          <button type="button" onClick={() => settle(false)}>
            {pending.cancelLabel ?? t('common.cancel')}
          </button>
          <button className="primary" type="button" autoFocus onClick={() => settle(true, checked)}>
            {pending.confirmLabel ?? t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
