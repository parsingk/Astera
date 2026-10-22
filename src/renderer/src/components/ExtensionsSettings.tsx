import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Account, PluginsCallAnswer, Provider } from '../../../core/types'
import type { ExtensionKind } from '../../../core/extensions/types'
import { PROVIDERS, PROVIDER_META } from '../../../core/providers/meta'
import { useI18n } from '../i18n/I18nProvider'
import { useAccountStatus } from '../hooks/useAccountStatus'
import { toast } from '../lib/toast'
import { confirmModal, confirmModalWithChoices } from '../lib/confirm'
import { copyProblem, failureLine, importPrompt, kindLabel, notGivenLabel, notGivenWorthSaying, offeredItems, picksOf, reasonLabel, serverProblem, type FoundItem } from './extensionsText'

type Entry = Record<string, unknown>
type Status = { id: string; accountId: string; outcome: string; detail?: string }
type McpState = { id: string; accountId: string; state: string }
type GatewayState = { serverId: string; processes: number; state: string; lastError?: string }
type Failure = Extract<PluginsCallAnswer, { ok: false }>

const KINDS: ExtensionKind[] = ['mcp', 'skill', 'command', 'agent']
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const arr = <V,>(v: unknown): V[] => (Array.isArray(v) ? (v as V[]) : [])
/** A call that threw (main gone, an IPC error) answers like one the Host refused, so every path says why. */
const failed = (e: unknown): PluginsCallAnswer => ({ ok: false, code: 'FAILED', message: e instanceof Error ? e.message : String(e) })

