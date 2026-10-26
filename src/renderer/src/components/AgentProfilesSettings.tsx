import { useEffect, useId, useState } from 'react'
import { X } from 'lucide-react'
import type { Account, AgentProfileFields, PluginsCallAnswer } from '../../../core/types'
import type { AgentProfile, ProfilePermission } from '../../../core/agentProfiles/types'
import { metaOf } from '../../../core/providers/meta'
import { useI18n } from '../i18n/I18nProvider'
import { toast } from '../lib/toast'
import { confirmModal } from '../lib/confirm'
import { publishAgentProfiles } from '../lib/agentProfiles'
import { AccountSelect } from './AccountSelect'
import { failureLine } from './extensionsText'
import { addableAccounts, permissionLabel, profileFailureLine, providerSuffix } from './agentProfilesText'

type Failure = Extract<PluginsCallAnswer, { ok: false }>
/** A shared MCP server; `off` when it is switched off in MCP & Skills, so no session gets it whatever is ticked. */
type Server = { id: string; name: string; off: boolean }
type Draft = Required<AgentProfileFields> & { description: string }

const PERMISSIONS: ProfilePermission[] = ['inherit', 'bypass', 'ask']
const arr = <V,>(v: unknown): V[] => (Array.isArray(v) ? (v as V[]) : [])
/** A call that threw (main gone, an IPC error) answers like one the Host refused, so every path says why. */
const failed = (e: unknown): PluginsCallAnswer => ({ ok: false, code: 'FAILED', message: e instanceof Error ? e.message : String(e) })
const draftOf = (p?: AgentProfile): Draft => ({
  name: p?.name ?? '',
  description: p?.description ?? '',
  accountIds: p?.accountIds ?? [],
  mcpExclude: p?.mcpExclude ?? [],
  permission: p?.permission ?? 'inherit'
})

/** Settings › Agent profiles (Agent Profiles design §8): accounts with their roll order, the shared MCP servers a
 *  profile uses and its permission, saved under a name that new sessions, Jobs and Tasks can be started as. Laid out
 *  like MCP & Skills: collapsed rows that open on a click. The Host owns the store and checks every change; a refusal
 *  comes back with its reason in a word, said here in the person's language. */
