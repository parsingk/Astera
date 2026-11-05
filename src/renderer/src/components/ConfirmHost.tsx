import { Fragment, useEffect, useState } from 'react'
import { settle, subscribe, type PendingConfirm } from '../lib/confirm'
import { useI18n } from '../i18n/I18nProvider'
import { backdropProps } from '../lib/backdrop'

/** Where confirmation modals are displayed — mounted exactly once, at App's root. It only subscribes to
 *  the store (lib/confirm), so the asking side does nothing but await confirmModal(...). The cancel paths
 *  match window.confirm: ESC and a backdrop click = cancel, and since the confirm button has focus,
 *  Enter = confirm, except in one that shows a command, where Cancel has focus. */
export function ConfirmHost(): React.JSX.Element | null {
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

  return <ConfirmView pending={pending} checked={checked} onChecked={setChecked} />
}

/** The modal itself, apart from the store so it is tested as markup: title, body, choices, footer, buttons. */
export function ConfirmView({
  pending,
  checked,
  onChecked
}: {
  pending: PendingConfirm
  checked: string[]
  onChecked: (update: (prev: string[]) => string[]) => void
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="modal-backdrop" {...backdropProps(() => settle(false))}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{pending.title}</h2>
        <p className="confirm-text confirm-body">{pending.body}</p>
        {pending.code !== undefined && <pre className="confirm-code">{pending.code}</pre>}
        {/* 곁가지 선택. 되돌릴 수 없는 동작에 딸린 결정을 이 자리에서 받는다 — 확인 창을 닫고 다른
            곳에서 다시 묻게 하면 사람이 무엇을 고른 채로 지웠는지 알 수 없다 */}
        {pending.choices && pending.choices.length > 0 && (
          <div className="confirm-choices">
            {pending.choices.map((c, i) => {
              // A group's name is drawn once, above its first choice, with a rule before every group but the first
              const startsGroup = c.group !== undefined && (i === 0 || pending.choices?.[i - 1]?.group !== c.group)
              return (
                <Fragment key={c.id}>
                  {startsGroup && i > 0 && <hr className="confirm-choices-rule" />}
                  {startsGroup && <span className="confirm-choices-group">{c.group}</span>}
                  <label className="check-small">
                    <input
                      type="checkbox"
                      checked={checked.includes(c.id)}
                      onChange={(e) =>
                        onChecked((prev) =>
                          e.target.checked ? [...prev, c.id] : prev.filter((x) => x !== c.id)
                        )
                      }
                    />
                    <span>
                      {c.label}
                      {c.hint && <span className="confirm-choice-hint">{c.hint}</span>}
                    </span>
                  </label>
                </Fragment>
              )
            })}
          </div>
        )}
        {/* Read last, after the choices: the plugin install warning's trust sentence (spec §31). */}
        {pending.footer !== undefined && pending.footer !== '' && <p className="confirm-text confirm-body">{pending.footer}</p>}
        {/* A confirmation that shows a command can open without a click (a plugin job asking, Claude plugin sharing §5.4),
            so Cancel has focus there and a stray Enter does not run the command */}
        <div className="row right">
          <button type="button" autoFocus={pending.code !== undefined} onClick={() => settle(false)}>
            {pending.cancelLabel ?? t('common.cancel')}
          </button>
          <button className="primary" type="button" autoFocus={pending.code === undefined} onClick={() => settle(true, checked)}>
            {pending.confirmLabel ?? t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
