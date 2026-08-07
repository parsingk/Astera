import { useEffect, useRef, useState } from 'react'
import type { Account, Provider } from '../../../core/types'
import { PROVIDERS, PROVIDER_META, providerOf } from '../../../core/providers/meta'
import { toast } from '../lib/toast'
import { useI18n } from '../i18n/I18nProvider'
import { useAccountStatus } from '../hooks/useAccountStatus'
import { ProviderBadge } from './ProviderBadge'
import { FolderGlyph } from './FolderGlyph'
import { AccountRow } from './AccountRow'

interface DetectItem {
  configDir: string
  loggedIn: boolean
  label: string
  selected: boolean
  provider: Provider
}

/** CLI kind selector for the add and import account modals */
function ProviderPicker({
  name,
  value,
  onChange
}: {
  name: string
  value: Provider
  onChange: (p: Provider) => void
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="field">
      <label>{t('account.field.kind')}</label>
      <div className="row">
        {PROVIDERS.map((p) => (
          <label key={p} className="check-small">
            <input type="radio" name={name} checked={value === p} onChange={() => onChange(p)} />
            {PROVIDER_META[p].displayName}
          </label>
        ))}
      </div>
    </div>
  )
}

export function AccountPanel({ accounts }: { accounts: Account[] }): React.JSX.Element {
  const { t, tm } = useI18n()
  const { loginMap, emailMap, defaultIdByProvider } = useAccountStatus(accounts)
  const [addOpen, setAddOpen] = useState(false)
  const [addLabel, setAddLabel] = useState('')
  const [addCopySettings, setAddCopySettings] = useState(true)
  const [addProvider, setAddProvider] = useState<Provider>('claude')
  const [adding, setAdding] = useState(false)
  const [importDir, setImportDir] = useState<string | null>(null)
  const [importLabel, setImportLabel] = useState('')
  const [importProvider, setImportProvider] = useState<Provider>('claude')
  const [detectItems, setDetectItems] = useState<DetectItem[] | null>(null)
  const autoDetectDone = useRef(false)

  useEffect(() => {
    // "Loading finished" is not inferred from how many times the accounts prop's effect has run — under
    // React.StrictMode (main.tsx) the effect runs twice right after mount, which can produce a false
    // positive, so this queries directly to decide whether loading has finished.
    if (autoDetectDone.current) return
    autoDetectDone.current = true // set before the async query starts (guard against StrictMode double invocation)
    void window.api.accounts
      .list()
      .then((list) => {
        if (list.length === 0) void runDetect(true)
      })
      .catch(() => {
        /* Do not auto-open if the query fails */
      })
  }, [])

  const runDetect = async (isAuto: boolean): Promise<void> => {
    try {
      const candidates = await window.api.accounts.detect()
      if (isAuto && candidates.length === 0) return // the automatic trigger only opens when there are candidates
      setDetectItems(
        candidates.map((c) => ({
          configDir: c.configDir,
          loggedIn: c.loggedIn,
          label: c.suggestedLabel,
          selected: true,
          provider: c.provider
        }))
      )
    } catch (err) {
      console.warn('Account auto-detection failed', err)
      if (!isAuto)
        toast.error(
          t('account.detect.failed', { detail: err instanceof Error ? err.message : String(err) })
        )
    }
  }

  const toggleDetectItem = (idx: number): void => {
    setDetectItems((items) => items?.map((it, i) => (i === idx ? { ...it, selected: !it.selected } : it)) ?? null)
  }

  const setDetectLabel = (idx: number, label: string): void => {
    setDetectItems((items) => items?.map((it, i) => (i === idx ? { ...it, label } : it)) ?? null)
  }

  const importSelected = async (): Promise<void> => {
    if (!detectItems) return
    let failCount = 0
    for (const item of detectItems.filter((it) => it.selected)) {
      try {
        await window.api.accounts.import({
          label: item.label.trim(),
          configDir: item.configDir,
          provider: item.provider
        })
      } catch {
        failCount++
      }
    }
    setDetectItems(null)
    if (failCount > 0) toast.error(t('account.import.someFailed', { count: failCount }))
  }

  const openAdd = (): void => {
    setAddLabel('')
    setAddCopySettings(true)
    setAddProvider('claude')
    setAddOpen(true)
  }

  const submitAdd = async (): Promise<void> => {
    const label = addLabel.trim()
    if (!label) return
    if (adding) return
    setAdding(true)
    try {
      const account = await window.api.accounts.create({ label, provider: addProvider })
      // Both providers import settings now. A brand-new account is never the default (it has no
      // credentials yet), so this always copies from an existing account rather than onto itself. If that
      // provider has nothing logged in there is no source, and syncSettings reports that.
      if (addCopySettings) {
        const r = await window.api.accounts.syncSettings(account.id)
        if (!r.ok) toast.error(t('account.add.syncFailed', { detail: tm(r.message ?? null) ?? '' }))
      }
      setAddOpen(false)
    } finally {
      setAdding(false)
    }
  }

  const startImport = async (): Promise<void> => {
    const dir = await window.api.system.pickFolder()
    if (!dir) return
    // The provider is guessed from which of the two emails can be read — if it is wrong the user fixes it with the radio buttons
    const claudeEmail = await window.api.accounts.emailOfDir(dir)
    const codexEmail = claudeEmail ? null : await window.api.accounts.emailOfDir(dir, 'codex')
    setImportProvider(codexEmail ? 'codex' : 'claude')
    setImportLabel(claudeEmail ?? codexEmail ?? dir)
    setImportDir(dir)
  }

  const submitImport = async (): Promise<void> => {
    const label = importLabel.trim()
    if (!label || !importDir) return
    await window.api.accounts.import({ label, configDir: importDir, provider: importProvider })
    setImportDir(null)
  }

  return (
    <section className="account-panel">
      <header className="panel-header">
        <h2>
          {t('account.panel.title')} <span className="count">{accounts.length}</span>
        </h2>
        <div className="panel-actions">
          <button
            className="icon-btn"
            aria-label={t('account.add.button')}
            title={t('account.add.button')}
            onClick={openAdd}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <line x1="8" y1="2.5" x2="8" y2="13.5" />
              <line x1="2.5" y1="8" x2="13.5" y2="8" />
            </svg>
          </button>
          <button
            className="icon-btn"
            aria-label={t('account.import.button')}
            title={t('account.import.button')}
            onClick={() => void startImport()}
          >
            {/* This is a panel header toolbar, so it is bigger than the sidebar rows (14) — 16, the same as the +/⟳ SVGs beside it */}
            <FolderGlyph size={16} />
          </button>
          <button
            className="icon-btn"
            aria-label={t('account.detect.button')}
            title={t('account.detect.button')}
            onClick={() => void runDetect(false)}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13.4 8a5.4 5.4 0 1 1-1.5-3.8" />
              <path d="M13.6 2.6V5.2H11" />
            </svg>
          </button>
        </div>
      </header>
      <ul>
        {accounts.map((a) => (
          <AccountRow
            key={a.id}
            account={a}
            loggedIn={loginMap[a.id]}
            email={emailMap[a.id]}
            isDefault={defaultIdByProvider[providerOf(a)] === a.id}
          />
        ))}
        {accounts.length === 0 && <li className="empty">{t('account.panel.empty')}</li>}
      </ul>
      {addOpen && (
        <div className="modal-backdrop" onClick={() => setAddOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{t('account.add.title')}</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void submitAdd()
              }}
            >
              <ProviderPicker name="add-provider" value={addProvider} onChange={setAddProvider} />
              <div className="field">
                <label>{t('account.field.label')}</label>
                <input
                  autoFocus
                  type="text"
                  value={addLabel}
                  placeholder={t('account.add.labelPlaceholder')}
                  onChange={(e) => setAddLabel(e.target.value)}
                />
              </div>
              {/* Shown for both providers — claude and codex each import from their own default account */}
              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={addCopySettings}
                  onChange={(e) => setAddCopySettings(e.target.checked)}
                />
                <span>{t('account.add.copySettingsLabel')}</span>
              </label>
              {/* The login-procedure hint is per-CLI prose, so it is not folded behind a capability flag.
                  Same category as ProviderBadge's icon choice — adding a provider means writing new text. */}
              <p className="modal-hint">
                {addProvider === 'claude'
                  ? t('account.add.loginHintClaude')
                  : t('account.add.loginHintCodex')}
              </p>
              <div className="row right">
                <button type="button" onClick={() => setAddOpen(false)}>
                  {t('common.cancel')}
                </button>
                <button className="primary" type="submit" disabled={adding || !addLabel.trim()}>
                  {adding ? t('account.add.adding') : t('account.add.button')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {importDir && (
        <div className="modal-backdrop" onClick={() => setImportDir(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{t('account.import.title')}</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void submitImport()
              }}
            >
              <ProviderPicker
                name="import-provider"
                value={importProvider}
                onChange={setImportProvider}
              />
              <div className="field">
                <label>{t('account.field.label')}</label>
                <input
                  autoFocus
                  type="text"
                  value={importLabel}
                  onChange={(e) => setImportLabel(e.target.value)}
                />
              </div>
              <div className="row right">
                <button type="button" onClick={() => setImportDir(null)}>
                  {t('common.cancel')}
                </button>
                <button className="primary" type="submit" disabled={!importLabel.trim()}>
                  {t('account.import.button')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {detectItems && (
        <div className="modal-backdrop" onClick={() => setDetectItems(null)}>
          <div className="modal detect" onClick={(e) => e.stopPropagation()}>
            <h2>{t('account.detect.title')}</h2>
            {detectItems.length === 0 ? (
              <p className="empty">{t('account.detect.empty')}</p>
            ) : (
              <ul className="detect-list">
                {detectItems.map((item, idx) => (
                  <li key={item.configDir} className="detect-row">
                    <input
                      type="checkbox"
                      checked={item.selected}
                      onChange={() => toggleDetectItem(idx)}
                    />
                    <ProviderBadge provider={item.provider} />
                    <div className="detect-main">
                      <input
                        type="text"
                        value={item.label}
                        onChange={(e) => setDetectLabel(idx, e.target.value)}
                      />
                      <span className="detect-path">{item.configDir}</span>
                    </div>
                    <span className={item.loggedIn ? 'badge ok' : 'badge'}>
                      {item.loggedIn ? t('account.status.loggedIn') : t('account.status.notLoggedIn')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="row right">
              <button type="button" onClick={() => setDetectItems(null)}>
                {t('common.cancel')}
              </button>
              {detectItems.length > 0 && (
                <button
                  className="primary"
                  type="button"
                  disabled={
                    !detectItems.some((it) => it.selected) ||
                    detectItems.some((it) => it.selected && !it.label.trim())
                  }
                  onClick={() => void importSelected()}
                >
                  {t('account.detect.importSelected')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
