import { useEffect, useMemo, useRef, useState } from 'react'
import type { PluginSource, PluginsCallAnswer } from '../../../core/types'
import type { SettingField } from '../../../core/plugins/settings'
import { useI18n } from '../i18n/I18nProvider'
import { toast } from '../lib/toast'
import { confirmModal, confirmModalWithChoices } from '../lib/confirm'
import { Select } from './Select'
import { configureChanges, configureDoneLine, failureLine, installFailureLine, installPrompt, npmNotice, permissionLabel, reasonLine, statusLabel } from './pluginsText'
import { createPluginsPoller, installBlocked, installHolds, keepOnly } from './pluginsList'

type Plugin = Record<string, unknown>
type Shown = { fields: SettingField[]; values: Record<string, unknown>; secrets: Record<string, unknown> }
type Draft = Record<string, string | boolean>
type Failure = Extract<PluginsCallAnswer, { ok: false }>

/** How often the list is read while the tab is open: a plugin's status (starting, a crash, failed) has no event yet. */
const LIST_EVERY_MS = 3_000
const LOG_LINES = 200

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const shownOf = (body: Record<string, unknown>): Shown => ({
  fields: Array.isArray(body.fields) ? (body.fields as SettingField[]) : [],
  values: isObject(body.values) ? body.values : {},
  secrets: isObject(body.secrets) ? body.secrets : {}
})
/** A call that threw (main gone, an IPC error) answers like one the Host refused, so every path says why. */
const failed = (e: unknown): PluginsCallAnswer => ({ ok: false, code: 'FAILED', message: e instanceof Error ? e.message : String(e) })
const without = <V,>(o: Record<string, V>, key: string): Record<string, V> => {
  if (!Object.hasOwn(o, key)) return o
  const next = { ...o }
  delete next[key]
  return next
}

/** Settings › Plugins (plugin runtime design slice 2d, spec §30-31): the installed plugins, each with its status,
 *  version, capabilities and granted permissions, and Configure, Enable or Disable, Logs and Remove; installing a
 *  folder after the trust warning. Every check is the Host's: this shows what it answers. */
