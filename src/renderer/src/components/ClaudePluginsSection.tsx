import { useEffect, useRef, useState } from 'react'
import type { PluginsCallAnswer } from '../../../core/types'
import type { ClaudePluginJob, ClaudePluginStore } from '../../../core/extensions/claudePlugins/types'
import { useI18n } from '../i18n/I18nProvider'
import { toast } from '../lib/toast'
import { confirmModal, isConfirmOpen } from '../lib/confirm'
import { failureLine } from './extensionsText'
import {
  contentLines,
  dependencyLines,
  isLiveJob,
  jobLine,
  latestJob,
  offConfirmBody,
  ownCopyLines,
  pendingLines,
  refusalLabel,
  rowState,
  updateLabel,
  type ListedClaudePlugin
} from './claudePluginsText'

type Failure = Extract<PluginsCallAnswer, { ok: false }>
type LastCheck = ClaudePluginStore['lastCheck']
type LabelOf = (accountId: string) => string

/** How often the list is read again while a plugin job is queued or running (R4). */
const POLL_MS = 1500

const arr = <V,>(v: unknown): V[] => (Array.isArray(v) ? (v as V[]) : [])
/** A call that threw (main gone, an IPC error) answers like one the Host refused, as in ExtensionsSettings. */
const failed = (e: unknown): PluginsCallAnswer => ({ ok: false, code: 'FAILED', message: e instanceof Error ? e.message : String(e) })
const when = (iso: string): string => new Date(iso).toLocaleString()

/** The jobs this app started, until each is seen to end. One that ends asking to run a marketplace command (M8) is put
 *  to the person once, even if the tab was closed and opened again meanwhile; one another app run started is not put
 *  in front of them unasked. */
const awaiting = new Set<string>()

/** The shared Claude Code plugins as Settings › MCP & Skills reads them: the register menu shares into them, and the
 *  Plugins group shows them. */
export interface ClaudePlugins {
  /** Null until the Host first answers. */
  listed: ListedClaudePlugin[] | null
  jobs: ClaudePluginJob[]
  lastCheck: LastCheck
  failure: Failure | null
  busy: boolean
  /** Runs one plugin call, says why when it did not happen (`refusal` words a refused one), and reads the list again. */
  act: (work: () => Promise<PluginsCallAnswer>, refusal?: (r: Failure) => string) => Promise<void>
  /** Shares one plugin, with the sha256 of the command the person confirmed when there is one. */
  share: (id: string, acceptCommand?: string) => Promise<void>
}

/** Reads `pluginList` once, then every 1.5 s while a job is queued or running and not otherwise (R4), each read after
 *  the last one answered; the reads stop when the tab goes. A job this app started that stops to ask about a marketplace
 *  command opens the confirmation, and confirming repeats the share or update with the command's sha256. */
