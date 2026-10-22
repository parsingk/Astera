import { useEffect, useState } from 'react'
import type { Account, PluginsCallAnswer, Provider } from '../../../core/types'
import type { ExtensionKind } from '../../../core/extensions/types'
import { PROVIDERS, PROVIDER_META } from '../../../core/providers/meta'
import { useI18n } from '../i18n/I18nProvider'
import { useAccountStatus } from '../hooks/useAccountStatus'
import { toast } from '../lib/toast'
import { confirmModal, confirmModalWithChoices } from '../lib/confirm'
import { envSourceLabel, failureLine, gatewayLine, importPrompt, kindLabel, mcpStateLabel, outcomeLabel, picksOf, reasonLabel, type FoundItem } from './extensionsText'

type Entry = Record<string, unknown>
type Status = { id: string; accountId: string; outcome: string; detail?: string }
type McpState = { id: string; accountId: string; state: string }
type GatewayState = { serverId: string; processes: number; state: string; lastError?: string }
type Failure = Extract<PluginsCallAnswer, { ok: false }>

const KINDS: ExtensionKind[] = ['mcp', 'skill', 'command', 'agent']
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const arr = <V,>(v: unknown): V[] => (Array.isArray(v) ? (v as V[]) : [])
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
/** A call that threw (main gone, an IPC error) answers like one the Host refused, so every path says why. */
const failed = (e: unknown): PluginsCallAnswer => ({ ok: false, code: 'FAILED', message: e instanceof Error ? e.message : String(e) })
/** How an outcome looks: in step, needs the person, or neither. */
const toneOf = (o: string): string => (o === 'written' || o === 'unchanged' || o === 'adopted' ? ' is-running' : o === 'conflict' || o === 'failed' ? ' is-failed' : o === 'restored' ? ' is-starting' : '')

/** Settings › Extensions (Agent Control Plane release 1 design §4.10): the MCP servers, skills, commands and subagents
 *  shared with every account, each with how its copy stands in each account; importing from a provider's default
 *  account; turning one on or off, removing it, syncing now, and replacing an account's own copy. The Host owns the
 *  registry and checks everything; no environment value ever reaches this tab. */