export function PluginsSettings(): React.JSX.Element {
  const { t } = useI18n()
  const [plugins, setPlugins] = useState<Plugin[] | null>(null)
  /** Why the last list could not be read; the list before it stays (review focus 1). */
  const [listFailure, setListFailure] = useState<Failure | null>(null)
  /** The install button's state: a folder being read and shown, or the install itself. */
  const [installing, setInstalling] = useState<'idle' | 'reading' | 'installing'>('idle')
  /** What the install in flight reads from, so the button it came from says what it is doing. */
  const [installingFrom, setInstallingFrom] = useState<'folder' | 'npm'>('folder')
  /** Plugins with a change in flight. */
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [open, setOpen] = useState<Record<string, 'settings' | 'logs'>>({})
  const [shown, setShown] = useState<Record<string, Shown>>({})
  /** What the person typed, by plugin: kept across the list's refreshes until it is saved (review focus 5). */
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [clears, setClears] = useState<Record<string, ReadonlySet<string>>>({})
  const [logs, setLogs] = useState<Record<string, string[]>>({})
  const [saving, setSaving] = useState<string | null>(null)
  /** An npm package to install, as the person types it (plugins 2e). */
  const [npmSpec, setNpmSpec] = useState('')
  /** Why npm itself could not be had (a blocking network, an altered download), kept under the package row until an
   *  install from npm works (plugins 2e-2; the user's decision 2026-10-13). */
  const [npmProblem, setNpmProblem] = useState<string | null>(null)

  /** Changes in flight (installs, saves, enables, removals): the list is not polled meanwhile (2d final review I1). */
  const inFlight = useRef(0)
  const during = async <R,>(work: () => Promise<R>): Promise<R> => {
    inFlight.current += 1
    try {
      return await work()
    } finally {
      inFlight.current -= 1
    }
  }
  /** Everything the tab keeps about one plugin: dropped when it goes, or when a new copy of it comes (M3). */
  const forget = (id: string): void => {
    setOpen((o) => without(o, id))
    setShown((s) => without(s, id))
    setDrafts((d) => without(d, id))
    setClears((c) => without(c, id))
    setLogs((l) => without(l, id))
  }
  const poller = useMemo(
    () =>
      createPluginsPoller({
        read: () => window.api.plugins.list().catch(failed),
        onList: (listed) => {
          setListFailure(null)
          setPlugins(listed)
          // A plugin removed from elsewhere (the CLI) takes its form, typing and log with it (M3).
          const ids = new Set(listed.map((p) => str(p.id)))
          setOpen((o) => keepOnly(o, ids))
          setShown((s) => keepOnly(s, ids))
          setDrafts((d) => keepOnly(d, ids))
          setClears((c) => keepOnly(c, ids))
          setLogs((l) => keepOnly(l, ids))
        },
        onFailure: setListFailure,
        busy: () => inFlight.current > 0,
        everyMs: LIST_EVERY_MS
      }),
    []
  )
  useEffect(() => poller.start(), [poller])
  const reload = (): void => void poller.now()

  const installFolder = async (): Promise<void> => {
    if (installing !== 'idle') return
    const folder = await window.api.system.pickFolder()
    if (folder) await install({ path: folder })
  }
  const installNpm = async (): Promise<void> => {
    if (installing !== 'idle' || npmSpec.trim() === '') return
    if (await install({ npm: npmSpec.trim() })) setNpmSpec('')
  }

  /** Shows what `source` holds and asks, then installs it; says whether it was installed. */
  const install = async (source: PluginSource): Promise<boolean> => {
    setInstalling('reading')
    setInstallingFrom('path' in source ? 'folder' : 'npm')
    try {
      // In flight like a change: an npm inspect downloads, and the list would wait behind it (2e final review I4).
      const seen = await during(() => window.api.plugins.inspect(source).catch(failed))
      if (!seen.ok) {
        toast.error(failureLine(seen, t, { read: true }))
        if (npmNotice(seen)) setNpmProblem(failureLine(seen, t))
        return false
      }
      if ('npm' in source) setNpmProblem(null)
      const id = str(seen.body.id)
      // On an update, what the installed copy was granted (I2).
      const before = plugins?.find((p) => str(p.id) === id)
      const answer = await confirmModalWithChoices(installPrompt(seen.body, 'path' in source ? source.path : source, t, before))
      if (!answer.ok) return false
      setInstalling('installing')
      // What was shown is what the Host checks the copy against (design P6), and from npm the version it fetches.
      const r = await during(() =>
        window.api.plugins.install({ ...source, grant: answer.checked, expect: { name: str(seen.body.name), version: str(seen.body.version) } }).catch(failed)
      )
      if (!r.ok) {
        toast.error(installFailureLine(r, t))
        if (npmNotice(r)) setNpmProblem(failureLine(r, t))
        return false
      }
      // A new copy may have a new schema: a form or log of the old one goes (M3).
      forget(id)
      toast.success(t('settings.plugins.installed', { name: str(seen.body.displayName) || id }))
      return true
    } finally {
      setInstalling('idle')
      reload()
    }
  }

  /** One change to one plugin at a time, then the list again. */
  const change = async (id: string, work: () => Promise<PluginsCallAnswer>, done?: (body: Record<string, unknown>) => void): Promise<void> => {
    if (busy.has(id)) return
    setBusy((s) => new Set(s).add(id))
    try {
      const r = await during(() => work().catch(failed))
      if (!r.ok) toast.error(failureLine(r, t))
      else done?.(r.body)
    } finally {
      setBusy((s) => {
        const next = new Set(s)
        next.delete(id)
        return next
      })
      reload()
    }
  }

  const remove = async (p: Plugin): Promise<void> => {
    const id = str(p.id)
    const name = str(p.displayName) || id
    const ok = await confirmModal({ title: t('settings.plugins.remove.title', { name }), body: t('settings.plugins.remove.body'), confirmLabel: t('settings.plugins.remove') })
    if (!ok) return
    await change(
      id,
      () => window.api.plugins.remove(id),
      (body) => {
        if (typeof body.warning === 'string') toast.error(t('settings.plugins.remove.left', { name, warning: body.warning }))
        else toast.success(t('settings.plugins.remove.done', { name }))
        forget(id)
      }
    )
  }

  const readShown = async (id: string): Promise<void> => {
    const r = await window.api.plugins.settings(id).catch(failed)
    if (!r.ok) {
      toast.error(failureLine(r, t, { read: true }))
      return setOpen((o) => without(o, id))
    }
    setShown((s) => ({ ...s, [id]: shownOf(r.body) }))
  }
  const readLogs = async (id: string): Promise<void> => {
    const r = await window.api.plugins.logs(id, LOG_LINES).catch(failed)
    if (!r.ok) return void toast.error(failureLine(r, t, { read: true }))
    setLogs((l) => ({ ...l, [id]: list(r.body.lines) }))
  }
  const toggleOpen = (id: string, what: 'settings' | 'logs'): void => {
    if (open[id] === what) return setOpen((o) => without(o, id))
    setOpen((o) => ({ ...o, [id]: what }))
    void (what === 'settings' ? readShown(id) : readLogs(id))
  }

  const save = async (id: string): Promise<void> => {
    const view = shown[id]
    const changes = view ? configureChanges(view.fields, view, drafts[id] ?? {}, clears[id] ?? new Set()) : null
    if (!changes || saving !== null) return
    setSaving(id)
    try {
      const r = await during(() => window.api.plugins.configure(id, changes.set, changes.unset).catch(failed))
      // A refusal keeps what was typed, so the person can correct it.
      if (!r.ok) return void toast.error(failureLine(r, t))
      toast.success(configureDoneLine(r.body, t))
      setShown((s) => ({ ...s, [id]: shownOf(r.body) }))
      setDrafts((d) => without(d, id))
      setClears((c) => without(c, id))
    } finally {
      setSaving(null)
      reload()
    }
  }

  return (
    <div className="settings-stack">
      <p className="settings-hint">{t('settings.plugins.hint')}</p>
      <p className="settings-hint">{t('settings.extensions.pluginsLink')}</p>
      <div className="remote-actions">
        {/* Nothing to install into with no Host, or one that runs no plugins (M5). */}
        <button className="primary" disabled={installing !== 'idle' || installBlocked(listFailure?.code ?? null)} onClick={() => void installFolder()}>
          {installing === 'installing' && installingFrom === 'folder' ? t('settings.plugins.installing') : t('settings.plugins.installFolder')}
        </button>
      </div>
      {/* A plugin published on npm (plugins 2e): the person's npm fetches it, or Astera's own where they have none
          (2e-2), after the same warning. */}
      <div className="remote-actions">
        <input
          className="settings-gen-input remote-actions-grow"
          aria-label={t('settings.plugins.installNpm')}
          placeholder={t('settings.plugins.npmPlaceholder')}
          value={npmSpec}
          spellCheck={false}
          autoComplete="off"
          disabled={installing !== 'idle'}
          onChange={(e) => setNpmSpec(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void installNpm()
          }}
        />
        <button
          className="settings-gen-refresh"
          disabled={installing !== 'idle' || npmSpec.trim() === '' || installBlocked(listFailure?.code ?? null)}
          onClick={() => void installNpm()}
        >
          {installingFrom !== 'npm' || installing === 'idle'
            ? t('settings.plugins.installNpm')
            : installing === 'reading'
              ? t('settings.plugins.fetching')
              : t('settings.plugins.installing')}
        </button>
      </div>
      <p className="settings-hint">{t('settings.plugins.npmHint')}</p>
      {npmProblem !== null && <p className="settings-hint is-warning">{npmProblem}</p>}
      {listFailure !== null && <p className="settings-hint is-warning">{failureLine(listFailure, t, { read: true })}</p>}
      {plugins !== null && plugins.length === 0 && <p className="settings-hint">{t('settings.plugins.none')}</p>}
      {plugins?.map((p) => {
        const id = str(p.id)
        const view = shown[id]
        return (
          <div key={id} className="settings-group plugin-card">
            <PluginCard
              plugin={p}
              // During an install, from the read on, every plugin call waits behind it in the Host, so every card waits too
              // (2d I1, 2e I4).
              busy={busy.has(id) || installHolds(installing)}
              onConfigure={() => toggleOpen(id, 'settings')}
              onToggle={(enabled) => void change(id, () => window.api.plugins.setEnabled(id, enabled))}
              onStartAgain={() => void change(id, () => window.api.plugins.setEnabled(id, true))}
              onRemove={() => void remove(p)}
              onLogs={() => toggleOpen(id, 'logs')}
            />
            {open[id] === 'settings' && view && (
              <PluginSettingsForm
                fields={view.fields}
                values={view.values}
                secrets={view.secrets}
                draft={drafts[id] ?? {}}
                clear={clears[id] ?? new Set()}
                onDraft={(key, v) => setDrafts((d) => ({ ...d, [id]: { ...(d[id] ?? {}), [key]: v } }))}
                onClear={(key, on) =>
                  setClears((c) => {
                    const next = new Set(c[id] ?? [])
                    if (on) next.add(key)
                    else next.delete(key)
                    return { ...c, [id]: next }
                  })
                }
                onSave={() => void save(id)}
                saving={saving === id}
                changed={configureChanges(view.fields, view, drafts[id] ?? {}, clears[id] ?? new Set()) !== null}
              />
            )}
            {open[id] === 'logs' && <PluginLogs lines={logs[id] ?? null} onRefresh={() => void readLogs(id)} />}
          </div>
        )
      })}
    </div>
  )
}

