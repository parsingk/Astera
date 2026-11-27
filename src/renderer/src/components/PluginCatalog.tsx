// The plugin catalog in Settings, Plugins (Phase 4, spec M3): where the catalog is and when its index was read, each
// plugin with the newest version this Astera runs and the one installed, its trust level, publisher, license, source and
// report address, and install or update through the same approval as any install. No download count or rating is
// shown: none is measured. The Host fetches, verifies and installs; this only shows and asks.
import { useEffect, useState } from 'react'
import type { MessageKey } from '../../../core/i18n'
import { CATALOG_CATEGORIES } from '../../../core/plugins/catalog'
import { useI18n } from '../i18n/I18nProvider'
import { confirmModalWithChoices } from '../lib/confirm'
import { toast } from '../lib/toast'
import { Select } from './Select'
import { failureLine, installFailureLine, installPrompt, permissionLabel, trustLabel } from './pluginsText'

type Row = Record<string, unknown>
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The plugins `query` and `category` find: by id, name or publisher, case folded. */
export function filterCatalog<T extends Row>(plugins: readonly T[], query: string, category: string): T[] {
  const q = query.trim().toLowerCase()
  return plugins.filter(
    (p) => (category === '' || p.category === category) && (q === '' || [p.id, p.name, p.publisher].some((v) => str(v).toLowerCase().includes(q)))
  )
}