export function ExtensionsSettings({ accounts }: { accounts: Account[] }): React.JSX.Element {
  const { t } = useI18n()
  const { defaultIdByProvider } = useAccountStatus(accounts)
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [status, setStatus] = useState<Status[]>([])
  const [mcpStatus, setMcpStatus] = useState<McpState[]>([])
  const [gateway, setGateway] = useState<GatewayState[]>([])
  const [listFailure, setListFailure] = useState<Failure | null>(null)
  /** One change at a time: every change syncs every account before the Host answers. */
  const [busy, setBusy] = useState<'reading' | 'changing' | null>(null)

  const labelOf = (accountId: string): string => accounts.find((a) => a.id === accountId)?.label ?? accountId
  const load = async (): Promise<void> => {
    const r = await window.api.extensions.list().catch(failed)
    if (!r.ok) return void setListFailure(r)
    setListFailure(null)
    setEntries(arr<Entry>(r.body.entries))
    setStatus(arr<Status>(r.body.status))
    setMcpStatus(arr<McpState>(r.body.mcpStatus))
    setGateway(arr<GatewayState>(r.body.gateway))
  }
  useEffect(() => {
    void load()
  }, [])

  /** Runs one change, says why when it did not happen, and reads the list again either way. */
  const change = async (work: () => Promise<PluginsCallAnswer>, done?: (body: Record<string, unknown>) => void): Promise<void> => {
    if (busy !== null) return
    setBusy('changing')
    try {
      const r = await work().catch(failed)
      if (!r.ok) return void toast.error(failureLine(r, t))
      done?.(r.body)
    } finally {
      setBusy(null)
      void load()
    }
  }

  const importFrom = async (accountId: string): Promise<void> => {
    if (busy !== null) return
    setBusy('reading')
    let items: FoundItem[]
    try {
      const r = await window.api.extensions.discover(accountId).catch(failed)
      if (!r.ok) return void toast.error(failureLine(r, t, { read: true }))
      items = arr<FoundItem>(r.body.items)
    } finally {
      setBusy(null)
    }
    const label = labelOf(accountId)
    if (items.length === 0) return void toast.info(t('settings.extensions.import.nothing', { label }))
    const answer = await confirmModalWithChoices(importPrompt(items, label, t))
    const picks = answer.ok ? picksOf(items, answer.checked) : []
    if (picks.length === 0) return
    await change(
      () => window.api.extensions.import(accountId, picks),
      (body) => {
        for (const x of arr<{ name: string; reason: string }>(body.refused))
          toast.error(t('settings.extensions.import.refused', { name: x.name, reason: reasonLabel(x.reason, t) }))
        const count = arr(body.imported).length
        if (count > 0) toast.success(t('settings.extensions.import.done', { count }))
      }
    )
  }

  const remove = async (e: Entry): Promise<void> => {
    const name = str(e.name)
    const ok = await confirmModal({ title: t('settings.extensions.removeConfirm.title', { name }), body: t('settings.extensions.removeConfirm.body'), confirmLabel: t('settings.extensions.remove') })
    if (ok) await change(() => window.api.extensions.remove(str(e.id)))
  }

  const replace = async (e: Entry, accountId: string): Promise<void> => {
    const name = str(e.name)
    const label = labelOf(accountId)
    const ok = await confirmModal({
      title: t('settings.extensions.replaceConfirm.title', { name, label }),
      body: t('settings.extensions.replaceConfirm.body', { name }),
      confirmLabel: t('settings.extensions.replace')
    })
    if (ok) await change(() => window.api.extensions.replace(accountId, str(e.id)))
  }

  const sources = PROVIDERS.map((p: Provider) => ({ provider: p, accountId: defaultIdByProvider[p] }))
  return (
    <div className="settings-stack">
      <p className="settings-hint">{t('settings.extensions.hint')}</p>
      <div className="remote-actions">
        {sources.map(({ provider, accountId }) =>
          accountId !== null ? (
            <button key={provider} className="settings-gen-refresh" disabled={busy !== null || listFailure !== null} onClick={() => void importFrom(accountId)}>
              {busy === 'reading' ? t('settings.extensions.reading') : t('settings.extensions.importFrom', { label: labelOf(accountId) })}
            </button>
          ) : null
        )}
        <button className="settings-gen-refresh" disabled={busy !== null || listFailure !== null} onClick={() => void change(() => window.api.extensions.sync(), () => toast.success(t('settings.extensions.synced')))}>
          {busy === 'changing' ? t('settings.extensions.syncing') : t('settings.extensions.sync')}
        </button>
      </div>
      {sources
        .filter((s) => s.accountId === null)
        .map(({ provider }) => (
          <p key={provider} className="settings-hint">
            {t('settings.extensions.noDefault', { provider: PROVIDER_META[provider].displayName })}
          </p>
        ))}
      {listFailure !== null && <p className="settings-hint is-warning">{failureLine(listFailure, t, { read: true })}</p>}
      {entries !== null && entries.length === 0 && <p className="settings-hint">{t('settings.extensions.none')}</p>}
      {KINDS.map((kind) => {
        const ofKind = (entries ?? []).filter((e) => e.kind === kind)
        if (ofKind.length === 0) return null
        return (
          <div key={kind} className="settings-stack">
            <span className="settings-field-label">{kindLabel(kind, t)}</span>
            {ofKind.map((e) => (
              <ExtensionCard
                key={str(e.id)}
                entry={e}
                status={status.filter((s) => s.id === e.id)}
                mcpStatus={mcpStatus.filter((s) => s.id === e.id)}
                gateway={gateway.find((g) => g.serverId === e.id)}
                onIsolation={(on) => void change(() => window.api.extensions.setIsolation(str(e.id), on ? 'session' : 'folder'))}
                labelOf={labelOf}
                busy={busy !== null}
                onToggle={() => void change(() => window.api.extensions.setEnabled(str(e.id), e.enabled !== true))}
                onRemove={() => void remove(e)}
                onReplace={(accountId) => void replace(e, accountId)}
              />
            ))}
          </div>
        )
      })}
    </div>
  )
}