export function useClaudePlugins(): ClaudePlugins {
  const { t } = useI18n()
  const [listed, setListed] = useState<ListedClaudePlugin[] | null>(null)
  const [jobs, setJobs] = useState<ClaudePluginJob[]>([])
  const [lastCheck, setLastCheck] = useState<LastCheck>(undefined)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [busy, setBusy] = useState(false)
  /** Counts the reads that answered, so the next poll is set from each answer. */
  const [reads, setReads] = useState(0)

  const load = async (): Promise<void> => {
    const r = await window.api.extensions.pluginList().catch(failed)
    if (r.ok) {
      setFailure(null)
      setListed(arr<ListedClaudePlugin>(r.body.plugins))
      setJobs(arr<ClaudePluginJob>(r.body.jobs))
      setLastCheck(r.body.lastCheck as LastCheck)
    } else setFailure(r)
    setReads((n) => n + 1)
  }
  useEffect(() => {
    void load()
  }, [])

  const live = jobs.some(isLiveJob)
  useEffect(() => {
    if (!live) return
    const timer = setTimeout(() => void load(), POLL_MS)
    return () => clearTimeout(timer)
  }, [live, reads])

  const act: ClaudePlugins['act'] = async (work, refusal) => {
    setBusy(true)
    try {
      const r = await work().catch(failed)
      if (!r.ok) return void toast.error(refusal?.(r) ?? failureLine(r, t))
      if (typeof r.body.jobId === 'string') awaiting.add(r.body.jobId)
    } finally {
      setBusy(false)
      await load()
    }
  }
  // A share the Host refused carries why, as discovery words it
  const share: ClaudePlugins['share'] = (id, acceptCommand) =>
    act(
      () => window.api.extensions.pluginShare(id, acceptCommand),
      (r) => (r.reason !== undefined ? t('settings.extensions.import.refused', { name: id, reason: refusalLabel(r.reason, t) }) : failureLine(r, t))
    )

  // One confirmation at a time: a second confirm modal would be answered as a cancel at once, so a job waits for its turn
  // until the next read
  const asking = useRef(false)
  useEffect(() => {
    const asks = (j: ClaudePluginJob): boolean => j.state === 'needs-confirmation' && j.command !== undefined && j.target !== undefined
    for (const j of jobs) if (awaiting.has(j.id) && !isLiveJob(j) && !asks(j)) awaiting.delete(j.id)
    if (asking.current || isConfirmOpen()) return
    const j = jobs.find((x) => awaiting.has(x.id) && asks(x))
    if (j?.command === undefined || j.target === undefined) return
    const target = j.target
    const command = j.command
    awaiting.delete(j.id)
    asking.current = true
    void (async () => {
      const ok = await confirmModal({
        title: t('settings.extensions.plugin.confirmCommand.title', { name: target }),
        body: t('settings.extensions.plugin.confirmCommand.body'),
        code: command.text,
        confirmLabel: t('settings.extensions.plugin.confirmCommand.run')
      })
      asking.current = false
      if (ok) await (j.kind === 'update' ? act(() => window.api.extensions.pluginUpdate(target, command.sha256)) : share(target, command.sha256))
      // Read again after a cancel too, so the next job waiting to ask gets its turn
      else await load()
    })()
  }, [jobs])

  return { listed, jobs, lastCheck, failure, busy, act, share }
}

/** The Plugins group of Settings › MCP & Skills (Claude plugin sharing design §5.9): the Claude Code plugins shared with
 *  every Claude account, one collapsed row each as the other kinds have, the update check, and where each plugin job
 *  stands. Nothing is drawn while nothing is shared and no job has anything to say. */
