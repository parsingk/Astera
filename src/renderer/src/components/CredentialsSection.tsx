import { useEffect, useId, useState } from 'react'
import type { HideOnlyFields, PluginsCallAnswer } from '../../../core/types'
import type { HideOnlyEntry, Hiding } from '../../../core/credentials/types'
import { useI18n } from '../i18n/I18nProvider'
import { toast } from '../lib/toast'
import { confirmModal } from '../lib/confirm'
import { recordTime } from './securityText'
import {
  credentialFailure,
  entryName,
  hidesText,
  listOf,
  projectNameOf,
  samePath,
  splitNames,
  switchNote,
  whereText,
  type ListedEntry,
  type ListedPreset,
  type ListedProject
} from './credentialsText'

type Failure = Extract<PluginsCallAnswer, { ok: false }>

/** A call that threw (main gone, an IPC error) answers like one the Host refused, so every path says why. */
const failed = (e: unknown): PluginsCallAnswer => ({ ok: false, code: 'FAILED', message: e instanceof Error ? e.message : String(e) })

/** Settings › Security & Access › Credentials, under its heading (credentials design §5): what Astera keeps out of the
 *  agent sessions it starts. Shared MCP servers that hold a stored key appear on their own; the person adds the other
 *  keys by variable name and CLI logins by preset. Nothing here holds or shows a value. The Host owns the list and checks
 *  every change; a change counts for sessions started afterwards. An entry can be narrowed to the projects the Host has
 *  registered. */