/** One shared item: what it is, where it came from, and how its copy stands in each account. */
function ExtensionCard({
  entry,
  status,
  mcpStatus,
  gateway,
  onIsolation,
  labelOf,
  busy,
  onToggle,
  onRemove,
  onReplace
}: {
  entry: Entry
  status: Status[]
  /** Per account, whether its sessions get this MCP server, or why not. */
  mcpStatus: McpState[]
  /** The Gateway's processes of this server, for a stdio one. */
  gateway: GatewayState | undefined
  onIsolation: (on: boolean) => void
  labelOf: (accountId: string) => string
  busy: boolean
  onToggle: () => void
  onRemove: () => void
  onReplace: (accountId: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const enabled = entry.enabled === true
  const env = isObject(entry.env) ? Object.entries(entry.env) : []
  return (
    <div className="settings-group plugin-card">
      <div className="plugin-head">
        <span className="plugin-name">{str(entry.name)}</span>
        {!enabled && <span className="plugin-status">{t('settings.extensions.off')}</span>}
      </div>
      <span className="settings-hint">{t('settings.extensions.from', { label: labelOf(str(entry.importedFrom)) })}</span>
      {entry.kind === 'mcp' ? (
        <>
          {entry.transport === 'stdio' ? (
            <>
              <span className="settings-hint">{t('settings.extensions.mcpGivenGateway')}</span>
              <span className={`settings-hint${gateway?.state === 'failed' ? ' is-warning' : ''}`}>{gatewayLine(gateway, t)}</span>
              <label className="check-small">
                <input type="checkbox" checked={entry.isolation === 'session'} disabled={busy} onChange={(ev) => onIsolation(ev.target.checked)} />
                <span>{t('settings.extensions.isolation')}</span>
              </label>
              <span className="settings-hint">{t('settings.extensions.isolationHint')}</span>
            </>
          ) : (
            <span className="settings-hint">{t('settings.extensions.mcpGiven')}</span>
          )}
          {env.length > 0 && (
            <span className="settings-hint">
              {t('settings.extensions.env', { names: env.map(([name, source]) => `${name} (${envSourceLabel(str(source), t)})`).join(', ') })}
            </span>
          )}
          {mcpStatus.map((s) => (
            <div key={s.accountId} className="plugin-facts">
              <span className="settings-field-label">{labelOf(s.accountId)}</span>
              <span className={`plugin-status${s.state === 'given' ? ' is-running' : s.state === 'provider' || s.state === 'account-own' ? '' : ' is-failed'}`}>{mcpStateLabel(s.state, t)}</span>
            </div>
          ))}
        </>
      ) : enabled && status.length === 0 ? (
        <span className="settings-hint">{t('settings.extensions.noStatus')}</span>
      ) : (
        status.map((s) => (
          <div key={s.accountId} className="plugin-facts">
            <span className="settings-field-label">{labelOf(s.accountId)}</span>
            <span className={`plugin-status${toneOf(s.outcome)}`} title={s.detail}>
              {outcomeLabel(s.outcome, t)}
            </span>
            {s.outcome === 'conflict' && (
              <button className="settings-gen-refresh" disabled={busy} onClick={() => onReplace(s.accountId)}>
                {t('settings.extensions.replace')}
              </button>
            )}
          </div>
        ))
      )}
      <div className="remote-actions">
        <button className="settings-gen-refresh" disabled={busy} onClick={onToggle}>
          {enabled ? t('settings.extensions.disable') : t('settings.extensions.enable')}
        </button>
        <button className="ghost danger" disabled={busy} onClick={onRemove}>
          {t('settings.extensions.remove')}
        </button>
      </div>
    </div>
  )
}