export function ClaudePluginsSection({ plugins, labelOf }: { plugins: ClaudePlugins; labelOf: LabelOf }): React.JSX.Element | null {
  const { t } = useI18n()
  const { jobs, lastCheck, failure, busy, act } = plugins
  /** The rows opened, by plugin id. */
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const toggleOpen = (id: string): void =>
    setOpen((o) => {
      const next = new Set(o)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const listed = plugins.listed ?? []
  const pending = pendingLines(jobs, new Set(listed.map((p) => p.id)), t)
  // Without a Host the tab already says so, and a Host too old to share plugins has none to show
  const listFailure = failure !== null && failure.code !== 'HOST_NOT_RUNNING' && failure.code !== 'NOT_SUPPORTED' ? failureLine(failure, t, { read: true }) : null
  if (listed.length === 0 && pending.length === 0 && listFailure === null) return null
  const checking = jobs.some((j) => j.kind === 'check' && isLiveJob(j))

  const turnOff = async (p: ListedClaudePlugin): Promise<void> => {
    const ok = await confirmModal({
      title: t('settings.extensions.plugin.offTitle', { name: p.name }),
      body: offConfirmBody(p, labelOf, t),
      confirmLabel: t('settings.extensions.disable')
    })
    if (ok) await act(() => window.api.extensions.pluginSetEnabled(p.id, false))
  }
  const remove = async (p: ListedClaudePlugin): Promise<void> => {
    const ok = await confirmModal({
      title: t('settings.extensions.removeConfirm.title', { name: p.name }),
      body: offConfirmBody(p, labelOf, t, 'remove'),
      confirmLabel: t('settings.extensions.remove')
    })
    if (ok) await act(() => window.api.extensions.pluginRemove(p.id))
  }

  return (
    <div className="settings-stack">
      <span className="settings-field-label">{t('settings.extensions.plugin.group')}</span>
      {listed.length > 0 && (
        <div className="remote-actions">
          <button className="settings-gen-refresh" disabled={busy || checking} onClick={() => void act(() => window.api.extensions.pluginCheck())}>
            {checking ? t('settings.extensions.plugin.checking') : t('settings.extensions.plugin.check')}
          </button>
          {lastCheck !== undefined && <span className="settings-hint">{t('settings.extensions.plugin.checkedAt', { time: when(lastCheck.at) })}</span>}
        </div>
      )}
      {listed.length > 0 && lastCheck?.error !== undefined && (
        <p className="settings-hint is-warning">{t('settings.extensions.plugin.checkFailed', { message: lastCheck.error })}</p>
      )}
      {listFailure !== null && <p className="settings-hint is-warning">{listFailure}</p>}
      {pending.map((x) => (
        <p key={x.id} className={`settings-hint${x.stopped ? ' is-warning' : ''}`}>
          {x.id}: {x.line}
        </p>
      ))}
      {listed.length > 0 && (
        <div className="ext-list">
          {listed.map((p) => (
            <ClaudePluginRow
              key={p.id}
              plugin={p}
              job={latestJob(jobs, p.id)}
              open={open.has(p.id)}
              onOpen={() => toggleOpen(p.id)}
              labelOf={labelOf}
              busy={busy}
              onToggle={() => void (p.enabled ? turnOff(p) : act(() => window.api.extensions.pluginSetEnabled(p.id, true)))}
              onUpdate={() => void act(() => window.api.extensions.pluginUpdate(p.id))}
              onRemove={() => void remove(p)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** One shared plugin, as ExtensionRow draws an item: its name, and marks for off, an update, a job under way and
 *  anything that needs a look; opened, its marketplace, version and last update, what went wrong, what it brings, what
 *  was installed with it, each account's own copy as on or off leaves it, and its actions. Update is offered when there
 *  is one, or to install missing files again. */
function ClaudePluginRow({
  plugin: p,
  job,
  open,
  onOpen,
  labelOf,
  busy,
  onToggle,
  onUpdate,
  onRemove
}: {
  plugin: ListedClaudePlugin
  /** The latest job for this plugin, if the Host still lists one. */
  job: ClaudePluginJob | undefined
  open: boolean
  onOpen: () => void
  labelOf: LabelOf
  busy: boolean
  onToggle: () => void
  onUpdate: () => void
  onRemove: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const state = rowState(p)
  const line = job === undefined ? null : jobLine(job, t)
  const live = job !== undefined && isLiveJob(job)
  /** Its latest job ended without doing its work: it failed, or stopped to ask about a command. */
  const stopped = job?.state === 'failed' || job?.state === 'needs-confirmation'
  return (
    <div className={`ext-row${open ? ' is-open' : ''}`}>
      <button type="button" className="ext-row-head" aria-expanded={open} onClick={onOpen}>
        <span className="ext-row-chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="plugin-name">{p.name}</span>
        {!p.enabled && <span className="plugin-status">{t('settings.extensions.off')}</span>}
        {state === 'update' && <span className="plugin-status is-starting">{updateLabel(p.version, p.update?.version ?? null, t)}</span>}
        {live && <span className="plugin-status is-starting">{line}</span>}
        {(state === 'missing' || stopped) && <span className="plugin-status is-failed">{t('settings.extensions.attention')}</span>}
      </button>
      {open && (
        <div className="ext-row-body">
          <span className="settings-hint">{t('settings.extensions.plugin.facts', { marketplace: p.marketplace, version: p.version, time: when(p.lastUpdated) })}</span>
          {state === 'missing' && <span className="settings-hint is-warning">{t('settings.extensions.plugin.missing')}</span>}
          {stopped && <span className="settings-hint is-warning">{line}</span>}
          {/* What it brings (§5.9), what was installed with it (§5.4), and each account's own copy (P4): one block each */}
          {[contentLines(p.contents, t), dependencyLines(p.dependencies, t), ownCopyLines(p, labelOf, t)].map(
            (lines, block) =>
              lines.length > 0 && (
                <div key={block} className="settings-hint">
                  {lines.map((l, i) => (
                    <div key={i}>{l}</div>
                  ))}
                </div>
              )
          )}
          <div className="remote-actions">
            <button className="settings-gen-refresh" disabled={busy} onClick={onToggle}>
              {p.enabled ? t('settings.extensions.disable') : t('settings.extensions.enable')}
            </button>
            {(state === 'missing' || state === 'update') && (
              <button className="settings-gen-refresh" disabled={busy || live} onClick={onUpdate}>
                {t('settings.extensions.plugin.update')}
              </button>
            )}
            <button className="ghost danger" disabled={busy || live} onClick={onRemove}>
              {t('settings.extensions.remove')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