export function AgentProfilesSettings({ accounts }: { accounts: Account[] }): React.JSX.Element {
  const { t } = useI18n()
  const [profiles, setProfiles] = useState<AgentProfile[] | null>(null)
  const [servers, setServers] = useState<Server[]>([])
  const [listFailure, setListFailure] = useState<Failure | null>(null)
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  /** The rows opened, by profile id. */
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const toggleOpen = (id: string): void =>
    setOpen((o) => {
      const next = new Set(o)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const load = async (): Promise<void> => {
    const r = await window.api.agentProfiles.list().catch(failed)
    if (!r.ok) return void setListFailure(r)
    setListFailure(null)
    const list = arr<AgentProfile>(r.body.profiles)
    setProfiles(list)
    publishAgentProfiles(list)
    // The MCP servers to tick come from MCP & Skills' own list; a failure there leaves the section saying there are none
    const ext = await window.api.extensions.list().catch(failed)
    if (ext.ok)
      setServers(
        arr<Record<string, unknown>>(ext.body.entries)
          .filter((e) => e.kind === 'mcp' && typeof e.id === 'string')
          .map((e) => ({ id: e.id as string, name: typeof e.name === 'string' ? e.name : (e.id as string), off: e.enabled !== true }))
      )
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
        toast.error(profileFailureLine(r, t))
        return false
      }
      return true
    } finally {
      setBusy(false)
      void load()
    }
  }

  const remove = async (p: AgentProfile): Promise<void> => {
    const ok = await confirmModal({
      title: t('settings.agentProfiles.deleteConfirm.title', { name: p.name }),
      body: t('settings.agentProfiles.deleteConfirm.body'),
      confirmLabel: t('settings.agentProfiles.delete')
    })
    if (ok) await change(() => window.api.agentProfiles.remove(p.id))
  }

  return (
    <div className="settings-stack">
      <p className="settings-hint">{t('settings.agentProfiles.hint')}</p>
      {!creating && (
        <button className="settings-gen-refresh" disabled={busy || listFailure !== null} onClick={() => setCreating(true)}>
          {t('settings.agentProfiles.new')}
        </button>
      )}
      {listFailure !== null && <p className="settings-hint is-warning">{failureLine(listFailure, t, { read: true })}</p>}
      {creating && (
        // Its own box, outside the list, so its Create and Cancel are never inside the list's scroll
        <div className="agent-profile-new">
          <ProfileEditor
            initial={draftOf()}
            accounts={accounts}
            servers={servers}
            busy={busy}
            saveLabel={t('settings.agentProfiles.create')}
            onSave={(d) =>
              void change(() => window.api.agentProfiles.create(d)).then((ok) => {
                if (ok) setCreating(false)
              })
            }
            onCancel={() => setCreating(false)}
          />
        </div>
      )}
      {profiles !== null && profiles.length === 0 && !creating && <p className="settings-hint">{t('settings.agentProfiles.none')}</p>}
      {profiles !== null && profiles.length > 0 && (
        <div className="ext-list is-uncapped">
          {profiles.map((p) => {
            const first = accounts.find((a) => a.id === p.accountIds[0])
            const isOpen = open.has(p.id)
            return (
              <div key={p.id} className={`ext-row${isOpen ? ' is-open' : ''}`}>
                <button type="button" className="ext-row-head" aria-expanded={isOpen} onClick={() => toggleOpen(p.id)}>
                  <span className="ext-row-chevron" aria-hidden="true">
                    {isOpen ? '▾' : '▸'}
                  </span>
                  <span className="plugin-name">{p.name}</span>
                  {first && <span className="settings-hint">{metaOf(first).displayName}</span>}
                  <span className="settings-hint">{t('settings.agentProfiles.accountCount', { count: p.accountIds.length })}</span>
                  {p.status === 'archived' && <span className="plugin-status">{t('settings.agentProfiles.archived')}</span>}
                </button>
                {isOpen && (
                  <ProfileEditor
                    // Read again after a save: the editor starts over from what the Host kept
                    key={p.updatedAt}
                    initial={draftOf(p)}
                    accounts={accounts}
                    servers={servers}
                    busy={busy}
                    saveLabel={t('settings.agentProfiles.save')}
                    onSave={(d) => void change(() => window.api.agentProfiles.update(p.id, d))}
                    warning={p.status === 'active' && p.accountIds.length === 0 ? t('settings.agentProfiles.noAccounts') : undefined}
                  >
                    <button
                      className="settings-gen-refresh"
                      disabled={busy}
                      onClick={() => void change(() => (p.status === 'archived' ? window.api.agentProfiles.restore(p.id) : window.api.agentProfiles.archive(p.id)))}
                    >
                      {p.status === 'archived' ? t('settings.agentProfiles.restore') : t('settings.agentProfiles.archive')}
                    </button>
                    <button className="ghost danger" disabled={busy} onClick={() => void remove(p)}>
                      {t('settings.agentProfiles.delete')}
                    </button>
                  </ProfileEditor>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** One profile's fields: name, description, the ordered accounts, the shared MCP servers it uses and its permission,
 *  then Save and whatever actions the row adds (archive or restore, delete) or Cancel for a new one. */
function ProfileEditor({
  initial,
  accounts,
  servers,
  busy,
  saveLabel,
  onSave,
  onCancel,
  warning,
  children
}: {
  initial: Draft
  accounts: Account[]
  servers: Server[]
  busy: boolean
  saveLabel: string
  onSave: (d: Draft) => void
  onCancel?: () => void
  warning?: string
  children?: React.ReactNode
}): React.JSX.Element {
  const { t } = useI18n()
  const [d, setD] = useState<Draft>(initial)
  const radioGroup = useId()
  const labelOf = (id: string): string => accounts.find((a) => a.id === id)?.label ?? id
  const set = <K extends keyof Draft>(k: K, v: Draft[K]): void => setD((x) => ({ ...x, [k]: v }))
  const move = (i: number, dir: -1 | 1): void => {
    const ys = [...d.accountIds]
    ;[ys[i], ys[i + dir]] = [ys[i + dir], ys[i]]
    set('accountIds', ys)
  }
  const unpicked = addableAccounts(accounts, d.accountIds)
  return (
    <div className="ext-row-body">
      {warning !== undefined && <span className="settings-hint is-warning">{warning}</span>}
      <label className="plugin-field">
        <span className="plugin-field-label">{t('settings.agentProfiles.name')}</span>
        <input type="text" className="settings-gen-input" value={d.name} maxLength={60} onChange={(e) => set('name', e.target.value)} />
      </label>
      <label className="plugin-field">
        <span className="plugin-field-label">{t('settings.agentProfiles.description')}</span>
        <input type="text" className="settings-gen-input" value={d.description} onChange={(e) => set('description', e.target.value)} />
      </label>
      <div className="plugin-field">
        <span className="plugin-field-label">{t('settings.agentProfiles.accounts')}</span>
        {d.accountIds.length > 0 && (
          <ol className="detail-check-list">
            {d.accountIds.map((id, i) => (
              <li key={id} className="detail-check-row">
                <span className="detail-check-no">{i + 1}</span>
                <span className="detail-check-name">{labelOf(id)}</span>
                <button type="button" title={t('settings.agentProfiles.moveUp')} aria-label={`${labelOf(id)}: ${t('settings.agentProfiles.moveUp')}`} disabled={i === 0} onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button
                  type="button"
                  title={t('settings.agentProfiles.moveDown')}
                  aria-label={`${labelOf(id)}: ${t('settings.agentProfiles.moveDown')}`}
                  disabled={i === d.accountIds.length - 1}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  title={t('settings.agentProfiles.removeAccount')}
                  aria-label={`${labelOf(id)}: ${t('settings.agentProfiles.removeAccount')}`}
                  onClick={() => set('accountIds', d.accountIds.filter((x) => x !== id))}
                >
                  <X size={12} />
                </button>
              </li>
            ))}
          </ol>
        )}
        {unpicked.length > 0 && (
          // Holds no value: picking adds the account at the end, as the new Task form adds a check
          <AccountSelect accounts={unpicked} value="" allLabel={t('settings.agentProfiles.addAccount')} suffixOf={providerSuffix} onChange={(id) => id !== '' && set('accountIds', [...d.accountIds, id])} />
        )}
        <span className="settings-hint">{t('settings.agentProfiles.accountsHint')}</span>
      </div>
      <div className="plugin-field">
        <span className="plugin-field-label">{t('settings.agentProfiles.mcp')}</span>
        {servers.length === 0 && <span className="settings-hint">{t('settings.agentProfiles.mcpNone')}</span>}
        {servers.map((s) => (
          <label key={s.id} className="check-small">
            <input
              type="checkbox"
              checked={!d.mcpExclude.includes(s.id)}
              onChange={(e) => set('mcpExclude', e.target.checked ? d.mcpExclude.filter((x) => x !== s.id) : [...d.mcpExclude, s.id])}
            />
            <span>{s.name}</span>
            {s.off && <span className="plugin-status">{t('settings.extensions.off')}</span>}
          </label>
        ))}
        <span className="settings-hint">{t('settings.agentProfiles.mcpHint')}</span>
      </div>
      <div className="plugin-field" role="radiogroup" aria-label={t('settings.agentProfiles.permission')}>
        <span className="plugin-field-label">{t('settings.agentProfiles.permission')}</span>
        {PERMISSIONS.map((p) => (
          <label key={p} className="check-small">
            <input type="radio" name={radioGroup} checked={d.permission === p} onChange={() => set('permission', p)} />
            <span>{permissionLabel(p, t)}</span>
          </label>
        ))}
        <span className="settings-hint">{t('settings.agentProfiles.permissionAgents')}</span>
      </div>
      <div className="remote-actions">
        <button className="settings-gen-refresh" disabled={busy} onClick={() => onSave(d)}>
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
