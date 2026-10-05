import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import { toast } from '../lib/toast'

type HfList = Awaited<ReturnType<typeof window.api.higgsfield.list>>
type HfAccountRow = HfList['accounts'][number]

/** The Higgsfield pane of the settings modal: the accounts Astera keeps, the one every agent
 *  `higgsfield` call runs under, and how to add, import, log in and remove them. The current account is
 *  shown at the top of this tab only (Astera has no app-wide status bar). */
export function HiggsfieldSettings(): React.JSX.Element {
  const { t } = useI18n()
  const [data, setData] = useState<HfList | null>(null)
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [loggingIn, setLoggingIn] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<HfAccountRow | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    try {
      setData(await window.api.higgsfield.list())
    } catch (err) {
      toast.error(String(err))
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      toast.error(String(err))
    } finally {
      setBusy(false)
    }
    await reload()
  }

  const addFrom = (how: 'add' | 'importCurrent') => async (): Promise<void> => {
    const name = label.trim()
    if (name === '') return
    await act(async () => {
      await window.api.higgsfield[how](name)
      setLabel('')
    })
  }

  const login = (a: HfAccountRow): Promise<void> =>
    act(async () => {
      setLoggingIn(a.id)
      try {
        const r = await window.api.higgsfield.login(a.id)
        if (!r.ok) toast.error(r.message ?? t('higgsfield.login'))
      } finally {
        setLoggingIn(null)
      }
    })

  const confirmRemove = async (): Promise<void> => {
    const target = removeTarget
    if (!target) return
    setRemoveTarget(null)
    await act(() => window.api.higgsfield.remove(target.id))
  }

  const current = data?.accounts.find((a) => a.current)

  return (
    <div className="settings-accounts">
      {data !== null && !data.cliFound && <span className="settings-hint">{t('higgsfield.cliMissing')}</span>}
      {current && <div className="settings-row"><span>{t('higgsfield.current', { label: current.label })}</span></div>}
      <span className="settings-hint">{t('higgsfield.hint')}</span>
      <ul>
        {data?.accounts.map((a) => (
          <li key={a.id} className="account-row">
            <span className="account-label">
              {a.label}
              {a.email ? ` · ${a.email}` : ''}
            </span>
            {a.needsLogin ? (
              <span className="badge">{t('higgsfield.needsLogin')}</span>
            ) : (
              <span className="badge ok">
                {a.credits === null ? t('higgsfield.creditsUnknown') : t('higgsfield.credits', { n: a.credits })}
              </span>
            )}
            <span className="account-row-actions">
              <button disabled={busy || a.current || a.needsLogin} onClick={() => void act(() => window.api.higgsfield.setCurrent(a.id))}>
                {t('higgsfield.use')}
              </button>
              <button disabled={busy || !data.cliFound} onClick={() => void login(a)}>
                {loggingIn === a.id ? t('higgsfield.loggingIn') : t('higgsfield.login')}
              </button>
              <button className="ghost danger" disabled={busy} onClick={() => setRemoveTarget(a)}>
                {t('higgsfield.remove')}
              </button>
            </span>
          </li>
        ))}
        {data !== null && data.accounts.length === 0 && <li className="empty">{t('higgsfield.none')}</li>}
      </ul>
      <div className="settings-row">
        <input
          type="text"
          className="settings-gen-input"
          value={label}
          placeholder={t('higgsfield.label')}
          aria-label={t('higgsfield.label')}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addFrom('add')()
          }}
        />
        <button className="primary" disabled={busy || label.trim() === ''} onClick={() => void addFrom('add')()}>
          {t('higgsfield.add')}
        </button>
        <button disabled={busy || label.trim() === ''} onClick={() => void addFrom('importCurrent')()}>
          {t('higgsfield.import')}
        </button>
      </div>
      <span className="settings-hint">{t('higgsfield.importNote')}</span>
      {removeTarget && (
        <div className="modal-backdrop" onClick={() => setRemoveTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{t('higgsfield.remove')}</h2>
            <p className="confirm-text">{t('higgsfield.removeConfirm', { label: removeTarget.label })}</p>
            <div className="row right">
              <button type="button" onClick={() => setRemoveTarget(null)}>
                {t('common.cancel')}
              </button>
              <button className="primary" type="button" onClick={() => void confirmRemove()}>
                {t('higgsfield.remove')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