export function CredentialsSection(): React.JSX.Element {
  const { t } = useI18n()
  const [entries, setEntries] = useState<ListedEntry[] | null>(null)
  const [presets, setPresets] = useState<ListedPreset[]>([])
  const [projects, setProjects] = useState<ListedProject[]>([])
  const [failure, setFailure] = useState<Failure | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const platform = window.api.platform

  const load = async (): Promise<void> => {
    const r = await window.api.credentials.list().catch(failed)
    if (!r.ok) {
      setFailure(r)
      // A damaged file holds no entries to show; the Host away for a moment leaves the last ones read on screen
      if (r.reason === 'damaged') setEntries(null)
      return
    }
    const l = listOf(r.body)
    setFailure(null)
    setEntries(l.entries)
    setPresets(l.presets)
    setProjects(l.projects)
  }
  useEffect(() => {
    void load()
  }, [])

  /** Runs one change, says why when it did not happen, and reads the list again either way. True when it happened. */
  const change = async (work: () => Promise<PluginsCallAnswer>): Promise<boolean> => {
    if (busy) return false
    setBusy(true)
    try {
      const r = await work().catch(failed)
      if (!r.ok) {
        toast.error(credentialFailure(r, t))
        return false
      }
      return true
    } finally {
      setBusy(false)
      void load()
    }
  }

  /** The repair of a damaged list: the Host keeps the damaged copy beside it and starts the list empty. */
  const reset = async (): Promise<void> => {
    const ok = await confirmModal({ title: t('settings.credentials.reset.title'), body: t('settings.credentials.reset.body'), confirmLabel: t('settings.credentials.reset') })
    if (ok) await change(() => window.api.credentials.reset())
  }

  const remove = async (e: HideOnlyEntry): Promise<void> => {
    const ok = await confirmModal({
      title: t('settings.credentials.delete.title', { name: e.alias }),
      body: t('settings.credentials.delete.body'),
      confirmLabel: t('settings.credentials.delete')
    })
    if (ok) await change(() => window.api.credentials.deleteHideOnly(e.id))
  }

  const toggleOpen = (id: string): void =>
    setOpen((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const projectName = (folder: string): string | undefined => projectNameOf(projects, folder, platform)

  return (
    <div className="security-credentials" aria-busy={busy || (entries === null && failure === null)}>
      <p className="settings-hint">{t('settings.credentials.hint')}</p>
      <p className="settings-hint">{t('settings.credentials.sessions')}</p>
      {failure !== null && (
        <div className="settings-group">
          <p className="settings-hint is-warning">{credentialFailure(failure, t)}</p>
          {failure.reason === 'damaged' && (
            <button className="settings-gen-refresh" disabled={busy} onClick={() => void reset()}>
              {t('settings.credentials.reset')}
            </button>
          )}
        </div>
      )}
      {entries !== null && (
        <>
          {entries.length === 0 && !adding && <p className="settings-hint">{t('settings.credentials.none')}</p>}
          {entries.length > 0 && (
            <div className="ext-list is-uncapped">
              {entries.map((e) => {
                const isOpen = open.has(e.id)
                const hides = hidesText(e, presets)
                const note = switchNote(e, t)
                const setHiding = (hide: Hiding): void => void change(() => window.api.credentials.setHiding(e.id, hide))
                return (
                  <div key={e.id} className={`ext-row${isOpen ? ' is-open' : ''}`}>
                    <button type="button" className="ext-row-head" aria-expanded={isOpen} onClick={() => toggleOpen(e.id)}>
                      <span className="ext-row-chevron" aria-hidden="true">
                        {isOpen ? '▾' : '▸'}
                      </span>
                      <span className="plugin-name">{entryName(e)}</span>
                      <span className="plugin-status">{e.kind === 'mcp-secret' ? t('settings.credentials.kind.mcp') : t('settings.credentials.kind.hideOnly')}</span>
                      <span className="settings-hint credential-hides">{hides === '' ? t('settings.credentials.hidesNothing') : hides}</span>
                      <span className="settings-hint">{whereText(e, projectName, t)}</span>
                    </button>
                    {isOpen && (
                      <div className="ext-row-body">
                        <div className="plugin-field">
                          <label className="check-small">
                            <input type="checkbox" checked={e.hide.on} disabled={busy} onChange={(ev) => setHiding({ ...e.hide, on: ev.target.checked })} />
                            <span>{t('settings.credentials.hide')}</span>
                          </label>
                          {note !== null && <span className="settings-hint">{note}</span>}
                        </div>
                        <WherePicker
                          value={e.hide.projects}
                          projects={projects}
                          platform={platform}
                          busy={busy}
                          onChange={(picked) => setHiding(picked === undefined ? { on: e.hide.on } : { on: e.hide.on, projects: picked })}
                        />
                        {e.kind === 'mcp-secret' && e.protectedNames.length > 0 && (
                          <span className="settings-hint">{t('settings.credentials.protected', { names: e.protectedNames.join(', ') })}</span>
                        )}
                        {e.kind === 'mcp-secret' && e.lastUsedAt !== undefined && (
                          <span className="settings-hint">{t('settings.credentials.lastUsed', { time: recordTime(e.lastUsedAt) })}</span>
                        )}
                        {e.kind === 'hide-only' && (
                          <EntryEditor
                            // Read again after a save: the editor starts over from what the Host kept
                            key={JSON.stringify([e.alias, e.envNames, e.presets])}
                            initial={{ alias: e.alias, envNames: e.envNames.join(', '), presets: e.presets }}
                            presets={presets}
                            platform={platform}
                            busy={busy}
                            saveLabel={t('settings.credentials.save')}
                            onSave={(d) => void change(() => window.api.credentials.editHideOnly(e.id, d))}
                          >
                            <button className="ghost danger" disabled={busy} onClick={() => void remove(e)}>
                              {t('settings.credentials.delete')}
                            </button>
                          </EntryEditor>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          {adding ? (
            // Its own box, outside the list, as a new agent profile's is
            <div className="agent-profile-new">
              <NewEntry
                presets={presets}
                projects={projects}
                platform={platform}
                busy={busy}
                onAdd={(e) =>
                  void change(() => window.api.credentials.addHideOnly(e)).then((ok) => {
                    if (ok) setAdding(false)
                  })
                }
                onCancel={() => setAdding(false)}
              />
            </div>
          ) : (
            <button className="settings-gen-refresh" disabled={busy} onClick={() => setAdding(true)}>
              {t('settings.credentials.add')}
            </button>
          )}
        </>
      )}
    </div>
  )
}

/** Where an entry hides: every agent session, or only the sessions of the projects picked. Picking "only" shows the
 *  projects and changes nothing until one is picked; the last one picked cannot be taken off (the Host needs one), the
 *  other choice is for that. A project the list names that the app does not know is shown by its folder. */
function WherePicker({
  value,
  projects,
  platform,
  busy,
  onChange
}: {
  value: string[] | undefined
  projects: readonly ListedProject[]
  platform: string
  busy: boolean
  onChange: (projects: string[] | undefined) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const group = useId()
  const [narrowing, setNarrowing] = useState(false)
  const narrow = value !== undefined || narrowing
  const picked = value ?? []
  const unknown = picked.filter((p) => !projects.some((x) => samePath(x.path, p, platform))).map((p) => ({ path: p, name: p }))
  const choices = [...projects, ...unknown]
  return (
    <div className="plugin-field" role="radiogroup" aria-label={t('settings.credentials.scope.label')}>
      <span className="plugin-field-label">{t('settings.credentials.scope.label')}</span>
      <label className="check-small">
        <input
          type="radio"
          name={group}
          checked={!narrow}
          disabled={busy}
          onChange={() => {
            setNarrowing(false)
            if (value !== undefined) onChange(undefined)
          }}
        />
        <span>{t('settings.credentials.where.all')}</span>
      </label>
      <label className="check-small">
        <input type="radio" name={group} checked={narrow} disabled={busy || choices.length === 0} onChange={() => setNarrowing(true)} />
        <span>{t('settings.credentials.scope.projects')}</span>
      </label>
      {choices.length === 0 && <span className="settings-hint">{t('settings.credentials.scope.noProjects')}</span>}
      {narrow && (
        <div className="credential-projects">
          {choices.map((p) => {
            const on = picked.some((x) => samePath(x, p.path, platform))
            return (
              <label key={p.path} className="check-small" title={p.path}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={busy || (on && picked.length === 1)}
                  onChange={(ev) => onChange(ev.target.checked ? [...picked, p.path] : picked.filter((x) => !samePath(x, p.path, platform)))}
                />
                <span>{p.name}</span>
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}

type Draft = { alias: string; envNames: string; presets: string[] }

/** A hide-only entry's name, variable names and CLI login presets, any fields the caller adds (where a new one hides),
 *  then Save and whatever the row adds (Delete) or Cancel for a new one. Names only: there is no field a value could be
 *  typed into. */
function EntryEditor({
  initial,
  presets,
  platform,
  busy,
  saveLabel,
  onSave,
  onCancel,
  ghNote = false,
  fields,
  children
}: {
  initial: Draft
  presets: readonly ListedPreset[]
  platform: string
  busy: boolean
  saveLabel: string
  onSave: (d: Omit<HideOnlyFields, 'hide'>) => void
  onCancel?: () => void
  /** Says what the gh preset takes away while it is picked: a new entry has no switch of its own yet to say it under. */
  ghNote?: boolean
  fields?: React.ReactNode
  children?: React.ReactNode
}): React.JSX.Element {
  const { t } = useI18n()
  const [d, setD] = useState<Draft>(initial)
  return (
    <div className="ext-row-body">
      <label className="plugin-field">
        <span className="plugin-field-label">{t('settings.credentials.alias')}</span>
        <input type="text" className="settings-gen-input" value={d.alias} maxLength={60} onChange={(e) => setD({ ...d, alias: e.target.value })} />
      </label>
      <label className="plugin-field">
        <span className="plugin-field-label">{t('settings.credentials.envNames')}</span>
        <input
          type="text"
          className="settings-gen-input"
          value={d.envNames}
          spellCheck={false}
          autoComplete="off"
          placeholder="STRIPE_API_KEY, SENTRY_AUTH_TOKEN"
          onChange={(e) => setD({ ...d, envNames: e.target.value })}
        />
        <span className="settings-hint">{t('settings.credentials.envNames.hint')}</span>
      </label>
      <div className="plugin-field">
        <span className="plugin-field-label">{t('settings.credentials.presets')}</span>
        {presets.map((p) => (
          <label key={p.id} className="check-small">
            <input
              type="checkbox"
              checked={d.presets.includes(p.id)}
              onChange={(e) => setD({ ...d, presets: e.target.checked ? [...d.presets, p.id] : d.presets.filter((x) => x !== p.id) })}
            />
            <span>{p.label}</span>
            {!p.measuredOn.includes(platform) && <span className="plugin-status">{t('settings.credentials.preset.unmeasured')}</span>}
          </label>
        ))}
        {ghNote && d.presets.includes('gh') && <span className="settings-hint">{t('settings.credentials.note.gh')}</span>}
        <span className="settings-hint">{t('settings.credentials.presetNote')}</span>
      </div>
      {fields}
      <div className="remote-actions">
        <button className="settings-gen-refresh" disabled={busy} onClick={() => onSave({ alias: d.alias, envNames: splitNames(d.envNames), presets: d.presets })}>
          {saveLabel}
        </button>
        {onCancel && (
          <button className="settings-gen-refresh" disabled={busy} onClick={onCancel}>
            {t('common.cancel')}
          </button>
        )}
        {children}
      </div>
    </div>
  )
}

/** A new hide-only entry: its fields and where it hides, every agent session unless projects are picked. */
function NewEntry({
  presets,
  projects,
  platform,
  busy,
  onAdd,
  onCancel
}: {
  presets: readonly ListedPreset[]
  projects: readonly ListedProject[]
  platform: string
  busy: boolean
  onAdd: (e: HideOnlyFields) => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [where, setWhere] = useState<string[] | undefined>(undefined)
  return (
    <EntryEditor
      initial={{ alias: '', envNames: '', presets: [] }}
      presets={presets}
      platform={platform}
      busy={busy}
      saveLabel={t('settings.credentials.create')}
      ghNote
      fields={<WherePicker value={where} projects={projects} platform={platform} busy={busy} onChange={setWhere} />}
      onSave={(d) => onAdd({ ...d, hide: where === undefined ? { on: true } : { on: true, projects: where } })}
      onCancel={onCancel}
    />
  )
}