export function PluginCatalogView({
  catalog,
  query,
  category,
  busy,
  onQuery,
  onCategory,
  onRefresh,
  onInstall,
  onConfigure,
  onClear
}: {
  /** The Host's `plugins-catalog` answer; null while it is read. */
  catalog: Row | null
  query: string
  category: string
  /** The plugin an install is under way for, or `refresh`, or null. */
  busy: string | null
  onQuery: (q: string) => void
  onCategory: (c: string) => void
  onRefresh: () => void
  onInstall: (id: string, version: string) => void
  onConfigure: (url: string, keys: string) => void
  onClear: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [url, setUrl] = useState('')
  const [keys, setKeys] = useState('')
  if (catalog === null) return <p className="settings-hint">{t('settings.plugins.catalog.reading')}</p>
  if (catalog.configured !== true)
    return (
      <div className="plugin-catalog">
        <p className="settings-hint">{t('settings.plugins.catalog.none')}</p>
        <div className="settings-row plugin-catalog-source">
          <input className="settings-gen-input" placeholder={t('settings.plugins.catalog.urlPlaceholder')} aria-label={t('settings.plugins.catalog.url')} value={url} onChange={(e) => setUrl(e.target.value)} />
          <input className="settings-gen-input" placeholder={t('settings.plugins.catalog.keysPlaceholder')} aria-label={t('settings.plugins.catalog.keys')} value={keys} onChange={(e) => setKeys(e.target.value)} />
          <button className="settings-gen-refresh" disabled={url.trim() === '' || keys.trim() === ''} onClick={() => onConfigure(url.trim(), keys.trim())}>
            {t('settings.plugins.catalog.save')}
          </button>
        </div>
      </div>
    )
  const plugins = (Array.isArray(catalog.plugins) ? catalog.plugins : []).filter(isRow)
  const shown = filterCatalog(plugins, query, category)
  const expired = catalog.expired === true
  const read = typeof catalog.fetchedAt === 'number' ? new Date(catalog.fetchedAt).toLocaleString() : null
  return (
    <div className="plugin-catalog">
      <div className="settings-row plugin-catalog-head">
        <span className="plugin-catalog-from">
          {read !== null && typeof catalog.sequence === 'number'
            ? t('settings.plugins.catalog.from', { url: str(catalog.url), sequence: catalog.sequence, when: read })
            : `${str(catalog.url)} · ${t('settings.plugins.catalog.notRead')}`}
        </span>
        <button className="settings-gen-refresh" disabled={busy !== null} onClick={onRefresh}>
          {busy === 'refresh' ? t('settings.plugins.catalog.refreshing') : t('settings.plugins.catalog.refresh')}
        </button>
        <button className="ghost danger" disabled={busy !== null} onClick={onClear}>
          {t('settings.plugins.catalog.clear')}
        </button>
      </div>
      {expired && <p className="settings-hint is-warning">{t('settings.plugins.catalog.expired')}</p>}
      {typeof catalog.problem === 'string' && <p className="settings-hint is-warning">{t('settings.plugins.catalog.problem', { problem: catalog.problem })}</p>}
      <div className="settings-row plugin-catalog-filter">
        <input className="settings-gen-input" placeholder={t('settings.plugins.catalog.search')} aria-label={t('settings.plugins.catalog.search')} value={query} onChange={(e) => onQuery(e.target.value)} />
        <Select
          ariaLabel={t('settings.plugins.catalog.category')}
          value={category}
          onChange={onCategory}
          items={[{ value: '', label: t('settings.plugins.catalog.allCategories') }, ...CATALOG_CATEGORIES.map((c) => ({ value: c, label: t(`settings.plugins.catalog.category.${c}` as MessageKey) }))]}
        />
      </div>
      {shown.length === 0 && <p className="settings-hint">{t('settings.plugins.catalog.empty')}</p>}
      {shown.map((p) => {
        const id = str(p.id)
        const latest = isRow(p.latest) ? p.latest : null
        const installed = isRow(p.installed) ? p.installed : null
        const canInstall = latest !== null && !expired && (installed === null || str(installed.version) !== str(latest.version))
        const fresh = strings(p.newPermissions)
        return (
          <div key={id} className="plugin-catalog-card">
            <div className="plugin-catalog-title">
              <strong>{str(p.name) || id}</strong>
              <span className="plugin-inspector-dim">{id}</span>
              <span className={`plugin-trust is-${str(p.trustLevel) === 'restricted-ui' || str(p.trustLevel) === 'declarative' ? str(p.trustLevel) : 'trusted'}`}>{trustLabel(p.trustLevel, t)}</span>
            </div>
            {str(p.description) !== '' && <p className="plugin-catalog-desc">{str(p.description)}</p>}
            <div className="plugin-catalog-facts">
              <span>{latest ? t('settings.plugins.catalog.latest', { version: str(latest.version) }) : t('settings.plugins.catalog.noVersion')}</span>
              {installed && <span>{t('settings.plugins.catalog.installedVersion', { version: str(installed.version) })}</span>}
              <span>{t('settings.plugins.catalog.publisher', { publisher: str(p.publisher) })}</span>
              {str(p.license) !== '' && <span>{t('settings.plugins.catalog.license', { license: str(p.license) })}</span>}
            </div>
            {latest && strings(latest.permissions).length > 0 && (
              <p className="plugin-catalog-perms">{t('settings.plugins.catalog.permissions', { list: strings(latest.permissions).map((x) => permissionLabel(x, t)).join(', ') })}</p>
            )}
            {latest && str(latest.releaseNotes) !== '' && <p className="plugin-catalog-notes">{str(latest.releaseNotes)}</p>}
            {str(p.sourceUrl) !== '' && <p className="plugin-catalog-link">{t('settings.plugins.catalog.source', { url: str(p.sourceUrl) })}</p>}
            {str(p.issuesUrl) !== '' && <p className="plugin-catalog-link">{t('settings.plugins.catalog.report', { url: str(p.issuesUrl) })}</p>}
            {typeof p.installedRevoked === 'string' && <p className="settings-hint is-warning">{t('settings.plugins.catalog.revoked', { reason: p.installedRevoked })}</p>}
            {fresh.length > 0 && <p className="settings-hint">{t('settings.plugins.catalog.newPermissions', { list: fresh.map((x) => permissionLabel(x, t)).join(', ') })}</p>}
            {canInstall && latest && (
              <button className="settings-gen-refresh" disabled={busy !== null} onClick={() => onInstall(id, str(latest.version))}>
                {busy === id
                  ? t('settings.plugins.installing')
                  : installed
                    ? t('settings.plugins.catalog.update', { version: str(latest.version) })
                    : t('settings.plugins.catalog.install')}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** The catalog section: reads the catalog when it opens, and installs through the approval every install has. */
export function PluginCatalog({ installed, onChanged }: { installed: Row[] | null; onChanged: () => void }): React.JSX.Element {
  const { t } = useI18n()
  const [catalog, setCatalog] = useState<Row | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const failed = (e: unknown) => ({ ok: false as const, code: 'HOST_LOST', message: e instanceof Error ? e.message : String(e) })
  const read = async (refresh: boolean): Promise<void> => {
    const r = await window.api.plugins.catalog(refresh).catch(failed)
    if (!r.ok) return void toast.error(failureLine(r, t, { read: true }))
    setCatalog(r.body)
  }
  useEffect(() => {
    void read(false)
    // read is this render's; the catalog is read once when the section opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const install = async (id: string, version: string): Promise<void> => {
    setBusy(id)
    try {
      const seen = await window.api.plugins.catalogInspect({ id, version }).catch(failed)
      if (!seen.ok) return void toast.error(failureLine(seen, t))
      const shown = seen.body
      const meta = isRow(shown.catalog) ? shown.catalog : {}
      const before = installed?.find((p) => str(p.id) === id)
      const answer = await confirmModalWithChoices(installPrompt(shown, { catalog: { publisher: str(meta.publisher), sha256: str(meta.sha256) } }, t, before))
      if (!answer.ok) return
      const r = await window.api.plugins
        .catalogInstall({ id, version: str(shown.version), grant: answer.checked, expect: { name: str(shown.id), version: str(shown.version), sha256: str(meta.sha256), ...(str(shown.trust) !== '' ? { trust: str(shown.trust) } : {}) } })
        .catch(failed)
      if (!r.ok) return void toast.error(installFailureLine(r, t))
      toast.success(t('settings.plugins.installed', { name: str(shown.displayName) || id }))
      onChanged()
      await read(false)
    } finally {
      setBusy(null)
    }
  }
  const configure = async (url: string, keysText: string): Promise<void> => {
    const keys = keysText
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k !== '')
      .map((k) => ({ id: k.slice(0, Math.max(0, k.indexOf('='))), publicKey: k.slice(k.indexOf('=') + 1) }))
    const r = await window.api.plugins.catalogConfigure({ url, keys }).catch(failed)
    if (!r.ok) return void toast.error(failureLine(r, t))
    setBusy('refresh')
    try {
      await read(true)
    } finally {
      setBusy(null)
    }
  }
  return (
    <PluginCatalogView
      catalog={catalog}
      query={query}
      category={category}
      busy={busy}
      onQuery={setQuery}
      onCategory={setCategory}
      onRefresh={() => {
        setBusy('refresh')
        void read(true).finally(() => setBusy(null))
      }}
      onInstall={(id, version) => void install(id, version)}
      onConfigure={(url, keys) => void configure(url, keys)}
      onClear={() => {
        void window.api.plugins
          .catalogConfigure({ clear: true })
          .catch(failed)
          .then(async (r) => {
            if (r.ok) await read(false)
            else toast.error(failureLine(r, t))
          })
      }}
    />
  )
}
