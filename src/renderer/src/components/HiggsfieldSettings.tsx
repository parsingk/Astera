import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import { toast } from '../lib/toast'
import { hfAccountTitle, hfWorkspaceLabel } from '../../../core/higgsfield/display'

type HfList = Awaited<ReturnType<typeof window.api.higgsfield.list>>
type HfAccountRow = HfList['accounts'][number]
type HfLoginState = Awaited<ReturnType<typeof window.api.higgsfield.loginState>>

/** The Higgsfield pane of the settings modal: the accounts Astera keeps, the one every agent
 *  `higgsfield` call runs under, and how to add, import, log in and remove them. The current account is
 *  shown at the top of this tab only (Astera has no app-wide status bar). A login runs alongside the
 *  other buttons: its row offers the login link to copy (for a private window) and a cancel. */
export function HiggsfieldSettings(): React.JSX.Element {
  const { t } = useI18n()
  const [data, setData] = useState<HfList | null>(null)
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [login, setLogin] = useState<HfLoginState>(null)
  // true while this pane awaits login(): its answer reloads the list. A login found running when the
  // pane opened is followed by polling alone.
  const awaitingLogin = useRef(false)
  const [removeTarget, setRemoveTarget] = useState<HfAccountRow | null>(null)
  // The workspace chosen in each row's picker (account id -> workspace id); the first one until changed.
  const [picked, setPicked] = useState<Record<string, string>>({})

  const reload = useCallback(async (): Promise<void> => {
    try {
      setData(await window.api.higgsfield.list())
    } catch (err) {
      toast.error(String(err))
    }
  }, [])

  useEffect(() => {
    void reload()
    window.api.higgsfield.loginState().then((s) => { if (s) setLogin(s) }, () => {})
  }, [reload])

  const loginId = login?.id ?? null
  useEffect(() => {
    if (loginId === null) return
    const timer = setInterval(() => {
      window.api.higgsfield.loginState().then((s) => {
        if (s) setLogin(s)
        else if (!awaitingLogin.current) {
          setLogin(null)
          void reload()
        }
      }, () => {})
    }, 1000)
    return () => clearInterval(timer)
  }, [loginId, reload])

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

  // Not through act(): the other buttons stay usable while the browser is open.
  const startLogin = async (a: HfAccountRow): Promise<void> => {
    if (login !== null || awaitingLogin.current) return
    awaitingLogin.current = true
    setLogin({ id: a.id, url: null })
    try {
      const r = await window.api.higgsfield.login(a.id)
      if (r.reason === 'timeout') toast.error(t('higgsfield.loginTimeout'))
      else if (!r.ok && r.reason !== 'cancelled') toast.error(r.message ?? t('higgsfield.loginFailed'))
    } catch (err) {
      toast.error(String(err))
    } finally {
      awaitingLogin.current = false
      setLogin(null)
    }
    await reload()
  }

  const cancelLogin = async (): Promise<void> => {
    try {
      await window.api.higgsfield.cancelLogin()
    } catch (err) {
      toast.error(String(err))
    }
    // A login this pane did not start: nothing else will put the row back.
    if (!awaitingLogin.current) {
      setLogin(null)
      await reload()
    }
  }

  const copyLoginUrl = async (url: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url)
      toast.success(t('higgsfield.urlCopied'))
    } catch (err) {
      toast.error(String(err))
    }
  }

  const confirmRemove = async (): Promise<void> => {
    const target = removeTarget
    if (!target) return
    setRemoveTarget(null)
    await act(() => window.api.higgsfield.remove(target.id))
  }

  const current = data?.accounts.find((a) => a.current)
  // From the list too: a login started before this pane opened shows before the first poll answers.
  const loggingInId = loginId ?? data?.accounts.find((a) => a.loggingIn)?.id ?? null

  return (
    <div className="settings-accounts">
      {data?.cliIssue && (
        <div className="settings-warn-box" role="alert">{t('higgsfield.binaryMissing', { path: data.cliIssue.path })}</div>
      )}
      {data !== null && !data.cliFound && <span className="settings-hint">{t('higgsfield.cliMissing')}</span>}
      {current && <div className="settings-field-label">{t('higgsfield.current', { label: current.label })}</div>}
      <span className="settings-hint">{t('higgsfield.hint')}</span>
      <ul>
        {data?.accounts.map((a) => {
          const isLoggingIn = loggingInId === a.id
          const url = isLoggingIn ? login?.url ?? null : null
          return (
            <li key={a.id} className="account-row">
              <span className="account-label">{hfAccountTitle(a.label, a.email)}</span>
              {isLoggingIn ? (
                <span className="badge">{t('higgsfield.loggingIn')}</span>
              ) : a.needsLogin ? (
                <span className="badge">{t('higgsfield.needsLogin')}</span>
              ) : a.needsWorkspace ? (
                <span className="badge">{t('higgsfield.needsWorkspace')}</span>
              ) : (
                <span className="badge ok">
                  {a.credits === null ? t('higgsfield.creditsUnknown') : t('higgsfield.credits', { n: a.credits })}
                </span>
              )}
              <span className="account-row-actions">
                <button disabled={busy || a.current || a.needsLogin} onClick={() => void act(() => window.api.higgsfield.setCurrent(a.id))}>
                  {t('higgsfield.use')}
                </button>
                {isLoggingIn ? (
                  <>
                    <button disabled={url === null} onClick={() => { if (url !== null) void copyLoginUrl(url) }}>
                      {t('higgsfield.copyUrl')}
                    </button>
                    <button onClick={() => void cancelLogin()}>{t('higgsfield.cancelLogin')}</button>
                  </>
                ) : (
                  <button
                    disabled={busy || !data.cliFound || data.cliIssue !== null || loggingInId !== null}
                    onClick={() => void startLogin(a)}
                  >
                    {t('higgsfield.login')}
                  </button>
                )}
                <button className="ghost danger" disabled={busy || isLoggingIn} onClick={() => setRemoveTarget(a)}>
                  {t('higgsfield.remove')}
                </button>
              </span>
              {isLoggingIn && <span className="settings-hint account-row-hint">{t('higgsfield.loginHint')}</span>}
              {!isLoggingIn && a.needsWorkspace && (a.workspaces?.length ?? 0) > 0 && (
                <span className="account-row-hint account-row-actions">
                  <select
                    aria-label={t('higgsfield.workspace')}
                    value={picked[a.id] ?? a.workspaces![0].id}
                    onChange={(e) => setPicked((p) => ({ ...p, [a.id]: e.target.value }))}
                  >
                    {a.workspaces!.map((w) => (
                      <option key={w.id} value={w.id}>{hfWorkspaceLabel(w, (n) => t('higgsfield.credits', { n }))}</option>
                    ))}
                  </select>
                  <button
                    disabled={busy}
                    onClick={() => void act(() => window.api.higgsfield.setWorkspace(a.id, picked[a.id] ?? a.workspaces![0].id))}
                  >
                    {t('higgsfield.pickWorkspace')}
                  </button>
                </span>
              )}
            </li>
          )
        })}
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