/** Settings › Extensions (Agent Control Plane release 1 design §4.10, release 2 §4.5): the MCP servers, skills, commands
 *  and agents shared with every account, one scrolling list per kind of collapsed rows that open on a click. A row shows
 *  only what a person acts on: whether it is off, what went wrong, and which accounts cannot use it and why. The Host
 *  owns the registry and checks everything; no environment value ever reaches this tab. */
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
  /** The rows opened, by entry id. */
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const toggleOpen = (id: string): void =>
    setOpen((o) => {
      const next = new Set(o)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

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
    if (offeredItems(items).length === 0) return void toast.info(t('settings.extensions.import.nothing', { label }))
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

  const sources = PROVIDERS.map((p: Provider) => ({ provider: p, accountId: defaultIdByProvider[p] })).filter((x) => x.accountId !== null) as {
    provider: Provider
    accountId: string
  }[]
  return (
    <div className="settings-stack">
      <p className="settings-hint">{t('settings.extensions.hint')}</p>
      {sources.length > 0 && (
        <RegisterMenu
          sources={sources.map((s) => ({ ...s, label: labelOf(s.accountId) }))}
          reading={busy === 'reading'}
          disabled={busy !== null || listFailure !== null}
          onPick={(accountId) => void importFrom(accountId)}
        />
      )}
      {listFailure !== null && <p className="settings-hint is-warning">{failureLine(listFailure, t, { read: true })}</p>}
      {entries !== null && entries.length === 0 && <p className="settings-hint">{t('settings.extensions.none')}</p>}
      {KINDS.map((kind) => {
        const ofKind = (entries ?? []).filter((e) => e.kind === kind)
        if (ofKind.length === 0) return null
        return (
          <div key={kind} className="settings-stack">
            <span className="settings-field-label">{kindLabel(kind, t)}</span>
            {kind === 'mcp' && <McpSharingNote />}
            <div className="ext-list">
              {ofKind.map((e) => {
                const id = str(e.id)
                return (
                  <ExtensionRow
                    key={id}
                    entry={e}
                    open={open.has(id)}
                    onOpen={() => toggleOpen(id)}
                    status={status.filter((s) => s.id === id)}
                    mcpStatus={mcpStatus.filter((s) => s.id === id)}
                    gateway={gateway.find((g) => g.serverId === id)}
                    onIsolation={(on) => void change(() => window.api.extensions.setIsolation(id, on ? 'session' : 'folder'))}
                    labelOf={labelOf}
                    busy={busy !== null}
                    onToggle={() => void change(() => window.api.extensions.setEnabled(id, e.enabled !== true))}
                    onRemove={() => void remove(e)}
                    onReplace={(accountId) => void replace(e, accountId)}
                  />
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** The one Register button: it opens the list of accounts to register from, the default account of each provider.
 *  Closes on a pick, a click outside or Escape, as the run type picker does. */
function RegisterMenu({
  sources,
  reading,
  disabled,
  onPick
}: {
  sources: { provider: Provider; accountId: string; label: string }[]
  reading: boolean
  disabled: boolean
  onPick: (accountId: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDocDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  return (
    <div className="rtp-anchor ext-register" ref={rootRef}>
      <button className="settings-gen-refresh ext-register-btn" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen((v) => !v)}>
        {reading ? t('settings.extensions.reading') : t('settings.extensions.register')}
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <div className="rtp-menu" role="menu">
          <div className="rtp-group">{t('settings.extensions.registerFrom')}</div>
          {sources.map((s) => (
            <button
              key={s.provider}
              type="button"
              role="menuitem"
              className="rtp-item"
              onClick={() => {
                setOpen(false)
                onPick(s.accountId)
              }}
            >
              {s.label}
              <span className="ext-register-provider">{PROVIDER_META[s.provider].displayName}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** How MCP servers are shared per project folder, in the person's own line breaks, with the switch's name in bold. */
function McpSharingNote(): React.JSX.Element {
  const { t } = useI18n()
  const marker = '\u0001'
  const option = <strong>{t('settings.extensions.isolation')}</strong>
  return (
    <div className="settings-hint ext-note">
      {t('settings.extensions.mcpSharing', { option: marker })
        .split('\n')
        .map((line, i) => {
          const [before, after] = line.split(marker)
          return (
            <p key={i}>
              {before}
              {after !== undefined && option}
              {after}
            </p>
          )
        })}
    </div>
  )
}

/** One shared item: its name, and a mark when it is off or needs a look; opened, what went wrong, which accounts
 *  cannot use it and why, and its actions. */
function ExtensionRow({
  entry,
  open,
  onOpen,
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
  open: boolean
  onOpen: () => void
  status: Status[]
  /** Per account, whether its sessions get this MCP server, or why not. */
  mcpStatus: McpState[]
  /** The processes of this server, for one that runs as a command. */
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
  const problem = entry.kind === 'mcp' ? serverProblem(gateway, t) : null
  const notGiven = mcpStatus.filter((s) => notGivenWorthSaying(s.state))
  const copyProblems = status.flatMap((s) => {
    const line = copyProblem(s.outcome, t)
    return line === null ? [] : [{ ...s, line }]
  })
  const attention = enabled && (problem !== null || notGiven.length > 0 || copyProblems.length > 0)
  return (
    <div className={`ext-row${open ? ' is-open' : ''}`}>
      <button type="button" className="ext-row-head" aria-expanded={open} onClick={onOpen}>
        <span className="ext-row-chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="plugin-name">{str(entry.name)}</span>
        {!enabled && <span className="plugin-status">{t('settings.extensions.off')}</span>}
        {attention && <span className="plugin-status is-failed">{t('settings.extensions.attention')}</span>}
      </button>
      {open && (
        <div className="ext-row-body">
          {problem !== null && <span className="settings-hint is-warning">{problem}</span>}
          {notGiven.map((s) => (
            <span key={s.accountId} className="settings-hint">
              {labelOf(s.accountId)}: {notGivenLabel(s.state, t)}
            </span>
          ))}
          {copyProblems.map((s) => (
            <div key={s.accountId} className="remote-actions">
              <span className="settings-hint" title={s.detail}>
                {labelOf(s.accountId)}: {s.line}
              </span>
              {s.outcome === 'conflict' && (
                <button className="settings-gen-refresh" disabled={busy} onClick={() => onReplace(s.accountId)}>
                  {t('settings.extensions.replace')}
                </button>
              )}
            </div>
          ))}
          {entry.kind === 'mcp' && entry.transport === 'stdio' && (
            <label className="check-small">
              <input type="checkbox" checked={entry.isolation === 'session'} disabled={busy} onChange={(ev) => onIsolation(ev.target.checked)} />
              <span>{t('settings.extensions.isolation')}</span>
            </label>
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
      )}
    </div>
  )
}
