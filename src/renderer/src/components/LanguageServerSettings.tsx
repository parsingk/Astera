import { useEffect, useState } from 'react'
import type { MessageKey, MessageParams } from '../../../core/i18n'
import { LSP_SERVERS } from '../../../core/lsp/languages'
import type { LanguageServerSettings as Settings, LspInstalled, LspServerId, LspServerStatus } from '../../../core/lsp/model'
import { useI18n } from '../i18n/I18nProvider'
import { confirmModal } from '../lib/confirm'
import { toast } from '../lib/toast'

type T = (key: MessageKey, params?: MessageParams) => string

const errorOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const megabytes = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`

/** The install confirmation's body: where the packages go, that each is checked before it is used, and each package's
 *  name, version, licence and size (design §5 Part 3: the person approves name, version, licence, size and place). */
export function installConfirmBody(t: T, row: LspInstalled): string {
  const lines = row.packages.map((p) => t('lsp.installConfirm.package', { name: p.name, version: p.version, licence: p.licence, size: megabytes(p.bytes) }))
  return `${t('lsp.installConfirm.body', { folder: row.folder })}\n\n${lines.join('\n')}`
}

const STATUS_KEY: Record<LspServerStatus['status'], MessageKey> = {
  starting: 'lsp.status.starting',
  running: 'lsp.status.running',
  stopped: 'lsp.status.stopped',
  failed: 'lsp.status.failed'
}

/** One server: whether it is installed (and its version), Install or Remove, and each root it runs for with its state,
 *  why it stopped, its notes and its log. */
export function ServerRow({
  installed,
  statuses,
  busy,
  onInstall,
  onRemove,
  onLog,
  logs
}: {
  installed: LspInstalled
  statuses: LspServerStatus[]
  busy: boolean
  onInstall(): void
  onRemove(): void
  onLog(root: string): void
  logs: Record<string, string[] | undefined>
}): React.JSX.Element {
  const { t } = useI18n()
  const version = installed.packages.map((p) => `${p.name} ${p.version}`).join(', ')
  return (
    <div className="lsp-server">
      <div className="settings-row">
        <span>{LSP_SERVERS[installed.server].title}</span>
        <span className="settings-hint">
          {!installed.available ? t('lsp.unavailable') : installed.installed ? t('lsp.installed', { version }) : t('lsp.notInstalled')}
        </span>
        {installed.available && !installed.installed && (
          <button type="button" disabled={busy} onClick={onInstall}>
            {busy ? t('lsp.installing') : t('lsp.install')}
          </button>
        )}
        {installed.installed && (
          <button type="button" disabled={busy} onClick={onRemove}>
            {t('lsp.remove')}
          </button>
        )}
      </div>
      {statuses.map((s) => (
        <div key={s.root} className="lsp-server-root">
          <div className="settings-row">
            <span className="lsp-root">{s.root}</span>
            <span>{t(STATUS_KEY[s.status])}</span>
            <button type="button" onClick={() => onLog(s.root)}>
              {t('lsp.log')}
            </button>
          </div>
          {s.why !== undefined && <span className="settings-hint is-warning">{t(`lsp.why.${s.why}` as MessageKey)}</span>}
          {s.reason !== undefined && <span className="settings-hint">{s.reason}</span>}
          {(s.notes ?? []).map((n) => (
            <span key={n} className="settings-hint">
              {t(`lsp.note.${n}` as MessageKey)}
            </span>
          ))}
          {logs[s.root] !== undefined && <pre className="lsp-log">{logs[s.root]!.length > 0 ? logs[s.root]!.join('\n') : t('lsp.logEmpty')}</pre>}
        </div>
      ))}
    </div>
  )
}

/**
 * Settings › 언어 서버 (Phase 3 Part 3): each server Astera can install (after the person approves its packages), the
 * roots it runs for and its log; each language on or off; the paths that replace Astera's install; pyright's interpreter;
 * and, for the explorer's project, whether pyright may use the virtual environment found in it.
 */
export function LanguageServerSettings({ project }: { project: string | null }): React.JSX.Element {
  const { t } = useI18n()
  const [installed, setInstalled] = useState<LspInstalled[] | null>(null)
  const [servers, setServers] = useState<LspServerStatus[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [drafts, setDrafts] = useState({ typescript: '', python: '', interpreter: '' })
  const [venv, setVenv] = useState<string | null>(null)
  const [busy, setBusy] = useState<LspServerId | null>(null)
  const [logs, setLogs] = useState<Record<string, Record<string, string[] | undefined>>>({})
  const [loadError, setLoadError] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    try {
      const s = await window.api.lsp.status()
      setInstalled(s.installed)
      setServers(s.servers)
      setLoadError(null)
    } catch (e) {
      setLoadError(errorOf(e))
    }
  }

  useEffect(() => {
    void refresh()
    window.api.settings.getLanguageServers().then(
      (s) => {
        setSettings(s)
        setDrafts({ typescript: s.typescript.path ?? '', python: s.python.path ?? '', interpreter: s.python.interpreter ?? '' })
      },
      (e: unknown) => setLoadError(errorOf(e))
    )
    return window.api.on('lsp:state', (s) => setServers(s))
  }, [])

  useEffect(() => {
    if (project === null) {
      setVenv(null)
      return
    }
    window.api.lsp.venvFor(project).then(setVenv, () => setVenv(null))
  }, [project])

  const save = async (next: Settings): Promise<void> => {
    try {
      await window.api.settings.setLanguageServers(next)
      setSettings(next)
    } catch (e) {
      toast.error(t('lsp.saveFailed', { error: errorOf(e) }))
    }
  }

  const install = async (row: LspInstalled): Promise<void> => {
    const title = LSP_SERVERS[row.server].title
    if (!(await confirmModal({ title: t('lsp.installConfirm.title', { title }), body: installConfirmBody(t, row), confirmLabel: t('lsp.install') }))) return
    setBusy(row.server)
    try {
      await window.api.lsp.install(row.server)
      toast.success(t('lsp.installDone', { title }))
    } catch (e) {
      toast.error(t('lsp.installFailed', { title, error: errorOf(e) }))
    } finally {
      setBusy(null)
      await refresh()
    }
  }

  const remove = async (row: LspInstalled): Promise<void> => {
    const title = LSP_SERVERS[row.server].title
    if (!(await confirmModal({ title: t('lsp.removeConfirm.title', { title }), body: t('lsp.removeConfirm.body'), confirmLabel: t('lsp.remove') }))) return
    setBusy(row.server)
    try {
      await window.api.lsp.remove(row.server)
    } catch (e) {
      toast.error(t('lsp.removeFailed', { title, error: errorOf(e) }))
    } finally {
      setBusy(null)
      await refresh()
    }
  }

  const showLog = async (server: LspServerId, root: string): Promise<void> => {
    try {
      const { lines } = await window.api.lsp.log(server, root)
      setLogs((prev) => ({ ...prev, [server]: { ...prev[server], [root]: lines } }))
    } catch (e) {
      toast.error(t('lsp.loadFailed', { error: errorOf(e) }))
    }
  }

  const useVenv = (use: boolean): void => {
    if (settings === null || project === null) return
    const s = settings
    void save({
      ...s,
      python: { ...s.python, venvProjects: use ? [...s.python.venvProjects, project] : s.python.venvProjects.filter((p) => p !== project) }
    })
  }
  const venvAllowed = settings !== null && project !== null && settings.python.venvProjects.includes(project)

  const pathField = (language: 'typescript' | 'python', key: 'typescript' | 'python' | 'interpreter', label: MessageKey): React.JSX.Element => (
    <div className="settings-row">
      <span>{t(label)}</span>
      <input
        type="text"
        className="settings-gen-input"
        value={drafts[key]}
        spellCheck={false}
        onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
        onBlur={() => {
          if (settings === null) return
          const value = drafts[key].trim()
          const field = key === 'interpreter' ? 'interpreter' : 'path'
          const lang = { ...settings[language] } as Record<string, unknown>
          if (value === '') delete lang[field]
          else lang[field] = value
          if ((settings[language] as Record<string, unknown>)[field] === lang[field]) return
          void save({ ...settings, [language]: lang } as Settings)
        }}
      />
    </div>
  )

  return (
    <>
      <span className="settings-hint">{t('lsp.hint')}</span>
      {loadError !== null && <span className="settings-hint is-warning">{t('lsp.loadFailed', { error: loadError })}</span>}
      {(installed ?? []).map((row) => (
        <ServerRow
          key={row.server}
          installed={row}
          statuses={servers.filter((s) => s.server === row.server)}
          busy={busy === row.server}
          onInstall={() => void install(row)}
          onRemove={() => void remove(row)}
          onLog={(root) => void showLog(row.server, root)}
          logs={logs[row.server] ?? {}}
        />
      ))}
      {settings !== null && (
        <>
          {(['typescript', 'python'] as const).map((language) => (
            <label key={language} className="settings-row">
              <span>{t(`lsp.language.${language}` as MessageKey)}</span>
              <input type="checkbox" checked={settings[language].enabled} onChange={(e) => void save({ ...settings, [language]: { ...settings[language], enabled: e.target.checked } })} />
            </label>
          ))}
          {pathField('typescript', 'typescript', 'lsp.path.typescript')}
          {pathField('python', 'python', 'lsp.path.python')}
          <span className="settings-hint">{t('lsp.path.hint')}</span>
          {pathField('python', 'interpreter', 'lsp.interpreter')}
          <span className="settings-hint">{t('lsp.interpreter.hint')}</span>
          {venv !== null && (
            <div className="settings-row">
              <span>{t('lsp.venv.found', { path: venv })}</span>
              <button type="button" onClick={() => useVenv(!venvAllowed)}>
                {venvAllowed ? t('lsp.venv.stop') : t('lsp.venv.use')}
              </button>
            </div>
          )}
        </>
      )}
    </>
  )
}
