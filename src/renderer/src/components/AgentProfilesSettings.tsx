import { Fragment, useEffect, useId, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { Account, AgentProfileFields, PluginsCallAnswer } from '../../../core/types'
import type { AgentProfile, ProfilePermission } from '../../../core/agentProfiles/types'
import { metaOf, providerOf } from '../../../core/providers/meta'
import { useI18n } from '../i18n/I18nProvider'
import { toast } from '../lib/toast'
import { confirmModal } from '../lib/confirm'
import { publishAgentProfiles } from '../lib/agentProfiles'
import { sandboxSetupOutcome } from '../lib/spawnErrors'
import { AccountSelect } from './AccountSelect'
import { failureLine } from './extensionsText'
import {
  addableAccounts,
  archivedNote,
  offersSetUp,
  permissionLabel,
  profileFailureLine,
  providerSuffix,
  readinessRows,
  sandboxDefaultRemoved,
  sandboxHintKeys,
  sandboxReadinessShown,
  sandboxStateLine
} from './agentProfilesText'

type Failure = Extract<PluginsCallAnswer, { ok: false }>
/** A shared MCP server; `off` when it is switched off in MCP & Skills, so no session gets it whatever is ticked. */
type Server = { id: string; name: string; off: boolean }
/** Every field a save sends, the sandbox switch included. */
type Draft = Required<AgentProfileFields>

const PERMISSIONS: ProfilePermission[] = ['inherit', 'bypass', 'ask']
const arr = <V,>(v: unknown): V[] => (Array.isArray(v) ? (v as V[]) : [])
/** A call that threw (main gone, an IPC error) answers like one the Host refused, so every path says why. */
const failed = (e: unknown): PluginsCallAnswer => ({ ok: false, code: 'FAILED', message: e instanceof Error ? e.message : String(e) })
const draftOf = (p?: AgentProfile): Draft => ({
  name: p?.name ?? '',
  description: p?.description ?? '',
  accountIds: p?.accountIds ?? [],
  mcpExclude: p?.mcpExclude ?? [],
  permission: p?.permission ?? 'inherit',
  sandbox: p?.sandbox ?? false
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
  /** The profile whose Archive asks for the reason first, and the reason typed so far (lifecycle design §5). */
  const [archiving, setArchiving] = useState<{ id: string; reason: string } | null>(null)
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
            // When it was archived and why (lifecycle design §5): the date as its status, the reason inside the open row
            const note = archivedNote(p, t, (iso) => new Date(iso).toLocaleDateString())
            const reason = archiving?.id === p.id ? archiving.reason : null
            return (
              <div key={p.id} className={`ext-row${isOpen ? ' is-open' : ''}`}>
                <button type="button" className="ext-row-head" aria-expanded={isOpen} onClick={() => toggleOpen(p.id)}>
                  <span className="ext-row-chevron" aria-hidden="true">
                    {isOpen ? '▾' : '▸'}
                  </span>
                  <span className="plugin-name">{p.name}</span>
                  {first && <span className="settings-hint">{metaOf(first).displayName}</span>}
                  <span className="settings-hint">{t('settings.agentProfiles.accountCount', { count: p.accountIds.length })}</span>
                  {/* One mark: the date it was archived in place of the plain badge, when the date was kept */}
                  {p.status === 'archived' && (
                    <span className="plugin-status" title={note?.reason}>
                      {note ? note.on : t('settings.agentProfiles.archived')}
                    </span>
                  )}
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
                    note={note?.reason}
                    // Each Codex account's Windows sandbox, for a profile whose sessions start in it (Task 8)
                    sandboxReadiness={sandboxReadinessShown(p, window.api.platform, accounts) ? <SandboxReadiness profile={p} accounts={accounts} /> : undefined}
                  >
                    {reason !== null ? (
                      // Archive asks for the reason in one line first, then archives or cancels (lifecycle design §5)
                      <>
                        <input
                          type="text"
                          className="settings-gen-input remote-actions-grow"
                          aria-label={t('settings.agentProfiles.archiveReason')}
                          placeholder={t('settings.agentProfiles.archiveReason')}
                          value={reason}
                          maxLength={200}
                          autoFocus
                          onChange={(e) => setArchiving({ id: p.id, reason: e.target.value })}
                        />
                        <button
                          className="settings-gen-refresh"
                          disabled={busy}
                          onClick={() =>
                            void change(() => window.api.agentProfiles.archive(p.id, reason.trim() === '' ? undefined : reason)).then((ok) => {
                              if (ok) setArchiving(null)
                            })
                          }
                        >
                          {t('settings.agentProfiles.archive')}
                        </button>
                        <button className="settings-gen-refresh" disabled={busy} onClick={() => setArchiving(null)}>
                          {t('common.cancel')}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="settings-gen-refresh"
                          disabled={busy}
                          onClick={() => (p.status === 'archived' ? void change(() => window.api.agentProfiles.restore(p.id)) : setArchiving({ id: p.id, reason: '' }))}
                        >
                          {p.status === 'archived' ? t('settings.agentProfiles.restore') : t('settings.agentProfiles.archive')}
                        </button>
                        <button className="ghost danger" disabled={busy} onClick={() => void remove(p)}>
                          {t('settings.agentProfiles.delete')}
                        </button>
                      </>
                    )}
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

/** One profile's fields: name, description, the ordered accounts, the shared MCP servers it uses, its permission and its
 *  sandbox switch, then Save and whatever actions the row adds (archive or restore, delete) or Cancel for a new one. */
function ProfileEditor({
  initial,
  accounts,
  servers,
  busy,
  saveLabel,
  onSave,
  onCancel,
  warning,
  note,
  sandboxReadiness,
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
  /** A line shown first, as a hint: why an archived profile was archived (lifecycle design §5). */
  note?: string
  /** Shown under the sandbox switch while it is on: the readiness of a stored profile's Codex accounts on Windows. */
  sandboxReadiness?: React.ReactNode
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
  // The profile's CLI, from its first account: the switch's lines say what it does for that one
  const first = accounts.find((a) => a.id === d.accountIds[0])
  return (
    <div className="ext-row-body">
      {warning !== undefined && <span className="settings-hint is-warning">{warning}</span>}
      {note !== undefined && <span className="settings-hint">{note}</span>}
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
      <div className="plugin-field">
        <label className="check-small">
          <input type="checkbox" checked={d.sandbox} onChange={(e) => set('sandbox', e.target.checked)} />
          <span>{t('settings.agentProfiles.sandbox')}</span>
        </label>
        {sandboxHintKeys(first ? providerOf(first) : undefined).map((k) => (
          <span key={k} className="settings-hint">
            {t(k)}
          </span>
        ))}
        {d.sandbox && sandboxReadiness}
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

/** Each Codex account's Windows sandbox under a profile whose sessions start in it (Task 8): ready, not set up with
 *  설정하기, or could not be asked about. A roll refused for an account not set up sends the person here (Task 6). Asked
 *  of the Host when the row opens and again after a setup; asking runs Codex's doctor (and its echo on a home doctor
 *  calls complete), which never brings up the administrator prompt. Only 설정하기 does, once, for the one account. */
function SandboxReadiness({ profile, accounts }: { profile: AgentProfile; accounts: Account[] }): React.JSX.Element {
  const { t } = useI18n()
  const [answer, setAnswer] = useState<PluginsCallAnswer | null>(null)
  const [settingUp, setSettingUp] = useState(false)
  /** Counts the asks, so an earlier one that comes back late never shows over a later one. */
  const asked = useRef(0)
  const ask = async (): Promise<void> => {
    const n = ++asked.current
    setAnswer(null)
    const r = await window.api.agentProfiles.sandboxReadiness(profile.id).catch(failed)
    if (n === asked.current) setAnswer(r)
  }
  useEffect(() => {
    void ask()
  }, [profile.id])

  /** Task P: Remove under an account whose config.toml still makes the elevated sandbox its default, on the person's
   *  press only; the readiness is asked again after it, which shows whether the default is gone (the line, or Codex's
   *  older feature key) */
  const removeDefault = async (accountId: string): Promise<void> => {
    if (settingUp) return
    setSettingUp(true)
    try {
      const removed = sandboxDefaultRemoved(await window.api.agentProfiles.sandboxDefaultRemove(profile.id, accountId).catch(failed))
      if (!removed.ok) toast.error(t('settings.agentProfiles.sandboxDefault.removeFailed', { file: removed.file ?? 'config.toml' }))
    } finally {
      setSettingUp(false)
      void ask()
    }
  }

  const setUp = async (accountId: string): Promise<void> => {
    if (settingUp) return
    setSettingUp(true)
    try {
      const answer = await window.api.agentProfiles.sandboxSetup(profile.id, accountId).catch(failed)
      // A setup that worked says nothing more: the line asked again below reads ready
      const outcome = sandboxSetupOutcome(answer)
      if (!outcome.ok) toast.error(outcome.line ?? t('session.spawn.sandbox.setUpFailed'))
    } finally {
      setSettingUp(false)
      void ask()
    }
  }

  return (
    <>
      {readinessRows(profile, accounts, answer).map((r) => (
        <Fragment key={r.accountId}>
          <div className="settings-row">
            <span>{r.label}</span>
            <div className="remote-actions">
              {r.state !== null && <span className="settings-hint">{sandboxStateLine(r.state, t)}</span>}
              {offersSetUp(r.state) && (
                <button type="button" className="settings-gen-refresh" disabled={settingUp} onClick={() => void setUp(r.accountId)}>
                  {t('session.spawn.sandbox.setUp')}
                </button>
              )}
            </div>
          </div>
          {r.elevatedDefault && (
            // A dim sentence that takes the width, beside a button that keeps its own (seen on the hidden desktop: as a
            // settings row the sentence took the label's weight and squeezed the button)
            <div className="remote-actions sandbox-default-row">
              <span className="settings-hint remote-actions-grow">{t('settings.agentProfiles.sandboxDefault.hint')}</span>
              <button type="button" className="settings-gen-refresh" disabled={settingUp} onClick={() => void removeDefault(r.accountId)}>
                {t('settings.agentProfiles.sandboxDefault.remove')}
              </button>
            </div>
          )}
        </Fragment>
      ))}
    </>
  )
}