/** One installed plugin as spec §30 draws it. */
export function PluginCard({
  plugin,
  busy,
  onConfigure,
  onToggle,
  onStartAgain,
  onRemove,
  onLogs
}: {
  plugin: Record<string, unknown>
  /** A change to it, or an install, is in flight: its buttons wait, Logs too, since a read would wait behind it. */
  busy: boolean
  onConfigure: () => void
  onToggle: (enabled: boolean) => void
  /** A failed plugin stays failed until it is enabled again (design P11). */
  onStartAgain: () => void
  onRemove: () => void
  onLogs: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const id = str(plugin.id)
  const status = str(plugin.status)
  const enabled = plugin.enabled === true
  const capabilities = list(plugin.capabilities)
  const permissions = list(plugin.permissions)
  const reason = str(plugin.reason)
  return (
    <>
      <div className="plugin-head">
        <span className="plugin-name">{str(plugin.displayName) || id}</span>
        <span className={`plugin-status is-${status}`}>{statusLabel(status, t)}</span>
      </div>
      <span className="settings-hint">
        {id} · {t('settings.plugins.version', { version: str(plugin.version) })}
      </span>
      {str(plugin.description) !== '' && <span className="settings-hint">{str(plugin.description)}</span>}
      {reason !== '' && <span className={`settings-hint${status === 'failed' || status === 'incompatible' ? ' is-warning' : ''}`}>{reasonLine(reason, t)}</span>}
      {capabilities.length > 0 && (
        <div className="plugin-facts">
          <span className="settings-field-label">{t('settings.plugins.capabilities')}</span>
          <span>{capabilities.join(', ')}</span>
        </div>
      )}
      <div className="plugin-facts">
        <span className="settings-field-label">{t('settings.plugins.permissions')}</span>
        <span>
          {permissions.length === 0
            ? t('settings.plugins.noPermissions')
            : permissions.map((p, i) => (
                <span key={p} title={p}>
                  {i > 0 ? ', ' : ''}
                  {permissionLabel(p, t)}
                </span>
              ))}
        </span>
      </div>
      <div className="remote-actions">
        <button className="settings-gen-refresh" disabled={busy} onClick={onConfigure}>
          {t('settings.plugins.configure')}
        </button>
        {status === 'failed' && (
          <button className="settings-gen-refresh" disabled={busy} onClick={onStartAgain}>
            {t('settings.plugins.startAgain')}
          </button>
        )}
        <button className="settings-gen-refresh" disabled={busy} onClick={() => onToggle(!enabled)}>
          {enabled ? t('settings.plugins.disable') : t('settings.plugins.enable')}
        </button>
        <button className="settings-gen-refresh" disabled={busy} onClick={onLogs}>
          {t('settings.plugins.logs')}
        </button>
        <button className="ghost danger" disabled={busy} onClick={onRemove}>
          {t('settings.plugins.remove')}
        </button>
      </div>
    </>
  )
}

/** The form spec §24 asks Astera to make from a plugin's settings schema. A secret is never shown (§23): its box is
 *  empty, says whether one is set, and is cleared only by its own checkbox. */
export function PluginSettingsForm({
  fields,
  values,
  secrets,
  draft,
  clear,
  onDraft,
  onClear,
  onSave,
  saving,
  changed
}: {
  fields: readonly SettingField[]
  values: Record<string, unknown>
  secrets: Record<string, unknown>
  /** What the person typed; a field not in it shows what is stored. */
  draft: Draft
  clear: ReadonlySet<string>
  onDraft: (key: string, value: string | boolean) => void
  onClear: (key: string, on: boolean) => void
  onSave: () => void
  saving: boolean
  changed: boolean
}): React.JSX.Element {
  const { t } = useI18n()
  if (fields.length === 0) return <p className="settings-hint">{t('settings.plugins.form.none')}</p>
  const textOf = (f: SettingField): string =>
    typeof draft[f.key] === 'string' ? (draft[f.key] as string) : values[f.key] === undefined ? '' : String(values[f.key])
  const defaultLine = (f: SettingField): string => (f.default === undefined ? '' : t('settings.plugins.form.default', { value: String(f.default) }))
  return (
    // Held while it saves: a save restarts a running plugin, and what is typed meanwhile would go with its answer
    // (2d final review M2).
    <fieldset className="plugin-form" disabled={saving}>
      {fields.map((f) => {
        const label = (
          <span className="plugin-field-label">
            {f.title ?? f.key}
            {f.required && <span className="plugin-required">{t('settings.plugins.form.required')}</span>}
          </span>
        )
        const set = secrets[f.key] === 'set'
        return (
          <div key={f.key} className="plugin-field">
            {f.type === 'boolean' ? (
              <label className="check-small">
                <input
                  type="checkbox"
                  checked={typeof draft[f.key] === 'boolean' ? (draft[f.key] as boolean) : values[f.key] === true}
                  onChange={(e) => onDraft(f.key, e.target.checked)}
                />
                {label}
              </label>
            ) : (
              label
            )}
            {f.description !== undefined && <span className="settings-hint">{f.description}</span>}
            {f.secret ? (
              <div className="remote-actions">
                <input
                  type="password"
                  className="settings-gen-input remote-actions-grow"
                  aria-label={f.title ?? f.key}
                  value={typeof draft[f.key] === 'string' ? (draft[f.key] as string) : ''}
                  placeholder={set ? t('settings.plugins.form.secretPlaceholder') : t('settings.plugins.form.secretPlaceholderNew')}
                  autoComplete="new-password"
                  spellCheck={false}
                  disabled={clear.has(f.key)}
                  onChange={(e) => onDraft(f.key, e.target.value)}
                />
                <span className="settings-hint">{set ? t('settings.plugins.form.secretSet') : t('settings.plugins.form.secretUnset')}</span>
                {set && (
                  <label className="check-small">
                    <input type="checkbox" checked={clear.has(f.key)} onChange={(e) => onClear(f.key, e.target.checked)} />
                    <span>{t('settings.plugins.form.clear')}</span>
                  </label>
                )}
              </div>
            ) : f.enum ? (
              <Select
                className="settings-gen-select"
                ariaLabel={f.title ?? f.key}
                value={textOf(f)}
                onChange={(v) => onDraft(f.key, v)}
                items={[
                  { value: '', label: f.default === undefined ? t('settings.plugins.form.notSet') : defaultLine(f) },
                  ...f.enum.map((v) => ({ value: String(v), label: String(v) }))
                ]}
              />
            ) : f.type !== 'boolean' ? (
              <input
                type="text"
                className="settings-gen-input"
                aria-label={f.title ?? f.key}
                inputMode={f.type === 'string' ? undefined : 'decimal'}
                value={textOf(f)}
                placeholder={defaultLine(f)}
                spellCheck={false}
                onChange={(e) => onDraft(f.key, e.target.value)}
              />
            ) : null}
          </div>
        )
      })}
      <div className="remote-actions is-end">
        <button className="primary" disabled={!changed || saving} onClick={onSave}>
          {t('settings.plugins.form.save')}
        </button>
      </div>
    </fieldset>
  )
}

/** The tail of a plugin's log, its secrets already redacted by the Host (design P13). */
export function PluginLogs({ lines, onRefresh }: { lines: string[] | null; onRefresh: () => void }): React.JSX.Element {
  const { t } = useI18n()
  const box = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight
  }, [lines])
  return (
    <div className="plugin-logs">
      <div className="remote-actions is-end">
        <button className="settings-gen-refresh" onClick={onRefresh}>
          {t('settings.plugins.logs.refresh')}
        </button>
      </div>
      {lines !== null && (lines.length === 0 ? <p className="settings-hint">{t('settings.plugins.logs.none')}</p> : <pre ref={box} className="plugin-log">{lines.join('\n')}</pre>)}
    </div>
  )
}
